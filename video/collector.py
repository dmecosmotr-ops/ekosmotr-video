"""Explicit, bounded one-camera capture. No HTTP commands or automatic recording."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

APP_ROOT = Path(__file__).resolve().parents[1]
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z')
MAX_BYTES = 256 * 1024 * 1024


class CaptureError(Exception):
    """Only fixed codes may reach stderr; upstream exceptions are private."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _path(raw: object, *, private: bool = False, directory: bool = False) -> Path:
    if not isinstance(raw, (str, Path)) or not Path(raw).is_absolute():
        raise CaptureError('INVALID_CONFIG_PATH')
    path = Path(raw)
    # Check before resolve: silently following a symlink defeats a narrow mount.
    if (private or directory) and any(part.is_symlink() for part in [path, *path.parents]):
        raise CaptureError('INVALID_CONFIG_PATH')
    path = path.resolve()
    if private and 'private' not in {part.lower() for part in path.parts[:-1]}:
        raise CaptureError('INVALID_PRIVATE_PATH')
    if not (path.is_dir() if directory else path.is_file()):
        raise CaptureError('MISSING_DEPENDENCY')
    return path


def load_config(file: Path) -> dict:
    file = _path(file, private=True)
    if file.stat().st_size > 16384:
        raise CaptureError('INVALID_CONFIG')
    try:
        config = json.loads(file.read_text(encoding='utf-8-sig'))
    except (ValueError, UnicodeError):
        raise CaptureError('INVALID_CONFIG') from None
    required = {'archiveRoot', 'cameraId', 'stationId', 'mappingVersion', 'timezone',
                'pythonExecutable', 'ffprobe', 'ffmpeg', 'bridgeConfig'}
    optional = {'maxSeconds', 'startupTimeoutSeconds', 'stallTimeoutSeconds',
                'totalTimeoutSeconds', 'maxBytes', 'minFreeBytes', 'probeTimeoutSeconds',
                'decodeTimeoutSeconds'}
    if not isinstance(config, dict) or not required <= config.keys() or config.keys() - required - optional:
        raise CaptureError('INVALID_CONFIG')
    for key in ('cameraId', 'stationId', 'mappingVersion'):
        if not isinstance(config[key], str) or not ID.fullmatch(config[key]):
            raise CaptureError('INVALID_CONFIG')
    try:
        if not isinstance(config['timezone'], str) or len(config['timezone']) > 80:
            raise ValueError()
        ZoneInfo(config['timezone'])
    except (ValueError, ZoneInfoNotFoundError):
        raise CaptureError('INVALID_TIMEZONE') from None
    for key in ('pythonExecutable', 'ffprobe', 'ffmpeg'):
        config[key] = str(_path(config[key]))
    config['archiveRoot'] = str(_path(config['archiveRoot'], directory=True))
    config['bridgeConfig'] = str(_path(config['bridgeConfig'], private=True))
    bounds = {'maxSeconds': (300, 1, 600), 'startupTimeoutSeconds': (110, 1, 120),
              'stallTimeoutSeconds': (20, 1, 60), 'maxBytes': (MAX_BYTES, 1024, MAX_BYTES),
              'minFreeBytes': (512 * 1024 * 1024, 0, 10 * 1024**3),
              'probeTimeoutSeconds': (10, 1, 30), 'decodeTimeoutSeconds': (120, 1, 600)}
    for key, (default, minimum, maximum) in bounds.items():
        value = config.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
            raise CaptureError('INVALID_LIMIT')
        config[key] = value
    config.setdefault('totalTimeoutSeconds', config['maxSeconds'] + config['startupTimeoutSeconds'] + 10)
    total = config['totalTimeoutSeconds']
    if isinstance(total, bool) or not isinstance(total, int) or not 1 <= total <= 730:
        raise CaptureError('INVALID_LIMIT')
    bridge = Path(config['bridgeConfig'])
    if bridge.stat().st_size > 32768:
        raise CaptureError('INVALID_BRIDGE_DURATION')
    try:
        bridge_config = json.loads(bridge.read_text(encoding='utf-8-sig'))
        duration = bridge_config.get('maxSeconds', 600)
        if isinstance(duration, bool) or not isinstance(duration, int) or not 1 <= duration <= config['maxSeconds']:
            raise ValueError()
    except (ValueError, AttributeError, UnicodeError):
        raise CaptureError('INVALID_BRIDGE_DURATION') from None
    return config


def bridge_arguments(config: dict) -> list[str]:
    # The source program and argv shape are fixed in source, never supplied by a
    # browser, result manifest, camera metadata, or arbitrary command in JSON.
    return [config['pythonExecutable'], '-u', str(APP_ROOT / 'tools' / 'xiaomi_live_bridge.py'),
            '--config', config['bridgeConfig']]


