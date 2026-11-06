"""Refresh the private camera inventory through an existing Xiaomi session.

The read endpoints cover individually shared devices and devices in shared homes.
See the Xiaomi Home integration's miot_cloud.py for the home and device lists.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile

from xiaomi_cloud_probe import BoundedHTTP, ProbeError, XiaomiCloud, load_token


DEVICE_LIST = '/v2/home/device_list_page'
HOME_DEVICE_LIST = '/v2/home/home_device_list'
MAX_ITEMS = 1000
MAX_PAGES = 12
SAFE_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}')
DIGITS = re.compile(r'[0-9]{1,64}')
MODEL = re.compile(r'[a-z0-9_.-]{1,100}')
GENERIC_NAME = re.compile(
    r'(?:xiaomi\s+|mijia\s+|mi\s+)?(?:(?:smart\s+)?camera(?:\s+[a-z]*\d+[a-z0-9.-]*)?'
    r'|камера(?:\s+xiaomi)?(?:\s+[\d.-]+)?|бокс|гостиная|living room)',
    re.IGNORECASE,
)


def _id(value, pattern=SAFE_ID):
    if type(value) is int:
        value = str(value)
    return value if isinstance(value, str) and pattern.fullmatch(value) else None


def _list(value, stage):
    if not isinstance(value, list) or len(value) > MAX_ITEMS:
        raise ProbeError(stage, 'invalid_response')
    return value


def _optional_list(value, stage):
    return [] if value is None else _list(value, stage)


def _name(value):
    if isinstance(value, str):
        value = value.strip()
        if 0 < len(value.encode('utf-16-le', errors='surrogatepass')) <= 320 and not re.search(
            r'[\x00-\x1f\x7f\ud800-\udfff]|://', value
        ):
            return value
    return None


def _informative(value):
    return value if value and not GENERIC_NAME.fullmatch(value) else None


def _pages(cloud, path, params, stage, list_key, start_key, cursor_keys):
    rows, seen = [], set()
    for _ in range(MAX_PAGES):
        page = cloud.request(path, params, stage)
        rows.extend(_list(page.get(list_key), stage))
        if len(rows) > MAX_ITEMS:
            raise ProbeError(stage, 'inventory_limit_exceeded')
        if not page.get('has_more', page.get('hasMore', False)):
            return rows
        cursor = next((_id(page.get(key)) for key in cursor_keys if page.get(key) is not None), None)
        if cursor is None or cursor in seen:
            raise ProbeError(stage, 'incomplete_inventory')
        seen.add(cursor)
        params = {**params, start_key: cursor}
    raise ProbeError(stage, 'incomplete_inventory')


def fetch_devices_by_id(cloud, device_ids):
    """With an empty list, fetch the account's direct device list."""
    return _pages(cloud, DEVICE_LIST, {
        'limit': 200, 'get_split_device': True, 'get_third_device': True, 'dids': list(device_ids),
    }, 'devices', 'list', 'start_did', ('next_start_did', 'max_did'))


def fetch_home_devices(cloud, home_id, owner_id):
    home_id, owner_id = _id(home_id, DIGITS), _id(owner_id, DIGITS)
    if home_id is None or owner_id is None:
        raise ProbeError('home_devices', 'invalid_home')
    return _pages(cloud, HOME_DEVICE_LIST, {
        'home_owner': int(owner_id), 'home_id': int(home_id), 'limit': 100, 'start_did': '',
        'get_split_device': False, 'support_smart_home': True, 'get_cariot_device': True,
        'get_third_device': True,
    }, 'home_devices', 'device_info', 'start_did', ('max_did', 'next_start_did'))


