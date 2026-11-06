"""Synchronize a private Xiaomi camera catalog from an already authorized account."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import threading
import time
import uuid

from xiaomi_cabinet_bundle import APP_ROOT, CAMERA_ID, build_bundle, read_private_json, valid_id, write_json
from xiaomi_cloud_probe import BoundedHTTP, ProbeError, XiaomiCloud, load_token
from xiaomi_live_bridge import BridgeError, load_config, private_path
from xiaomi_shared_inventory import discover_cameras, make_snapshot, write_snapshot


GENERATION_NAME = re.compile(r'gen-[0-9a-f]{32}')
STAGING_NAME = re.compile(r'\.gen-[0-9a-f]{32}-bundle-[a-z0-9_]{8}')
GENERATION_GRACE_SECONDS = 900
GENERATION_LIMIT = 32
FINGERPRINT = 'sync-fingerprint.json'
RETIREMENT = '.retired'
STATIONS_FILE = APP_ROOT / 'data/stations.json'


class SyncBusy(Exception):
    pass


@dataclass(frozen=True)
class SyncSettings:
    go2rtc_config: Path
    bridge_template: Path
    output_dir: Path
    station_map: Path | None
    interval_seconds: int


def read_settings(path: Path) -> SyncSettings:
    path = private_path(path)
    raw = read_private_json(path)
    required = {'go2rtcConfig', 'bridgeTemplate', 'outputDir'}
    if not isinstance(raw, dict) or not required <= raw.keys() <= required | {'stationMap', 'intervalSeconds'}:
        raise ValueError('Invalid sync config')

    def path_for(key):
        value = raw[key]
        if not isinstance(value, str) or not value.strip():
            raise ValueError('Invalid sync path')
        return private_path(path.parent / value)

    interval = raw.get('intervalSeconds', 300)
    if type(interval) is not int or not 60 <= interval <= 3600:
        raise ValueError('Invalid sync interval')
    output = path_for('outputDir')
    if output == path.parent:
        raise ValueError('Use a dedicated output directory')
    return SyncSettings(path_for('go2rtcConfig'), path_for('bridgeTemplate'), output,
                        path_for('stationMap') if 'stationMap' in raw else None, interval)


@contextmanager
def writer_lock(output_dir: Path):
    """Serialize periodic and manual writers, including across process crashes."""
    path = output_dir / '.sync.lock'
    if path.is_symlink():
        raise ValueError('Invalid sync lock')
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise SyncBusy() from error
        yield
    finally:
        os.close(descriptor)


def current_generation(output_dir: Path) -> Path | None:
    try:
        pointer = output_dir / 'current.json'
        if pointer.is_symlink() or pointer.stat().st_size > 256:
            return None
        value = json.loads(pointer.read_text(encoding='utf-8'))
        if (not isinstance(value, dict) or set(value) != {'version', 'generation'}
                or type(value['version']) is not int or value['version'] != 1
                or not valid_id(GENERATION_NAME, value['generation'])):
            return None
        generation = output_dir / value['generation']
        if generation.is_dir() and not generation.is_symlink() and generation.resolve().parent == output_dir:
            return generation
    except (OSError, ValueError, RuntimeError):
        pass
    return None


def bundle_checksums(generation: Path) -> dict[str, str]:
    configs = list(generation.glob('bridge-*.json'))
    if len(configs) > 150:
        raise ValueError('Invalid bridge count')
    files = [(generation / 'camera-inventory.json', 1024 * 1024),
             (generation / 'live-config.json', 512 * 1024), *((path, 32_768) for path in configs)]
    checksums = {}
    for path, limit in files:
        if not path.is_file() or path.is_symlink() or path.stat().st_size > limit:
            raise ValueError('Invalid bundle file')
        checksums[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return checksums


def fingerprint(snapshot: dict, bridge: dict, station_map: dict) -> str:
    # A heartbeat from a camera cannot change its generated route or station access.
    content = {'cameras': sorted(snapshot['cameras'], key=lambda row: row['id']),
               'routes': sorted(({key: value for key, value in route.items() if key != 'online'}
                                 for route in snapshot['routes']), key=lambda row: row['cameraId']),
               'template': bridge, 'stationMap': station_map, 'format': 1,
               'python': sys.executable, 'tools': str(Path(__file__).resolve().parent)}
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def verified_fingerprint(generation: Path | None) -> str | None:
    if generation is None or (generation / FINGERPRINT).is_symlink():
        return None
    try:
        metadata = read_private_json(generation / FINGERPRINT)
        if (isinstance(metadata, dict) and isinstance(metadata.get('sha256'), str)
                and metadata.get('files') == bundle_checksums(generation)):
            return metadata['sha256']
    except (OSError, ValueError, BridgeError):
        pass
    return None


def prune_generations(output_dir: Path, current: Path | None) -> int:
    generations = []
    for path in output_dir.iterdir():
        is_generation = GENERATION_NAME.fullmatch(path.name)
        is_staging = STAGING_NAME.fullmatch(path.name)
        if not (is_generation or is_staging) or path.is_symlink() or not path.is_dir() or path.resolve().parent != output_dir:
            continue
        if is_staging:
            # The lock excludes a concurrent writer. A cabinet can only reference a generation.
            shutil.rmtree(path, ignore_errors=True)
            continue
        retired = path / RETIREMENT
        retirement_time = retired.stat().st_mtime if retired.is_file() and not retired.is_symlink() else None
        generations.append((path, retirement_time))
    retired_generations = sorted(((retired, path) for path, retired in generations
                                  if path != current and retired is not None), reverse=True)
    previous = next((path for _, path in retired_generations if verified_fingerprint(path)), None)
    if current is None:
        # A damaged pointer may leave the running cabinet on the last intact, unretired generation.
        unretired = sorted((path for path, retired in generations if retired is None),
                           key=lambda path: path.stat().st_mtime, reverse=True)
        current = next((path for path in unretired if verified_fingerprint(path)), None)
    cutoff = time.time() - GENERATION_GRACE_SECONDS
    removed = 0
    for path, retired in generations:
        if path in (current, previous) or (retired or path.stat().st_mtime) >= cutoff:
            continue
        try:
            shutil.rmtree(path)
        except OSError:
            continue
        removed += 1
    return len(generations) - removed


def sync_once(config: Path | SyncSettings) -> dict:
    settings = config if isinstance(config, SyncSettings) else read_settings(config)
    settings.output_dir.mkdir(mode=0o700, exist_ok=True)
    with writer_lock(settings.output_dir):
        bridge = load_config(settings.bridge_template)
        if Path(bridge['go2rtcConfig']) != settings.go2rtc_config:
            raise ValueError('Sync and bridge must use the same Xiaomi session')
        if bridge['pythonDeps'] not in sys.path:
            sys.path.append(bridge['pythonDeps'])
        station_map = read_private_json(settings.station_map) if settings.station_map else {}
        if not isinstance(station_map, dict) or not all(valid_id(CAMERA_ID, key) and valid_id(CAMERA_ID, value)
                                                       for key, value in station_map.items()):
            raise ValueError('Invalid station map')

        cloud = XiaomiCloud(BoundedHTTP(90), bridge['region'])
        account = bridge['accountId']
        cloud.login_with_token(account, load_token(settings.go2rtc_config, account))
        snapshot = make_snapshot(discover_cameras(cloud))
        station_map = {camera['id']: station_map[camera['id']] for camera in snapshot['cameras']
                       if camera['id'] in station_map}
        if station_map:
            source = json.loads(STATIONS_FILE.read_text(encoding='utf-8-sig'))
            stations = source if isinstance(source, list) else source['stations']
            if not set(station_map.values()) <= {station['id'] for station in stations}:
                raise ValueError('Unknown station in active camera mapping')
        signature = fingerprint(snapshot, bridge, station_map)
        current = current_generation(settings.output_dir)
        generation_count = prune_generations(settings.output_dir, current)
        counts = {'cameraCount': len(snapshot['cameras']), 'routeCount': len(snapshot['routes'])}
        if verified_fingerprint(current) == signature:
            return {'status': 'unchanged', **counts}
        if generation_count >= GENERATION_LIMIT:
            raise ValueError('Sync generation limit reached')

        generation = settings.output_dir / f'gen-{uuid.uuid4().hex}'
        build_bundle(snapshot, bridge, generation, station_map=station_map, allow_empty=True)
        try:
            write_json(generation / FINGERPRINT, {'sha256': signature, 'files': bundle_checksums(generation)})
            if current is not None:
                retirement = current / RETIREMENT
                if retirement.is_symlink():
                    raise ValueError('Invalid retirement file')
                retirement.touch(mode=0o600)
            write_snapshot(settings.output_dir / 'current.json', {'version': 1, 'generation': generation.name},
                           staging_dir=generation)
        except Exception:
            if current_generation(settings.output_dir) != generation:
                shutil.rmtree(generation, ignore_errors=True)
            raise
        return {'status': 'published', **counts}


def run_cycle(settings: SyncSettings) -> int:
    try:
        print(json.dumps(sync_once(settings)), flush=True)
        return 0
    except SyncBusy:
        print('{"status":"busy"}', flush=True)
        return 0
    except ProbeError as error:
        reason = 'auth_required' if error.status == 'auth_required' else 'provider_request_failed'
    except (BridgeError, OSError, ValueError, TypeError, KeyError, RuntimeError):
        reason = 'local_configuration_or_publish_failed'
    print(json.dumps({'status': 'failed', 'reason': reason}), flush=True)
    return 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--loop', action='store_true')
    args = parser.parse_args(argv)
    try:
        settings = read_settings(args.config)
    except (BridgeError, OSError, ValueError, RuntimeError):
        print('{"status":"failed","reason":"invalid_sync_configuration"}', flush=True)
        return 2
    if not args.loop:
        return run_cycle(settings)

    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    while not stop.is_set():
        started = time.monotonic()
        run_cycle(settings)
        stop.wait(max(0, settings.interval_seconds - (time.monotonic() - started)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
