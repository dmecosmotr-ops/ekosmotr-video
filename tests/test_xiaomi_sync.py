import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import xiaomi_sync as sync
from xiaomi_cloud_probe import ProbeError
from xiaomi_shared_inventory import camera_id_for_did


TEST_TMPDIR = Path(os.environ.get('PILOT_TEST_TMPDIR', Path(__file__).parent))


def fixture_camera(device_id, *, online=True):
    return {'deviceId': device_id, 'name': f'Camera fixture {device_id}',
            'model': 'chuangmi.camera.fixture', 'online': online}


class SyncTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(dir=TEST_TMPDIR)
        self.addCleanup(temp.cleanup)
        self.private = Path(temp.name) / 'private'
        self.private.mkdir()
        self.output = self.private / 'catalog'
        self.config = self.private / 'sync-config.json'
        self.config.write_text(json.dumps({'go2rtcConfig': 'go2rtc.yaml', 'bridgeTemplate': 'bridge.json',
                                           'outputDir': 'catalog', 'stationMap': 'station-map.json'}))
        self.station_map = self.private / 'station-map.json'
        self.station_map.write_text('{}')
        stations_file = self.private / 'stations.json'
        stations_file.write_text(json.dumps([{'id': 'station-1'}]))
        (self.private / 'go2rtc.yaml').touch()
        for name in ('java-fixture', 'ffmpeg-fixture'):
            (self.private / name).touch()
        template = {'accountId': '99', 'deviceId': '1', 'model': 'xiaomi.camera.placeholder', 'region': 'ru',
                    'go2rtcConfig': str(self.private / 'go2rtc.yaml'), 'java': str(self.private / 'java-fixture'),
                    'ffmpeg': str(self.private / 'ffmpeg-fixture'), 'cloudTools': str(self.private),
                    'pythonDeps': str(self.private), 'privateRoot': str(self.private), 'javaClasses': str(self.private)}
        (self.private / 'bridge.json').write_text(json.dumps(template))
        self.addCleanup(patch.stopall)
        patch.object(sync, 'STATIONS_FILE', stations_file).start()
        patch.object(sync, 'XiaomiCloud', return_value=Mock()).start()
        patch.object(sync, 'load_token', return_value='token-fixture').start()
        self.discover = patch.object(sync, 'discover_cameras').start()

    def pointer(self):
        return json.loads((self.output / 'current.json').read_text())

    def active(self):
        return self.output / self.pointer()['generation']

    def read_active(self, name):
        return json.loads((self.active() / name).read_text(encoding='utf-8'))

    def test_sync_imports_new_cameras_and_ignores_online_only_changes(self):
        self.discover.return_value = [fixture_camera('101')]
        self.assertEqual(sync.sync_once(self.config)['status'], 'published')
        first = self.active()
        self.assertRegex(first.name, r'^gen-[0-9a-f]{32}$')
        self.discover.return_value = [fixture_camera('101', online=False)]
        self.assertEqual(sync.sync_once(self.config)['status'], 'unchanged')
        self.assertEqual(self.active(), first)
        self.discover.return_value.append(fixture_camera('102'))
        self.assertEqual(sync.sync_once(self.config)['status'], 'published')
        self.assertEqual(len(self.read_active('camera-inventory.json')['cameras']), 2)
        self.assertEqual(len(self.read_active('live-config.json')['cameras']), 2)
        self.assertTrue(first.is_dir())

    def test_partial_response_or_failed_pointer_commit_preserves_previous_bundle(self):
        self.discover.return_value = [fixture_camera('101')]
        sync.sync_once(self.config)
        first = self.active()
        self.discover.side_effect = ProbeError('devices', 'incomplete_inventory')
        with self.assertRaises(ProbeError):
            sync.sync_once(self.config)
        self.assertEqual(self.active(), first)
        self.discover.side_effect = None
        self.discover.return_value = [fixture_camera('102')]
        with patch.object(sync, 'write_snapshot', side_effect=OSError('simulated commit failure')):
            with self.assertRaises(OSError):
                sync.sync_once(self.config)
        self.assertEqual(self.active(), first)
        self.assertEqual(len(self.read_active('camera-inventory.json')['cameras']), 1)

    def test_incomplete_active_files_are_republished_on_unchanged_provider_state(self):
        self.discover.return_value = [fixture_camera('101')]
        sync.sync_once(self.config)
        first = self.active()
        (first / 'live-config.json').write_text('{}')
        self.assertEqual(sync.sync_once(self.config)['status'], 'published')
        self.assertNotEqual(self.active(), first)
        self.assertEqual(len(self.read_active('live-config.json')['cameras']), 1)

    def test_card_stays_visible_when_provider_id_has_no_supported_live_route(self):
        self.discover.return_value = [fixture_camera('opaque-device')]
        self.assertEqual(sync.sync_once(self.config), {'status': 'published', 'cameraCount': 1, 'routeCount': 0})
        self.assertEqual(len(self.read_active('camera-inventory.json')['cameras']), 1)
        self.assertEqual(self.read_active('live-config.json')['cameras'], [])

    def test_concurrent_writer_never_fetches_or_publishes(self):
        self.output.mkdir()
        with sync.writer_lock(self.output):
            with self.assertRaises(sync.SyncBusy):
                sync.sync_once(self.config)
        self.discover.assert_not_called()
        self.assertFalse((self.output / 'current.json').exists())

    def test_unknown_active_station_rejects_update_but_unknown_inactive_mapping_is_ignored(self):
        self.discover.return_value = [fixture_camera('101')]
        self.station_map.write_text(json.dumps({camera_id_for_did('102'): 'unknown'}))
        self.assertEqual(sync.sync_once(self.config)['status'], 'published')
        first = self.active()
        self.station_map.write_text(json.dumps({camera_id_for_did('101'): 'unknown'}))
        with self.assertRaisesRegex(ValueError, 'Unknown station'):
            sync.sync_once(self.config)
        self.assertEqual(self.active(), first)

    def test_authoritative_empty_removes_revoked_cameras_and_preserves_retiring_routes(self):
        self.station_map.write_text(json.dumps({camera_id_for_did('101'): 'station-1'}))
        self.discover.return_value = [fixture_camera('101')]
        sync.sync_once(self.config)
        first = self.active()
        old = time.time() - sync.GENERATION_GRACE_SECONDS - 60
        os.utime(first, (old, old))
        stale = self.output / ('gen-' + 'd' * 32)
        stale.mkdir()
        os.utime(stale, (old, old))
        staging = self.output / ('.gen-' + 'f' * 32 + '-bundle-1234abcd')
        staging.mkdir()
        untouched = self.output / 'operator-data'
        untouched.mkdir()
        self.assertEqual(self.read_active('camera-inventory.json')['cameras'][0]['stationId'], 'station-1')
        self.discover.return_value = []
        self.assertEqual(sync.sync_once(self.config)['status'], 'published')
        self.assertEqual(self.read_active('camera-inventory.json')['cameras'], [])
        self.assertEqual(self.read_active('live-config.json')['cameras'], [])
        self.assertTrue(first.is_dir())
        self.assertFalse(stale.exists())
        self.assertFalse(staging.exists())
        self.assertTrue(untouched.is_dir())
        os.utime(first / sync.RETIREMENT, (old, old))
        self.assertEqual(sync.sync_once(self.config)['status'], 'unchanged')
        self.assertTrue(first.is_dir())


if __name__ == '__main__':
    unittest.main()