def _home_locations(cloud):
    stage = 'homes'
    page = cloud.request('/v2/homeroom/gethome', {
        'limit': 150, 'fetch_share': True, 'fetch_share_dev': True, 'plat_form': 0, 'app_ver': 9,
    }, stage)
    if not {'homelist', 'share_home_list'} & page.keys():
        raise ProbeError(stage, 'invalid_response')
    homes, devices, rooms = {}, {}, {}

    def add(home, include_owner):
        if not isinstance(home, dict):
            raise ProbeError(stage, 'invalid_response')
        home_id = _id(home.get('id'), DIGITS)
        owner = _id(home.get('uid'), DIGITS)
        if include_owner and home_id and owner:
            homes[home_id] = owner
        if home_id not in homes:
            raise ProbeError(stage, 'invalid_home')
        location = (home_id, homes[home_id])
        for group in [home, *_optional_list(home.get('roomlist'), stage)]:
            if not isinstance(group, dict):
                raise ProbeError(stage, 'invalid_response')
            label = _name(group.get('name')) if group is not home else None
            for raw_id in _optional_list(group.get('dids'), stage):
                did = _id(raw_id)
                if not did:
                    raise ProbeError(stage, 'invalid_device')
                devices.setdefault(did, set()).add(location)
                if label:
                    rooms.setdefault(did, set()).add(label)

    for key in ('homelist', 'share_home_list'):
        for home in _optional_list(page.get(key), stage):
            add(home, True)
    if page.get('has_more'):
        cursor = _id(page.get('max_id'))
        if cursor is None:
            raise ProbeError(stage, 'incomplete_inventory')
        tail = _pages(cloud, '/v2/homeroom/get_dev_room_page', {'start_id': cursor, 'limit': 150},
                      stage, 'info', 'start_id', ('max_id',))
        for home in tail:
            add(home, False)
    if len(devices) > MAX_ITEMS:
        raise ProbeError(stage, 'inventory_limit_exceeded')
    return devices, rooms


def discover_cameras(cloud, *, direct_only=False):
    """Join the authorized home membership list with exact device metadata."""
    locations, room_names = ({}, {}) if direct_only else _home_locations(cloud)
    devices = {}

    def merge(rows, expected=None):
        for row in rows:
            if not isinstance(row, dict):
                raise ProbeError('devices', 'invalid_response')
            did = _id(row.get('did'))
            if did is None:
                raise ProbeError('devices', 'invalid_device')
            if expected is not None and did not in expected:
                continue
            prior = devices.setdefault(did, {})
            for key in ('name', 'model', 'isOnline', 'is_online', 'online'):
                if row.get(key) not in (None, ''):
                    if key == 'model' and prior.get(key) and row[key] != prior[key]:
                        raise ProbeError('devices', 'inconsistent_device_model')
                    prior[key] = row[key]

    merge(fetch_devices_by_id(cloud, []))
    shared_ids = sorted(locations)
    for offset in range(0, len(shared_ids), 150):
        batch = shared_ids[offset:offset + 150]
        try:
            rows = fetch_devices_by_id(cloud, batch)
        except ProbeError:
            # The default device route can omit shared homes. Complete them below.
            continue
        merge(rows, set(batch))

    unresolved = {did for did in locations.keys() | devices.keys() if not devices.get(did, {}).get('model')}
    resolved_at = {}
    home_errors = {}
    for home_id, owner_id in sorted({location for did in unresolved for location in locations.get(did, ())}):
        group = {did for did in unresolved if (home_id, owner_id) in locations.get(did, ())}
        if not group:
            continue
        try:
            rows = fetch_home_devices(cloud, home_id, owner_id)
        except ProbeError as error:
            for did in group:
                home_errors[did] = error
            continue
        merge(rows, group)
        resolved = {did for did in group if devices.get(did, {}).get('model')}
        resolved_at.update(dict.fromkeys(resolved, (home_id, owner_id)))
        unresolved -= resolved
    if unresolved:
        raise home_errors.get(min(unresolved), ProbeError('home_devices', 'incomplete_inventory'))

    if len(devices) > MAX_ITEMS:
        raise ProbeError('devices', 'inventory_limit_exceeded')
    cameras = []
    for did, row in sorted(devices.items()):
        model = row.get('model')
        if not isinstance(model, str) or not MODEL.fullmatch(model) or '.camera.' not in model:
            continue
        raw_name = _name(row.get('name'))
        labels = {label for label in room_names.get(did, ()) if _informative(label)}
        room_label = labels.pop() if len(labels) == 1 else None
        online = next((row[key] for key in ('isOnline', 'is_online', 'online') if type(row.get(key)) is bool), None)
        camera = {'deviceId': did, 'name': _informative(raw_name) or room_label or raw_name or 'Камера Xiaomi',
                  'model': model, 'online': online}
        if did in locations:
            camera['homeId'], camera['homeOwnerId'] = resolved_at.get(did) or min(locations[did])
        cameras.append(camera)
    return cameras


def camera_id_for_did(device_id):
    return 'xiaomi_' + hashlib.sha256(device_id.encode('ascii')).hexdigest()


