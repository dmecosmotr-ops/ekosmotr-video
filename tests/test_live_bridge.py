import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

BRIDGE = pathlib.Path(__file__).resolve().parents[1] / 'tools' / 'xiaomi_live_bridge.py'
TEST_TMPDIR = pathlib.Path(os.environ.get('PILOT_TEST_TMPDIR', pathlib.Path(__file__).parent))


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(BRIDGE.is_file(), 'continuous bridge has not been implemented')
        spec = importlib.util.spec_from_file_location('live_bridge', BRIDGE)
        self.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.bridge)

    def test_vendor_mapping_preserves_exact_fields_without_printing_or_newlines(self):
        result = {'vendor': {'vendor': 4, 'vendor_params': {'p2p_id': 'ABCD-000001-ABCDE',
                  'init_string': 'abc123'}}, 'public_key': '22' * 32, 'sign': '33' * 32}
        mapped = self.bridge.provision_properties(result, '11' * 32, '44' * 32)
        self.assertEqual(mapped['p2pId'], 'ABCD-000001-ABCDE')
        self.assertEqual(mapped['initString'], 'abc123')
        self.assertEqual(mapped['clientPrivate'], '44' * 32)
        self.assertEqual(mapped['devicePublic'], '22' * 32)
        result['vendor']['vendor_params']['p2p_id'] = 'x\nsign=leak'
        with self.assertRaises(self.bridge.BridgeError):
            self.bridge.provision_properties(result, '11' * 32, '44' * 32)

    def test_vendor_must_be_cs2_and_provisioning_complete(self):
        with self.assertRaises(self.bridge.BridgeError):
            self.bridge.provision_properties({'vendor': {'vendor': 1}}, '11' * 32, '22' * 32)
        with self.assertRaises(self.bridge.BridgeError):
            self.bridge.provision_properties({'vendor': {'vendor': 4, 'vendor_params': {}}}, '11' * 32, '22' * 32)

    def test_ffmpeg_arguments_read_only_pipe_and_no_audio(self):
        args = self.bridge.ffmpeg_arguments('/fixed/ffmpeg')
        self.assertEqual(args[0], '/fixed/ffmpeg')
        self.assertEqual(args[args.index('-i') + 1], 'pipe:0')
        self.assertEqual(args[-1], 'pipe:1')
        self.assertIn('-an', args)
        self.assertIn('libx264', args)
        self.assertIn('frag_keyframe+empty_moov+default_base_moof', args)

    def test_configuration_requires_private_path_and_rejects_invalid_identifiers(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMPDIR) as directory:
            root = pathlib.Path(directory)
            config = root / 'config.json'
            config.write_text('{}')
            with self.assertRaises(self.bridge.BridgeError):
                self.bridge.load_config(config)
            private = root / 'private'
            private.mkdir()
            config = private / 'config.json'
            config.write_text(json.dumps({'accountId': '\n', 'deviceId': '1'}))
            with self.assertRaises(self.bridge.BridgeError):
                self.bridge.load_config(config)

    def test_cleanup_requests_stop_and_reaps_synthetic_child(self):
        child = subprocess.Popen([sys.executable, '-c',
            'import sys; line=sys.stdin.readline(); sys.exit(0 if line=="STOP\\n" else 9)'],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.bridge.stop_process(child, graceful=True)
        self.assertEqual(child.poll(), 0)

    def test_cleanup_terminates_unresponsive_synthetic_child(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.bridge.stop_process(child, graceful=False)
        self.assertIsNotNone(child.poll())

    def test_fresh_provision_uses_fixed_device_id_despite_device_order(self):
        calls = []
        result = {'vendor': {'vendor': 4, 'vendor_params': {
            'p2p_id': 'ABCD-000001-ABCDE', 'init_string': 'abc123'}},
            'public_key': '22' * 32, 'sign': '33' * 32}
        class Cloud:
            def login_with_token(self, account, token):
                calls.append(('login', account))
            def request(self, path, params, stage):
                calls.append((path, params))
                return {'list': [{'did': 'wrong', 'model': 'wrong'},
                    {'did': '123', 'model': 'camera.test', 'isOnline': True}]} if stage == 'device' else result
        class Key:
            public_key = bytes.fromhex('11' * 32)
            def __bytes__(self): return bytes.fromhex('44' * 32)
        helper = types.SimpleNamespace(BoundedHTTP=lambda timeout: object(),
            XiaomiCloud=lambda http, region: Cloud(), load_token=lambda config, account: 'fixture-token')
        public = types.ModuleType('nacl.public')
        public.PrivateKey = types.SimpleNamespace(generate=lambda: Key())
        config = {'pythonDeps': '/unused', 'cloudTools': '/unused', 'region': 'ru',
            'go2rtcConfig': '/private/config', 'accountId': '99', 'deviceId': '123', 'model': 'camera.test'}
        with patch.object(self.bridge.importlib, 'import_module', return_value=helper), \
                patch.dict(sys.modules, {'nacl.public': public}):
            properties = self.bridge.fresh_provision(config)
        self.assertEqual(properties['clientPublic'], '11' * 32)
        provisioning = [params for path, params in calls if path == '/v2/device/miss_get_vendor']
        self.assertEqual(provisioning[0]['did'], '123')

    def test_complete_private_configuration_accepts_classpath_directories(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMPDIR) as directory:
            private = pathlib.Path(directory) / 'private'
            private.mkdir()
            for name in ('java', 'ffmpeg', 'go2rtc'):
                (private / name).write_text('fixture')
            for name in ('classes', 'vendor', 'cloud', 'deps'):
                (private / name).mkdir()
            import os
            config = {'accountId': '99', 'deviceId': '123', 'model': 'camera.test', 'region': 'ru',
                'java': str(private / 'java'), 'ffmpeg': str(private / 'ffmpeg'),
                'go2rtcConfig': str(private / 'go2rtc'), 'privateRoot': str(private),
                'javaClasses': os.pathsep.join([str(private / 'classes'), str(private / 'vendor')]),
                'cloudTools': str(private / 'cloud'), 'pythonDeps': str(private / 'deps')}
            path = private / 'config.json'
            path.write_text(json.dumps(config), encoding='utf-8')
            self.assertEqual(self.bridge.load_config(path)['deviceId'], '123')

    def test_pipeline_cleanup_reaps_encoder_before_stalled_java_once(self):
        java = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        encoder = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        cleanup = self.bridge.PipelineCleanup()
        cleanup.java, cleanup.ffmpeg = java, encoder
        actual_stop = self.bridge.stop_process
        calls = []
        def recording_stop(child, graceful=False):
            calls.append(child)
            actual_stop(child, graceful)
        started = time.monotonic()
        try:
            with patch.object(self.bridge, 'stop_process', side_effect=recording_stop):
                workers = [threading.Thread(target=cleanup) for _ in range(3)]
                for worker in workers: worker.start()
                for worker in workers: worker.join(timeout=4.5)
            self.assertTrue(all(not worker.is_alive() for worker in workers))
            self.assertTrue(cleanup.done.is_set())
            self.assertEqual(calls, [encoder, java])
            self.assertIsNotNone(encoder.poll())
            self.assertIsNotNone(java.poll())
            self.assertLess(time.monotonic() - started, 4.5)
            self.assertTrue(java.stdout.closed)
            self.assertTrue(encoder.stdout.closed)
        finally:
            actual_stop(encoder)
            actual_stop(java)


if __name__ == '__main__':
    unittest.main()