def _start(argv: list[str]) -> subprocess.Popen:
    options = {'start_new_session': True} if os.name == 'posix' else {
        'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
    return subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, shell=False, **options)


def stop_tree(child: subprocess.Popen | None) -> None:
    """STOP first, then terminate the whole isolated group, even if leader exited.

    POSIX descendants inherit the session/process group. Windows taskkill /T is
    bounded best effort; detached/escaped processes require a Windows Job Object
    at a service supervisor and are outside the Linux deployment contract.
    """
    if child is None:
        return
    if child.poll() is None:
        try:
            child.stdin.write(b'STOP\n')
            child.stdin.flush()
        except (OSError, ValueError, AttributeError):
            pass
        try:
            child.wait(timeout=.3)
        except subprocess.TimeoutExpired:
            pass
    if os.name == 'posix':
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        # The group can outlive its leader. Never skip this because poll() is set.
        time.sleep(.05)
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        executable = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'taskkill.exe'
        try:
            subprocess.run([str(executable), '/PID', str(child.pid), '/T', '/F'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=2, creationflags=subprocess.CREATE_NO_WINDOW, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
        if child.poll() is None:
            child.kill()
    try:
        child.wait(timeout=1)
    except (OSError, subprocess.TimeoutExpired):
        pass
    for stream in (child.stdin, child.stdout):
        if stream is not None:
            try:
                stream.close()
            except (OSError, ValueError):
                pass


def _duration(file: Path, probe_prefix: list[str], config: dict, stop: threading.Event) -> float:
    child = None
    try:
        child = _start([*probe_prefix, '-v', 'error', '-protocol_whitelist', 'file',
            '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2',
            '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate',
            '-of', 'json', str(file)])
        deadline = time.monotonic() + config['probeTimeoutSeconds']
        while True:
            if stop.is_set():
                raise CaptureError('STOPPED')
            try:
                output, _ = child.communicate(timeout=.05)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() >= deadline:
                    raise CaptureError('PROBE_TIMEOUT') from None
        if child.returncode != 0 or len(output) > 65536:
            raise CaptureError('INVALID_VIDEO')
        value = json.loads(output)
        duration = float(value['format']['duration'])
        streams = [s for s in value['streams'] if s.get('codec_type') == 'video']
        if len(streams) != 1:
            raise CaptureError('INVALID_VIDEO')
        video = streams[0]
        fps = float(Fraction(video.get('avg_frame_rate', '0/1')))
        if not fps:
            fps = float(Fraction(video.get('r_frame_rate', '0/1')))
        if (not 0 < int(video.get('width', 0)) <= 3840
                or not 0 < int(video.get('height', 0)) <= 2160
                or not math.isfinite(fps) or not .5 <= fps <= 120
                or not math.isfinite(duration) or not 0 < duration <= config['maxSeconds'] + 1):
            raise CaptureError('INVALID_VIDEO')
        return duration
    except (ValueError, KeyError, TypeError, OverflowError, ZeroDivisionError):
        raise CaptureError('INVALID_VIDEO') from None
    finally:
        stop_tree(child)


def _decode_integrity(file: Path, decoder_prefix: list[str], config: dict, stop: threading.Event) -> None:
    """Decode the complete video to EOF; readable MP4 headers alone are insufficient.

    No output media or upstream diagnostics are retained. File-only demuxing,
    one decoder thread and the outer deadline bound this independent validation.
    """
    child = None
    try:
        if stop.is_set():
            raise CaptureError('STOPPED')
        child = _start([*decoder_prefix, '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-xerror', '-err_detect', 'explode', '-max_alloc', '67108864',
            '-protocol_whitelist', 'file', '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2',
            '-threads', '1', '-i', str(file), '-map', '0:v:0', '-an', '-sn', '-dn',
            '-threads', '1', '-filter_threads', '1', '-fps_mode', 'passthrough', '-f', 'null', '-'])
        deadline = time.monotonic() + config['decodeTimeoutSeconds']
        while True:
            if stop.is_set():
                raise CaptureError('STOPPED')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CaptureError('DECODE_TIMEOUT')
            try:
                code = child.wait(timeout=min(.05, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
        if code != 0:
            raise CaptureError('INVALID_VIDEO')
    finally:
        stop_tree(child)


def _free_space(root: Path, reserve: int, requested: int) -> None:
    if shutil.disk_usage(root)[2] < reserve + requested:
        raise CaptureError('DISK_LIMIT')


def _collect(config: dict, source_argv: list[str], probe_prefix: list[str], stop: threading.Event,
             *, decode_prefix: list[str] | None = None) -> dict:
    """Internal subprocess seam for synthetic tests; CLI always fixes source argv."""
    root = _path(config['archiveRoot'], directory=True)
    _free_space(root, config['minFreeBytes'], config['maxBytes'])
    run_id = uuid.uuid4().hex
    directory = root / run_id
    directory.mkdir(mode=0o700)
    part = directory / 'video.mp4.part'
    video = directory / 'video.mp4'
    manifest = directory / 'capture.json'
    manifest_part = directory / 'capture.json.part'
    child = None
    reader = None
    finished = threading.Event()
    messages = queue.Queue(maxsize=4)  # <= 256 KiB of queued source data.
    success = False
    receiving_started = utc_now()
    start = time.monotonic()
    first_at = None
    last_byte = start
    total = 0
    digest = hashlib.sha256()

    def read_source():
        try:
            while not finished.is_set():
                chunk = child.stdout.read1(65536)
                message = (chunk, utc_now(), time.monotonic())
                while not finished.is_set():
                    try:
                        messages.put(message, timeout=.05)
                        break
                    except queue.Full:
                        continue
                if not chunk:
                    return
        except (OSError, ValueError):
            # Parent remains bounded by the existing progress/wall deadlines.
            return

    try:
        if stop.is_set():
            raise CaptureError('STOPPED')
        child = _start(source_argv)
        reader = threading.Thread(target=read_source, daemon=True)
        reader.start()
        descriptor = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            while True:
                now = time.monotonic()
                if stop.is_set():
                    raise CaptureError('STOPPED')
                if now - start >= config['totalTimeoutSeconds']:
                    raise CaptureError('TOTAL_TIMEOUT')
                if first_at is None and now - start >= config['startupTimeoutSeconds']:
                    raise CaptureError('START_TIMEOUT')
                if first_at is not None and now - last_byte >= config['stallTimeoutSeconds']:
                    raise CaptureError('STALL_TIMEOUT')
                try:
                    chunk, at, received = messages.get(timeout=.025)
                except queue.Empty:
                    continue
                if not chunk:
                    break
                if total + len(chunk) > config['maxBytes']:
                    raise CaptureError('BYTE_LIMIT')
                _free_space(root, config['minFreeBytes'], len(chunk))
                if first_at is None:
                    first_at = at
                last_byte = received
                output.write(chunk)
                digest.update(chunk)
                total += len(chunk)
            output.flush()
            os.fsync(output.fileno())
        receiving_ended = utc_now()
        try:
            code = child.wait(timeout=min(1, max(.01, config['totalTimeoutSeconds'] - (time.monotonic() - start))))
        except subprocess.TimeoutExpired:
            raise CaptureError('SOURCE_FAILED') from None
        if code != 0:
            raise CaptureError('SOURCE_FAILED')
        if not total or first_at is None:
            raise CaptureError('EMPTY_CAPTURE')
        finished.set()
        stop_tree(child)
        child = None
        duration = _duration(part, probe_prefix, config, stop)
        _decode_integrity(part, decode_prefix if decode_prefix is not None else [config['ffmpeg']], config, stop)
        if stop.is_set():
            raise CaptureError('STOPPED')
        capture = {'schemaVersion': 1, 'runId': run_id,
            **{key: config[key] for key in ('cameraId', 'stationId', 'mappingVersion', 'timezone')},
            'status': 'complete', 'coverage': {'status': 'partial'},
            'receivingStartedAt': receiving_started, 'receivingEndedAt': receiving_ended,
            'timingSource': 'bridge-genpts-20fps',
            'recording': {'id': run_id, 'file': f'{run_id}/video.mp4', 'sha256': digest.hexdigest(),
                'startedAt': first_at, 'durationSeconds': duration, 'timing': 'estimated'}}
        descriptor = os.open(manifest_part, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as output:
            json.dump(capture, output, ensure_ascii=False, separators=(',', ':'))
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(part, video)
        if stop.is_set():
            raise CaptureError('STOPPED')
        # This final atomic rename is the sole registration point. A crash before
        # it can leave an unregistered video, never a successful partial manifest.
        os.replace(manifest_part, manifest)
        success = True
        return capture
    finally:
        finished.set()
        stop_tree(child)
        if reader is not None:
            reader.join(timeout=.5)
        if not success:
            for file in (part, video, manifest_part):
                file.unlink(missing_ok=True)
            try:
                directory.rmdir()
            except OSError:
                pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args(argv)
    os.umask(0o077)
    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())

    def commands():
        try:
            # EOF from `docker compose run -T` is normal. Only explicit STOP
            # cancels; unlike the browser bridge, this process owns its lifetime.
            if sys.stdin.buffer.readline(16).strip() == b'STOP':
                stop.set()
        except (OSError, ValueError):
            pass

    threading.Thread(target=commands, daemon=True).start()
    try:
        config = load_config(args.config)
        capture = _collect(config, bridge_arguments(config), [config['ffprobe']], stop)
        print(json.dumps({'status': 'complete', 'runId': capture['runId']}))
        return 0
    except CaptureError as failure:
        print(str(failure), file=sys.stderr)
        return 2
    except (Exception, KeyboardInterrupt):
        print('CAPTURE_FAILED', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
