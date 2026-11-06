"""Prepare a private cabinet configuration from an authorized Xiaomi inventory snapshot."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile

from xiaomi_live_bridge import BridgeError, load_config, private_path
from xiaomi_shared_inventory import camera_id_for_did


APP_ROOT = Path(__file__).resolve().parents[1]
CAMERA_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}')
PROVIDER_ID = re.compile(r'[0-9]{1,64}')
MODEL = re.compile(r'[a-z0-9_.-]{1,100}')


def read_private_json(path: Path):
    path = private_path(path)
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ValueError('Invalid private JSON file')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write_json(path: Path, value) -> None:
    with path.open('x', encoding='utf-8') as output:
        path.chmod(0o600)
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())


def valid_id(pattern, value) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def build_bundle(snapshot: dict, bridge_template: dict, target: Path, *, legacy_live=None,
                 legacy_ids=frozenset(), station_map=None, allow_empty=False) -> tuple[int, int]:
    target = private_path(target)
    if target.exists() or not target.parent.is_dir():
        raise ValueError('Choose a new bundle directory under an existing private directory')
    if (not isinstance(snapshot, dict) or snapshot.get('version') != 1
            or not isinstance(snapshot.get('cameras'), list) or not isinstance(snapshot.get('routes'), list)):
        raise ValueError('Invalid inventory snapshot')

    station_map = {} if station_map is None else station_map
    if not isinstance(station_map, dict) or not all(valid_id(CAMERA_ID, value) for value in station_map.values()):
        raise ValueError('Invalid confirmed station map')

    catalog = {}
    for row in snapshot['cameras']:
        if not isinstance(row, dict):
            raise ValueError('Invalid camera entry')
        camera_id = row.get('id')
        if not valid_id(CAMERA_ID, camera_id) or camera_id in catalog:
            raise ValueError('Invalid or duplicate camera ID')
        name, model = row.get('name'), row.get('model')
        if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 160
                or re.search(r'[\x00-\x1f\x7f]', name) or not valid_id(MODEL, model)):
            raise ValueError('Invalid camera label or model')
        item = {'id': camera_id, 'name': name.strip(), 'model': model,
                'mapping': 'legacy' if camera_id in legacy_ids else 'confirm'}
        if camera_id in station_map:
            item.update(mapping='confirm', stationId=station_map[camera_id])
        catalog[camera_id] = item
    minimum_count = 0 if allow_empty else 1
    if not minimum_count <= len(catalog) <= 1000 or not station_map.keys() <= catalog.keys():
        raise ValueError('Invalid catalog size or unknown camera in station map')

    legacy_routes = [] if legacy_live is None else legacy_live.get('cameras', [legacy_live])
    if not isinstance(legacy_routes, list):
        raise ValueError('Invalid existing live manifest')
    manifest = {}
    for entry in legacy_routes:
        camera_id = entry.get('cameraId') if isinstance(entry, dict) else None
        if not valid_id(CAMERA_ID, camera_id) or camera_id not in catalog or camera_id in manifest:
            raise ValueError('Invalid existing live camera ID')
        manifest[camera_id] = entry

    bridge_configs = {}
    seen_routes = set()
    for route in snapshot['routes']:
        if not isinstance(route, dict):
            raise ValueError('Invalid private route')
        camera_id, device_id = route.get('cameraId'), route.get('deviceId')
        if (not valid_id(CAMERA_ID, camera_id) or camera_id not in catalog or camera_id in seen_routes
                or not valid_id(PROVIDER_ID, device_id) or route.get('model') != catalog[camera_id]['model']):
            raise ValueError('Invalid or duplicate private route')
        if camera_id != camera_id_for_did(device_id):
            raise ValueError('Private device does not match the camera ID')
        seen_routes.add(camera_id)
        config = {**bridge_template, 'deviceId': device_id, 'model': route['model']}
        config.pop('sharedHome', None)
        if 'homeId' in route or 'homeOwnerId' in route:
            home = {field: route.get(field) for field in ('homeId', 'homeOwnerId')}
            if not all(valid_id(PROVIDER_ID, value) for value in home.values()):
                raise ValueError('Invalid shared home scope')
            config['sharedHome'] = home
        if camera_id in manifest:
            continue
        filename = f'bridge-{len(bridge_configs) + 1}.json'
        bridge_configs[filename] = config
        manifest[camera_id] = {
            'cameraId': camera_id, 'command': str(Path(sys.executable).absolute()),
            'args': ['-B', str(APP_ROOT / 'tools' / 'xiaomi_live_bridge.py'), '--config', str(target / filename)],
            'cwd': str(APP_ROOT), 'maxDurationSeconds': config.get('maxSeconds', 600),
            'startupTimeoutMs': 110000, 'stallTimeoutMs': 15000,
        }

    if not minimum_count <= len(manifest) <= 150:
        raise ValueError('Invalid live route count')
    with tempfile.TemporaryDirectory(prefix=f'.{target.name}-bundle-', dir=target.parent) as temp:
        staging = Path(temp) / 'bundle'
        staging.mkdir(mode=0o700)
        for filename, config in bridge_configs.items():
            write_json(staging / filename, config)
        write_json(staging / 'camera-inventory.json', {'version': 1, 'cameras': list(catalog.values())})
        write_json(staging / 'live-config.json', {'cameras': list(manifest.values())})
        staging.rename(target)
    return len(catalog), len(manifest)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--bridge-template', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--legacy-inventory', type=Path)
    parser.add_argument('--legacy-live', type=Path)
    parser.add_argument('--station-map', type=Path)
    args = parser.parse_args()
    try:
        previous = read_private_json(args.legacy_inventory) if args.legacy_inventory else []
        if not isinstance(previous, list):
            raise ValueError('Expected a legacy catalog array')
        count, routes = build_bundle(
            read_private_json(args.snapshot), load_config(args.bridge_template), args.output_dir,
            legacy_ids={row['id'] for row in previous},
            legacy_live=read_private_json(args.legacy_live) if args.legacy_live else None,
            station_map=read_private_json(args.station_map) if args.station_map else None,
        )
    except (BridgeError, ValueError, OSError, KeyError, TypeError, AttributeError):
        print('Xiaomi cabinet bundle was not created. Check the private input files and paths.', file=sys.stderr)
        return 2
    print(f'Cabinet bundle ready. Camera cards: {count}. Manual live routes: {routes}.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
