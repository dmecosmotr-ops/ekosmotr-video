import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import xiaomi_shared_inventory as inventory
from xiaomi_cloud_probe import ProbeError


TEST_TMPDIR = Path(os.environ.get('PILOT_TEST_TMPDIR', Path(__file__).parent))


def device(did, name, model='chuangmi.camera.fixture', **extra):
    return {'did': did, 'name': name, 'model': model, **extra}


def home(home_id, owner, did):
    return {'id': home_id, 'uid': owner, 'dids': [did],
            'roomlist': [{'id': 1, 'name': 'Кабинет на Примерной', 'dids': [did]}]}


class InventoryTests(unittest.TestCase):
    def test_direct_only_discovery_does_not_request_shared_homes(self):
        cloud = Mock()
        cloud.request.return_value = {'list': [device('103', 'Камера по прямому приглашению')]}
        result = inventory.make_snapshot(inventory.discover_cameras(cloud, direct_only=True))
        self.assertEqual(len(result['routes']), 1)
        self.assertNotIn('homeId', result['routes'][0])
        cloud.request.assert_called_once()
        self.assertEqual(cloud.request.call_args.args[0], '/v2/home/device_list_page')

    def test_shared_rooms_with_same_name_are_separate_and_deduplicated_by_did(self):
        cloud = Mock()

        def request(path, params, stage):
            if path.endswith('gethome'):
                self.assertIs(params['fetch_share'], True)
                return {'homelist': [], 'share_home_list': [home(10, 20, '101'), home(11, 21, '102')]}
            if not params['dids']:
                return {'list': [device('101', 'Камера бокса'), device('103', 'Индивидуальный доступ'),
                                 device('900', 'Розетка', 'fixture.plug.other')]}
            self.assertEqual(params['dids'], ['101', '102'])
            return {'list': [device('101', 'Камера бокса', isOnline=False, token='secret-fixture'),
                             device('102', 'Xiaomi Smart Camera C300', isOnline=True, local_ip='192.0.2.8')]}

        cloud.request.side_effect = request
        old_id = 'xiaomi_' + hashlib.sha256(b'101').hexdigest()
        result = inventory.make_snapshot(inventory.discover_cameras(cloud), legacy=[
            {'id': old_id, 'name': 'Примерный город, улица Примерная, 12', 'model': 'chuangmi.camera.fixture'}
        ])
        self.assertEqual(result['version'], 1)
        self.assertEqual(len(result['cameras']), 3)
        rows = {camera['id']: camera for camera in result['cameras']}
        routes = {route['deviceId']: route for route in result['routes']}
        self.assertEqual(rows[old_id]['name'], 'Примерный город, улица Примерная, 12')
        self.assertEqual(routes['101']['cameraId'], old_id)
        self.assertEqual(rows[routes['102']['cameraId']]['name'], 'Кабинет на Примерной')
        self.assertEqual((routes['102']['homeId'], routes['102']['homeOwnerId']), ('11', '21'))
        self.assertIs(routes['102']['online'], True)
        self.assertNotIn('homeId', routes['103'])
        self.assertEqual(set(rows[old_id]), {'id', 'name', 'model', 'source'})
        for value in ('secret-fixture', '192.0.2.8', 'fixture.plug.other'):
            self.assertNotIn(value, json.dumps(result))

    def test_missing_shared_details_use_home_specific_list(self):
        cloud = Mock()
        cloud.request.side_effect = [
            {'share_home_list': [home(10, 20, '101')]},
            {'list': []},
            {'list': []},
            {'device_info': [device('101', 'Бокс', is_online=True)]},
        ]
        result = inventory.make_snapshot(inventory.discover_cameras(cloud))
        self.assertEqual(result['cameras'][0]['name'], 'Кабинет на Примерной')
        self.assertIs(result['routes'][0]['online'], True)
        call = cloud.request.call_args.args
        self.assertEqual(call[0], '/v2/home/home_device_list')
        self.assertEqual(call[1]['home_owner'], 20)

    def test_partial_refresh_preserves_previous_snapshot_and_hides_secrets(self):
        cases = [
            [{'share_home_list': [home(10, 20, '101')]}, {'list': []},
             ProbeError('devices', 'timed_out'), {'device_info': []}],
            [{'homelist': []}, {'list': [device('101', 'Invalid camera', model=None)]}],
            [{'share_home_list': {}}, {'list': []}],
        ]
        for responses in cases:
            with self.subTest(first_response=responses[0]):
                self.assert_failed_refresh(responses)

    def assert_failed_refresh(self, responses):
        cloud = Mock()
        cloud.request.side_effect = responses
        with tempfile.TemporaryDirectory(dir=TEST_TMPDIR) as path:
            private = Path(path) / 'private'
            private.mkdir()
            output = private / 'inventory.json'
            output.write_text('previous snapshot', encoding='utf-8')
            config = private / 'go2rtc.yaml'
            config.touch()
            status = io.StringIO()
            errors = io.StringIO()
            with patch.object(inventory, 'account_from_config', return_value='123'), \
                 patch.object(inventory, 'load_token', return_value='secret-fixture'), \
                 patch.object(inventory, 'XiaomiCloud', return_value=cloud), contextlib.redirect_stdout(status), \
                 contextlib.redirect_stderr(errors):
                self.assertEqual(inventory.main(['--config', str(config), '--output', str(output)]), 1)
            self.assertEqual(output.read_text(encoding='utf-8'), 'previous snapshot')
            self.assertNotIn('secret-fixture', status.getvalue())
            self.assertNotIn('101', status.getvalue())
            self.assertEqual(errors.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
