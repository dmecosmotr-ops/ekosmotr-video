import importlib.util
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'tools' / 'xiaomi_cabinet_bundle.py'
TMPDIR = Path(os.environ.get('PILOT_TEST_TMPDIR', Path(__file__).parent))


class CabinetBundleTests(unittest.TestCase):
    def test_private_routes_and_safe_catalog_share_ids_and_keep_legacy_route(self):
        spec = importlib.util.spec_from_file_location('bundle', SCRIPT)
        bundle = importlib.util.module_from_spec(spec)
        with patch.object(sys, 'path', [str(SCRIPT.parent), *sys.path]):
            spec.loader.exec_module(bundle)
        new_id = 'xiaomi_' + hashlib.sha256(b'123').hexdigest()
        snapshot = {'version': 1, 'cameras': [
            {'id': 'old-camera', 'name': 'Old Camera', 'model': 'fixture.camera.one'},
            {'id': new_id, 'name': 'New Camera', 'model': 'fixture.camera.two', 'token': 'private'},
        ], 'routes': [{'cameraId': new_id, 'deviceId': '123', 'model': 'fixture.camera.two',
                       'homeId': '456', 'homeOwnerId': '789'}]}
        old_route = {'cameraId': 'old-camera', 'command': '/python', 'args': [], 'cwd': '/app'}
        with tempfile.TemporaryDirectory(dir=TMPDIR) as directory:
            root = Path(directory) / 'private'
            root.mkdir()
            target = root / 'bundle'
            bundle.build_bundle(snapshot, {'region': 'ru'}, target, legacy_live=old_route,
                                legacy_ids={'old-camera'}, station_map={new_id: 'station-1'})
            catalog = json.loads((target / 'camera-inventory.json').read_text(encoding='utf-8'))
            manifest = json.loads((target / 'live-config.json').read_text(encoding='utf-8'))
            self.assertEqual(catalog['cameras'], [
                {'id': 'old-camera', 'name': 'Old Camera', 'model': 'fixture.camera.one', 'mapping': 'legacy'},
                {'id': new_id, 'name': 'New Camera', 'model': 'fixture.camera.two', 'mapping': 'confirm',
                 'stationId': 'station-1'},
            ])
            self.assertEqual(manifest['cameras'][0], old_route)
            self.assertEqual(manifest['cameras'][1]['cameraId'], new_id)
            config = json.loads(Path(manifest['cameras'][1]['args'][-1]).read_text(encoding='utf-8'))
            self.assertEqual(config['deviceId'], '123')
            self.assertEqual(config['sharedHome'], {'homeId': '456', 'homeOwnerId': '789'})
            snapshot['routes'][0]['deviceId'] = '124'
            invalid = root / 'invalid'
            with self.assertRaisesRegex(ValueError, 'does not match'):
                bundle.build_bundle(snapshot, {'region': 'ru'}, invalid)
            self.assertFalse(invalid.exists())
