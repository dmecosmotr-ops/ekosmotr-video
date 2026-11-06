"""Diagnostic one-camera relay -> H.264 fragmented MP4 bridge. Stdout is video only.

Uses the already-authorized local Xiaomi session and fixed private configuration.
The external transport remains a diagnostic dependency, not production software.
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time


class BridgeError(Exception):
    pass


def private_path(value: str | Path) -> Path:
    path = Path(value).resolve()
    if 'private' not in {part.lower() for part in path.parts[:-1]}:
        raise BridgeError('INVALID_PRIVATE_PATH')
    return path


def load_config(path: Path) -> dict:
    path = private_path(path)
    if not path.is_file() or path.stat().st_size > 32768:
        raise BridgeError('INVALID_CONFIG')
    config = json.loads(path.read_text(encoding='utf-8-sig'))
    if not isinstance(config, dict):
        raise BridgeError('INVALID_CONFIG')
    for key in ('accountId', 'deviceId'):
        if not isinstance(config.get(key), str) or not re.fullmatch(r'[0-9]{1,64}', config[key]):
            raise BridgeError('INVALID_CONFIG')
    if 'sharedHome' in config:
        home = config['sharedHome']
        if (not isinstance(home, dict) or set(home) != {'homeId', 'homeOwnerId'}
                or any(not isinstance(value, str) or not re.fullmatch(r'[0-9]{1,64}', value)
                       for value in home.values())):
            raise BridgeError('INVALID_SHARED_HOME')
    if config.get('region') not in ('ru', 'de', 'i2', 'sg', 'us', 'cn'):
        raise BridgeError('INVALID_CONFIG')
    if not isinstance(config.get('model'), str) or not re.fullmatch(r'[a-z0-9_.-]{1,100}', config['model']):
        raise BridgeError('INVALID_CONFIG')
    for key in ('go2rtcConfig', 'java', 'ffmpeg', 'cloudTools', 'pythonDeps', 'privateRoot'):
        raw = config.get(key)
        if not isinstance(raw, str) or not Path(raw).is_absolute():
            raise BridgeError('INVALID_CONFIG_PATH')
        resolved = Path(raw).resolve()
        if not resolved.exists():
            raise BridgeError('MISSING_DEPENDENCY')
        config[key] = str(resolved)
    if not Path(config['java']).is_file() or not Path(config['ffmpeg']).is_file():
        raise BridgeError('INVALID_EXECUTABLE')
    classpath = config.get('javaClasses')
    if not isinstance(classpath, str) or not classpath:
        raise BridgeError('INVALID_DEPENDENCY')
    class_dirs = classpath.split(os.pathsep)
    if not all(Path(p).is_absolute() and Path(p).is_dir() for p in class_dirs):
        raise BridgeError('INVALID_DEPENDENCY')
    if not Path(config['cloudTools']).is_dir():
        raise BridgeError('INVALID_DEPENDENCY')
    private_path(config['go2rtcConfig'])
    root = Path(config['privateRoot'])
    if root.name.lower() != 'private' and 'private' not in {p.lower() for p in root.parts}:
        raise BridgeError('INVALID_PRIVATE_ROOT')
    if not root.is_dir():
        raise BridgeError('INVALID_PRIVATE_ROOT')
    limit = config.get('maxSeconds', 600)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 600:
        raise BridgeError('INVALID_DURATION')
    config['maxSeconds'] = limit
    return config


def clean_property(value: object) -> str:
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        raise BridgeError('INVALID_PROVISIONING')
    value = str(value)
    if not value or len(value) > 8192 or not value.isascii() or any(c in value for c in '\r\n\x00\\'):
        raise BridgeError('INVALID_PROVISIONING')
    return value


def provision_properties(result: dict, client_public: str, client_private: str) -> dict[str, str]:
    vendor = result.get('vendor')
    if not isinstance(vendor, dict) or vendor.get('vendor') != 4:
        raise BridgeError('UNSUPPORTED_TRANSPORT')
    params = vendor.get('vendor_params')
    if not isinstance(params, dict):
        raise BridgeError('INVALID_PROVISIONING')
    values = {'vendor': '4', 'clientPublic': client_public, 'clientPrivate': client_private,
              'devicePublic': result.get('public_key'), 'sign': result.get('sign'),
              'p2pId': params.get('p2p_id') or params.get('p2pId')}
    init_string = params.get('init_string')
    if init_string:
        values['initString'] = init_string
    else:
        servers = params.get('servers')
        if not isinstance(servers, list) or not 1 <= len(servers) <= 32:
            raise BridgeError('INVALID_PROVISIONING')
        values['servers'] = ','.join(clean_property(s) for s in servers)
    values = {key: clean_property(value) for key, value in values.items()}
    for key in ('clientPublic', 'clientPrivate', 'devicePublic'):
        if not re.fullmatch(r'[0-9a-fA-F]{64}', values[key]):
            raise BridgeError('INVALID_PROVISIONING')
    if not re.fullmatch(r'(?:[0-9a-fA-F]{2}){1,2048}', values['sign']):
        raise BridgeError('INVALID_PROVISIONING')
    return values


def find_cloud_device(cloud, helper, config: dict) -> dict | None:
    device_id = config['deviceId']

    def match(items):
        return next((item for item in items if isinstance(item, dict)
                     and str(item.get('did')) == device_id), None)

    home = config.get('sharedHome')
    if home is None:
        return match(cloud.request('/v2/home/device_list_page', {}, 'device').get('list', []))

    inventory = importlib.import_module('xiaomi_shared_inventory')
    try:
        device = match(inventory.fetch_devices_by_id(cloud, [device_id]))
    except helper.ProbeError:
        device = None
    if device is not None:
        return device
    return match(inventory.fetch_home_devices(cloud, home['homeId'], home['homeOwnerId']))


def fresh_provision(config: dict) -> dict[str, str]:
    # These paths are fixed server-side. Nothing received from a viewer selects code.
    sys.path.insert(0, config['pythonDeps'])
    sys.path.insert(0, config['cloudTools'])
    helper = importlib.import_module('xiaomi_cloud_probe')
    from nacl.public import PrivateKey
    http = helper.BoundedHTTP(45 if config.get('sharedHome') else 30)
    cloud = helper.XiaomiCloud(http, config['region'])
    token = helper.load_token(Path(config['go2rtcConfig']), config['accountId'])
    cloud.login_with_token(config['accountId'], token)
    del token
    device = find_cloud_device(cloud, helper, config)
    if device is None or device.get('model') != config['model']:
        raise BridgeError('CAMERA_NOT_FOUND')
    online = next((device[key] for key in ('isOnline', 'is_online', 'online')
                   if isinstance(device.get(key), bool)), None)
    if online is False:
        raise BridgeError('CAMERA_OFFLINE')
    private_key = PrivateKey.generate()
    public_key = bytes(private_key.public_key).hex()
    result = cloud.request('/v2/device/miss_get_vendor', {
        'app_pubkey': public_key, 'did': config['deviceId'], 'support_vendors': 'TUTK_CS2_MTP'
    }, 'provisioning')
    return provision_properties(result, public_key, bytes(private_key).hex())


def ffmpeg_arguments(executable: str) -> list[str]:
    return [executable, '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-fflags', '+genpts', '-analyzeduration', '1000000', '-probesize', '32768',
            '-f', 'hevc', '-r', '20', '-i', 'pipe:0', '-an',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p', '-g', '20', '-keyint_min', '20', '-sc_threshold', '0',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-frag_duration', '1000000', '-flush_packets', '1', '-f', 'mp4', 'pipe:1']


def stop_process(child: subprocess.Popen | None, graceful: bool = False) -> None:
    if child is None:
        return
    try:
        if child.poll() is not None:
            return
        if graceful:
            try:
                child.stdin.write(b'STOP\n')
                child.stdin.flush()
                child.wait(timeout=1.5)
                return
            except (OSError, ValueError, AttributeError, subprocess.TimeoutExpired):
                pass
        try:
            child.terminate()
            child.wait(timeout=.5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                child.kill()
                child.wait(timeout=.5)
            except (OSError, subprocess.TimeoutExpired):
                pass
    finally:
        if child.stdin is not None:
            try:
                child.stdin.close()
            except (OSError, ValueError):
                pass


class PipelineCleanup:
    """One cleanup owner; concurrent stop/finally callers wait for that owner."""
    def __init__(self):
        self.java = None
        self.ffmpeg = None
        self._lock = threading.Lock()
        self._started = False
        self.done = threading.Event()

    def __call__(self):
        with self._lock:
            owner = not self._started
            self._started = True
        if not owner:
            self.done.wait(4)
            return
        try:
            # Break both the reader and the encoder first. A stalled transport
            # cannot consume the whole parent-server shutdown grace period.
            stop_process(self.ffmpeg)
            stop_process(self.java, graceful=True)
        finally:
            for child in (self.java, self.ffmpeg):
                if child is not None and child.stdout is not None:
                    try:
                        child.stdout.close()
                    except (OSError, ValueError):
                        pass
            self.done.set()


def run(config: dict, stop: threading.Event) -> int:
    properties = fresh_provision(config)
    if stop.is_set():
        return 0
    cleanup = PipelineCleanup()
    # Temporary provisioning is deleted at the end of every attempt, never reused.
    with tempfile.TemporaryDirectory(prefix='live-session-', dir=config['privateRoot']) as directory:
        provision = Path(directory) / 'provision.properties'
        fd = os.open(provision, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w', encoding='ascii', newline='\n') as output:
            output.write(''.join(f'{key}={value}\n' for key, value in properties.items()))
        properties.clear()
        try:
            java = subprocess.Popen([config['java'], '-Xmx256m', '-cp', config['javaClasses'],
                'RelayLive', str(provision), '1', str(config['maxSeconds'])],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                shell=False, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            cleanup.java = java
            ffmpeg = subprocess.Popen(ffmpeg_arguments(config['ffmpeg']), stdin=java.stdout,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, shell=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            cleanup.ffmpeg = ffmpeg
            java.stdout.close()
            deadline = time.monotonic() + config['maxSeconds'] + 55

            def watchdog():
                while not stop.wait(.1):
                    if time.monotonic() >= deadline or ffmpeg.poll() is not None:
                        stop.set()
                cleanup()

            watcher = threading.Thread(target=watchdog, daemon=True)
            watcher.start()
            while not stop.is_set():
                chunk = ffmpeg.stdout.read1(65536)
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            return 0 if stop.is_set() else 0 if ffmpeg.wait(timeout=1) == 0 else 6
        finally:
            stop.set()
            cleanup()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args(argv)
    stop = threading.Event()

    def parent_commands():
        try:
            # EOF means the controlling HTTP server exited, even without STOP.
            sys.stdin.buffer.readline(16)
        finally:
            stop.set()

    threading.Thread(target=parent_commands, daemon=True).start()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    try:
        return run(load_config(args.config), stop)
    except (BrokenPipeError, KeyboardInterrupt):
        return 0
    except Exception:
        # Do not print exception strings, subprocess output, config, keys or URLs.
        sys.stderr.write('LIVE_BRIDGE_FAILED\n')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