def make_snapshot(cameras, *, legacy=()):
    """Keep metadata and private routing in one atomically replaceable file."""
    catalog, routes = {}, []
    for row in legacy:
        if not isinstance(row, dict) or not _id(row.get('id')) or not _name(row.get('name')) or not _name(row.get('model')):
            raise ProbeError('legacy', 'invalid_inventory')
        camera_id = str(row['id'])
        if camera_id in catalog or len(row['model']) > 100:
            raise ProbeError('legacy', 'invalid_inventory')
        catalog[camera_id] = {'id': camera_id, 'name': row['name'].strip(), 'model': row['model'].strip(),
                              'source': 'xiaomi_inventory'}
    for camera in cameras:
        did = camera['deviceId']
        camera_id = camera_id_for_did(did)
        old_name = catalog.get(camera_id, {}).get('name')
        catalog[camera_id] = {'id': camera_id, 'name': _informative(old_name) or camera['name'],
                              'model': camera['model'], 'source': 'xiaomi_inventory'}
        if _id(did, DIGITS):
            route = {'cameraId': camera_id, **{key: camera[key] for key in ('deviceId', 'model', 'online')}}
            if 'homeId' in camera and 'homeOwnerId' in camera:
                route.update(homeId=camera['homeId'], homeOwnerId=camera['homeOwnerId'])
            routes.append(route)
    if len(catalog) > MAX_ITEMS:
        raise ProbeError('output', 'inventory_limit_exceeded')
    return {'version': 1, 'cameras': list(catalog.values()), 'routes': routes}


def _private_path(value):
    path = value.resolve()
    if 'private' not in {part.lower() for part in path.parts[:-1]}:
        raise ProbeError('config', 'private_path_required')
    return path


def account_from_config(config, requested):
    try:
        import yaml
    except ImportError:
        raise ProbeError('config', 'missing_yaml_dependency') from None
    try:
        accounts = yaml.safe_load(config.read_text(encoding='utf-8-sig'))['xiaomi']
        if not isinstance(accounts, dict):
            raise ValueError
        accounts = {_id(key, DIGITS) for key in accounts}
        accounts.discard(None)
    except (OSError, TypeError, KeyError, ValueError, yaml.YAMLError):
        raise ProbeError('config', 'invalid_config') from None
    if requested is None and len(accounts) == 1:
        return accounts.pop()
    if requested not in accounts:
        raise ProbeError('config', 'account_selection_needed')
    return requested


def write_snapshot(path, snapshot, *, staging_dir=None):
    content = json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(content) > 1024 * 1024:
        raise ProbeError('output', 'inventory_limit_exceeded')
    fd, temporary = tempfile.mkstemp(prefix='.xiaomi-inventory-', suffix='.tmp', dir=staging_dir or path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--legacy-inventory', type=Path)
    parser.add_argument('--python-deps', type=Path)
    parser.add_argument('--direct-only', action='store_true', help='Read direct device shares into a new snapshot')
    parser.add_argument('--account-id')
    parser.add_argument('--region', choices=('ru', 'de', 'i2', 'sg', 'us', 'cn'), default='ru')
    parser.add_argument('--timeout', type=float, default=90)
    args = parser.parse_args(argv)
    try:
        config, output = _private_path(args.config), _private_path(args.output)
        legacy = _private_path(args.legacy_inventory) if args.legacy_inventory else None
        if output in (config, legacy) or not math.isfinite(args.timeout) or not 5 <= args.timeout <= 180:
            raise ProbeError('config', 'invalid_arguments')
        if args.direct_only and output.exists():
            raise ProbeError('output', 'use_new_direct_snapshot')
        if args.python_deps:
            deps = args.python_deps.resolve(strict=True)
            if not deps.is_dir():
                raise ProbeError('config', 'missing_yaml_dependency')
            sys.path.insert(0, str(deps))
        if legacy:
            if legacy.stat().st_size > 1024 * 1024:
                raise ProbeError('legacy', 'inventory_limit_exceeded')
            baseline = _list(json.loads(legacy.read_text(encoding='utf-8-sig')), 'legacy')
        else:
            baseline = []
        account_id = account_from_config(config, args.account_id)
        cloud = XiaomiCloud(BoundedHTTP(args.timeout), args.region)
        cloud.login_with_token(account_id, load_token(config, account_id))
        snapshot = make_snapshot(discover_cameras(cloud, direct_only=args.direct_only), legacy=baseline)
        write_snapshot(output, snapshot)
    except ProbeError as error:
        print(json.dumps({'status': 'failed', 'stage': error.stage, 'reason': error.status}))
        return 1
    except (OSError, ValueError):
        print(json.dumps({'status': 'failed', 'stage': 'local', 'reason': 'invalid_file'}))
        return 1
    print(json.dumps({'status': 'ready', 'cameraCount': len(snapshot['cameras']),
                      'routeCount': len(snapshot['routes'])}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
