"""One-camera Xiaomi provisioning probe; no video connection and no password login.

The owner has already signed into local go2rtc. This tool renews that session in
memory using the same official Xiaomi flow and stops if another login is needed.
Only sanitized milestones are printed. Provisioning secrets require an explicit
output path inside a directory named ``private`` and are never sent to stdout.

Protocol adapted from go2rtc v1.9.15 pkg/xiaomi/cloud.go and
internal/xiaomi/xiaomi.go: https://github.com/AlexxIT/go2rtc/tree/v1.9.15

MIT License
Copyright (c) 2022 Alexey Khit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.cookies
import json
import os
from pathlib import Path
import re
import socket
import struct
import sys
import time
from typing import Any
import urllib.error
import urllib.parse
import urllib.request


LOCAL_API = "http://127.0.0.1:1984/api/xiaomi"
MAX_RESPONSE = 4 * 1024 * 1024
SAFE_FIELDS = {"model", "vendor", "vendor_name", "online", "has_init_string",
               "server_entries", "camera_index", "api_code"}
VENDORS = {1: "tutk", 3: "agora", 4: "cs2", 6: "mtp"}


class ProbeError(Exception):
    """An allowlisted error code, never an upstream body or URL."""

    def __init__(self, stage: str, status: str, api_code: int | None = None):
        self.stage, self.status, self.api_code = stage, status, api_code
        super().__init__(status)


def emit(stage: str, status: str, **fields: Any) -> None:
    message = {"stage": stage, "status": status}
    message.update({key: value for key, value in fields.items() if key in SAFE_FIELDS})
    print(json.dumps(message, ensure_ascii=True, separators=(",", ":")), flush=True)


def rc4_drop1024(key: bytes, data: bytes) -> bytes:
    """RC4 is required by this existing Xiaomi protocol, not a new cipher choice."""
    if not key:
        raise ValueError("empty key")
    state = list(range(256))
    j = 0
    for i in range(256):
        j = (j + state[i] + key[i % len(key)]) & 255
        state[i], state[j] = state[j], state[i]
    i = j = 0
    out = bytearray(len(data))
    for offset in range(1024 + len(data)):
        i = (i + 1) & 255
        j = (j + state[i]) & 255
        state[i], state[j] = state[j], state[i]
        value = state[(state[i] + state[j]) & 255]
        if offset >= 1024:
            out[offset - 1024] = data[offset - 1024] ^ value
    return bytes(out)


def signature64(path: str, form: dict[str, str], signed_nonce: bytes) -> str:
    value = "POST&" + path + "&data=" + form["data"]
    if "rc4_hash__" in form:
        value += "&rc4_hash__=" + form["rc4_hash__"]
    value += "&" + base64.b64encode(signed_nonce).decode("ascii")
    return base64.b64encode(hashlib.sha1(value.encode("utf-8")).digest()).decode("ascii")


def encrypted_form(path: str, params: dict[str, Any], ssecurity: bytes,
                   nonce: bytes) -> tuple[bytes, bytes]:
    signed_nonce = hashlib.sha256(ssecurity + nonce).digest()
    plain = {"data": json.dumps(params, separators=(",", ":"), ensure_ascii=False)}
    plain["rc4_hash__"] = signature64(path, plain, signed_nonce)
    form = {key: base64.b64encode(rc4_drop1024(signed_nonce, value.encode("utf-8"))).decode("ascii")
            for key, value in plain.items()}
    form["signature"] = signature64(path, form, signed_nonce)
    form["_nonce"] = base64.b64encode(nonce).decode("ascii")
    return urllib.parse.urlencode(form).encode("ascii"), signed_nonce


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BoundedHTTP:
    def __init__(self, timeout: float = 30):
        self.deadline = time.monotonic() + timeout
        # Explicitly avoid ambient HTTP proxy settings for credentials and local API.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, url: str, *, stage: str, data: bytes | None = None,
                headers: dict[str, str] | None = None) -> tuple[int, Any, bytes]:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeError(stage, "timed_out")
        request = urllib.request.Request(url, data=data, headers=headers or {})
        try:
            try:
                response = self.opener.open(request, timeout=min(15, remaining))
            except urllib.error.HTTPError as error:
                # Redirect bodies and errors stay local; never print their contents.
                response = error
            with response:
                body = response.read(MAX_RESPONSE + 1)
                if len(body) > MAX_RESPONSE:
                    raise ProbeError(stage, "response_too_large")
                return response.code, response.headers, body
        except (TimeoutError, socket.timeout):
            raise ProbeError(stage, "timed_out") from None
        except (urllib.error.URLError, OSError):
            raise ProbeError(stage, "network_error") from None


def parse_json(body: bytes, stage: str, *, login: bool = False) -> Any:
    try:
        if login:
            if not body.startswith(b"&&&START&&&"):
                raise ProbeError(stage, "auth_required")
            body = body[len(b"&&&START&&&"):]
        return json.loads(body)
    except (ValueError, UnicodeError):
        raise ProbeError(stage, "invalid_response") from None


def official_auth_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname or ""
        return (parsed.scheme == "https" and parsed.username is None
                and parsed.password is None and parsed.port in (None, 443)
                and (host in ("xiaomi.com", "mi.com")
                     or host.endswith(".xiaomi.com") or host.endswith(".mi.com")))
    except ValueError:
        return False


class XiaomiCloud:
    def __init__(self, http: BoundedHTTP, region: str):
        self.http, self.region = http, region
        self.cookies = ""
        self.ssecurity = b""

    def login_with_token(self, user_id: str, pass_token: str) -> None:
        if not re.fullmatch(r"\d+", user_id) or any(c in pass_token for c in "\r\n;"):
            raise ProbeError("session", "invalid_config")
        status, _, body = self.http.request(
            "https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=xiaomiio",
            stage="session", headers={"Cookie": f"userId={user_id}; passToken={pass_token}"})
        if status != 200:
            raise ProbeError("session", "auth_required")
        result = parse_json(body, "session", login=True)
        if (not isinstance(result, dict) or result.get("notificationUrl")
                or result.get("captchaURL") or not result.get("location")
                or not result.get("ssecurity")):
            raise ProbeError("session", "auth_required")
        try:
            self.ssecurity = base64.b64decode(result["ssecurity"], validate=True)
        except (ValueError, TypeError):
            raise ProbeError("session", "invalid_response") from None
        if not self.ssecurity:
            raise ProbeError("session", "auth_required")
        location = result["location"]
        cookies = {"userId": user_id}
        for _ in range(10):
            if not isinstance(location, str) or not official_auth_url(location):
                raise ProbeError("session", "invalid_auth_destination")
            status, headers, _ = self.http.request(location, stage="session")
            for value in headers.get_all("Set-Cookie", []):
                parsed = http.cookies.SimpleCookie()
                try:
                    parsed.load(value)
                except http.cookies.CookieError:
                    continue
                for key in ("userId", "cUserId", "serviceToken"):
                    if key in parsed:
                        cookies[key] = parsed[key].value
            extra = headers.get("Extension-Pragma")
            if extra:
                try:
                    extended = json.loads(extra)
                    if extended.get("ssecurity"):
                        self.ssecurity = base64.b64decode(extended["ssecurity"], validate=True)
                except (ValueError, TypeError, AttributeError):
                    raise ProbeError("session", "invalid_response") from None
            if status in (301, 302, 303, 307, 308):
                location = urllib.parse.urljoin(location, headers.get("Location", ""))
                continue
            if status != 200 or not cookies.get("serviceToken"):
                raise ProbeError("session", "auth_required")
            self.cookies = "; ".join(f"{key}={cookies.get(key, '')}"
                                     for key in ("userId", "cUserId", "serviceToken"))
            return
        raise ProbeError("session", "too_many_redirects")

    def request(self, path: str, params: dict[str, Any], stage: str) -> dict[str, Any]:
        nonce = os.urandom(8) + struct.pack(">I", int(time.time() // 60))
        form, key = encrypted_form(path, params, self.ssecurity, nonce)
        host = self.region + ".api.io.mi.com" if self.region != "cn" else "api.io.mi.com"
        status, _, body = self.http.request("https://" + host + "/app" + path,
            stage=stage, data=form,
            headers={"Cookie": self.cookies, "Content-Type": "application/x-www-form-urlencoded"})
        if status != 200:
            raise ProbeError(stage, "cloud_http_error")
        try:
            plaintext = rc4_drop1024(key, base64.b64decode(body, validate=True))
            result = parse_json(plaintext, stage)
        except (ValueError, TypeError):
            raise ProbeError(stage, "invalid_response") from None
        if not isinstance(result, dict):
            raise ProbeError(stage, "invalid_response")
        if result.get("code") != 0:
            code = result.get("code")
            raise ProbeError(stage, "cloud_api_error", code if isinstance(code, int) else None)
        payload = result.get("result")
        if not isinstance(payload, dict):
            raise ProbeError(stage, "invalid_response")
        return payload


def select_camera(http: BoundedHTTP, index: int, region: str) -> tuple[str, str, str]:
    status, _, body = http.request(LOCAL_API, stage="local_api")
    accounts = parse_json(body, "local_api")
    if status != 200 or not isinstance(accounts, list) or len(accounts) != 1:
        raise ProbeError("local_api", "account_selection_needed")
    user_id = str(accounts[0])
    query = urllib.parse.urlencode({"id": user_id, "region": region})
    status, _, body = http.request(LOCAL_API + "?" + query, stage="local_api")
    inventory = parse_json(body, "local_api")
    if status != 200 or not isinstance(inventory, dict):
        raise ProbeError("local_api", "invalid_response")
    sources = inventory.get("sources", [])
    if not isinstance(sources, list) or index < 0 or index >= len(sources):
        raise ProbeError("local_api", "camera_index_out_of_range")
    try:
        uri = urllib.parse.urlsplit(sources[index]["url"])
        params = urllib.parse.parse_qs(uri.query)
        device_id, model = params["did"][0], params["model"][0]
        if (uri.scheme != "xiaomi" or uri.username != user_id
                or uri.password != region or not device_id
                or not re.fullmatch(r"[a-z0-9_.-]{1,100}", model)):
            raise ValueError()
    except (KeyError, IndexError, TypeError, ValueError):
        raise ProbeError("local_api", "invalid_camera_metadata") from None
    return user_id, device_id, model


def load_token(config: Path, user_id: str) -> str:
    try:
        import yaml
        content = yaml.safe_load(config.read_text(encoding="utf-8-sig"))
        entries = content["xiaomi"]
        token = {str(key): value for key, value in entries.items()}[user_id]
        if not isinstance(token, str) or not token:
            raise ValueError()
        return token
    except ImportError:
        raise ProbeError("config", "missing_yaml_dependency") from None
    except Exception:
        raise ProbeError("config", "invalid_config") from None


def write_private_output(path: Path, data: dict[str, Any]) -> None:
    path = path.resolve()
    if "private" not in {part.lower() for part in path.parts[:-1]}:
        raise ProbeError("output", "private_output_required")
    path.parent.mkdir(parents=True, exist_ok=True)
    # Refuse to overwrite prior evidence; keep credentials out of Git by construction.
    ignore = path.parent / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="ascii")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=True, indent=2)
            output.write("\n")
    except FileExistsError:
        raise ProbeError("output", "output_already_exists") from None


def run(args: argparse.Namespace) -> None:
    if not 1 <= args.timeout <= 30:
        raise ProbeError("arguments", "timeout_must_be_1_to_30")
    if "private" not in {part.lower() for part in args.output.resolve().parts[:-1]}:
        raise ProbeError("output", "private_output_required")
    if args.output.exists():
        raise ProbeError("output", "output_already_exists")
    try:
        from nacl.public import PrivateKey
    except ImportError:
        raise ProbeError("dependencies", "missing_nacl_dependency") from None
    http = BoundedHTTP(args.timeout)
    user_id, device_id, model = select_camera(http, args.camera_index, args.region)
    token = load_token(args.config, user_id)
    cloud = XiaomiCloud(http, args.region)
    cloud.login_with_token(user_id, token)
    del token
    emit("session", "ready")
    devices = cloud.request("/v2/home/device_list_page", {}, "device")
    candidates = devices.get("list", [])
    device = next((item for item in candidates if isinstance(item, dict)
                   and str(item.get("did")) == device_id), None)
    if device is None or device.get("model") != model:
        raise ProbeError("device", "selected_camera_not_found")
    online = device.get("isOnline")
    if not isinstance(online, bool):
        online = None
    emit("device", "selected", model=model, online=online, camera_index=args.camera_index)
    if online is False:
        raise ProbeError("device", "camera_offline")
    client_private = PrivateKey.generate()
    client_public = bytes(client_private.public_key).hex()
    result = cloud.request("/v2/device/miss_get_vendor", {
        "app_pubkey": client_public, "did": device_id, "support_vendors": "TUTK_CS2_MTP"
    }, "provisioning")
    vendor = result.get("vendor", {})
    if not isinstance(vendor, dict) or not isinstance(vendor.get("vendor"), int):
        raise ProbeError("provisioning", "invalid_vendor_response")
    vendor_id = vendor["vendor"]
    params = vendor.get("vendor_params", {})
    if not isinstance(params, dict):
        raise ProbeError("provisioning", "invalid_vendor_response")
    output = {
        "schema": "xiaomi-provisioning-v1", "created_at_unix": int(time.time()),
        "camera_index": args.camera_index, "model": model, "region": args.region,
        "online": online, "device_id": device_id, "client_public": client_public,
        "client_private": bytes(client_private).hex(), "vendor": vendor_id,
        "vendor_name": VENDORS.get(vendor_id, "unknown"), "vendor_params": params,
        "device_public": result.get("public_key"), "sign": result.get("sign"),
        "miss_version": result.get("miss_version")}
    write_private_output(args.output, output)
    emit("provisioning", "ready", model=model, vendor=vendor_id,
         vendor_name=VENDORS.get(vendor_id, "unknown"),
         has_init_string=bool(params.get("init_string")),
         server_entries=len(params.get("servers", [])) if isinstance(params.get("servers"), list) else 0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--camera-index", type=int, default=0)
    parser.add_argument("--region", choices=("ru", "de", "i2", "sg", "us", "cn"), default="ru")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args(argv)
    try:
        run(args)
        return 0
    except ProbeError as error:
        fields = {} if error.api_code is None else {"api_code": error.api_code}
        emit(error.stage, error.status, **fields)
        return 2
    except KeyboardInterrupt:
        emit("probe", "interrupted")
        return 130
    except Exception:
        # Upstream exception strings can include tokens, DID, signatures and URLs.
        emit("probe", "unexpected_error")
        return 3


if __name__ == "__main__":
    sys.exit(main())
