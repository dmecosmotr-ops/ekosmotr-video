"""Synthetic acceptance for conservative fragment observations; no model/media needed."""
import copy
import hashlib
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from video.tracking import Detection, ObservationEngine, GateDebouncer
from video.analysis import load_camera_config, make_manifest, publish_manifest, load_capture, GateTemplates, analyze_file
from video.fetch_model import verify_model

TEST_TEMP = pathlib.Path(__file__).resolve().parents[1] / 'private' / 'video-analysis-validation' / 'tests-tmp'
TEST_TEMP.mkdir(parents=True, exist_ok=True)


def config():
    return {
        'cameraId': 'camera-1', 'stationId': 'station-1', 'mappingVersion': 'v1',
        'timezone': 'Asia/Barnaul', 'primary': True,
        'analysis': {
            'sampleIntervalSeconds': 1,
            'personZone': [[0, 0], [1, 0], [1, 1], [0, 1]],
            'vehicleZone': [[0, 0], [1, 0], [1, 1], [0, 1]],
            'line': {'start': [0.5, 0.1], 'end': [0.5, 0.9],
                     'entryDirection': 'positive_to_negative'},
            'tracking': {'minTrackHits': 3, 'sideStableSamples': 2,
                         'lineMargin': 0.025, 'maxDistance': 0.22},
        },
    }


def car(x, class_name='car', y=0.6):
    return Detection(class_name, 0.9, (x - 0.08, y - 0.2, x + 0.08, y))


def sequence(xs, **kwargs):
    engine = ObservationEngine(config())
    for t, x in enumerate(xs):
        engine.update(float(t), [] if x is None else [car(x, **kwargs)])
    return engine.events


class TrackingAcceptance(unittest.TestCase):
    def test_continuous_entry_and_exit_share_visit_only_when_paired(self):
        engine = ObservationEngine(config())
        for t, x in enumerate([.3, .31, .32, .42, .56, .62]):
            engine.update(t, [car(x)])
        self.assertEqual([e['type'] for e in engine.events], ['vehicle_entry'])
        self.assertIsNone(engine.events[0]['visitId'])
        for t, x in enumerate([.65, .6, .44, .38], start=6):
            engine.update(t, [car(x)])
        self.assertEqual([e['type'] for e in engine.events], ['vehicle_entry', 'vehicle_exit'])
        self.assertTrue(engine.events[0]['visitId'])
        self.assertEqual(engine.events[0]['visitId'], engine.events[1]['visitId'])

    def test_lost_track_does_not_pair_reappearance(self):
        events = sequence([.3, .31, .32, .42, .56, .62, None, .7, .7, .7, .6, .44, .38])
        self.assertEqual([e['type'] for e in events], ['vehicle_entry', 'vehicle_exit'])
        self.assertEqual([e['visitId'] for e in events], [None, None])

    def test_missing_observation_and_time_gap_cannot_be_crossings(self):
        self.assertEqual(sequence([.3, .31, .32, None, .6, .61, .62]), [])
        engine = ObservationEngine(config())
        for t, x in [(0, .3), (1, .31), (2, .32), (7, .6), (8, .61), (9, .62)]:
            engine.update(t, [car(x)])
        self.assertEqual(engine.events, [])

    def test_class_change_breaks_continuity(self):
        engine = ObservationEngine(config())
        for t, x in enumerate([.3, .31, .32, .42, .56, .62]):
            engine.update(t, [car(x, 'car' if t < 4 else 'truck')])
        self.assertEqual(engine.events, [])

    def test_line_jitter_and_newborn_crossing_are_not_counted(self):
        self.assertEqual(sequence([.3, .31, .32, .49, .51, .48, .52, .49, .51]), [])
        self.assertEqual(sequence([.4, .57, .65, .65]), [])
        self.assertEqual(sequence([.3, .31, .32, .42, .56, .45, .4]), [])

    def test_finite_line_and_nonprimary_camera_do_not_count(self):
        self.assertEqual(sequence([.3, .31, .32, .42, .56, .62], y=.98), [])
        cfg = config()
        cfg['primary'] = False
        engine = ObservationEngine(cfg)
        for t, x in enumerate([.3, .31, .32, .42, .56, .62]):
            engine.update(t, [car(x)])
        self.assertEqual(engine.events, [])

    def test_crossing_outside_endpoint_cannot_move_inside_during_confirmation(self):
        engine = ObservationEngine(config())
        # Actual t3→t4 line intersection is y=.9167, outside endpoint .9.
        # The chord from t3 to t5 crosses inside, but was never observed.
        anchors = [(.4, .85)] * 4 + [(.55, .95), (.56, .85)]
        for t, (x, y) in enumerate(anchors):
            engine.update(t, [car(x, y=y)])
        self.assertEqual(engine.events, [])

    def test_actual_crossing_inside_margin_survives_until_stable_confirmation(self):
        engine = ObservationEngine(config())
        # Crossing happens between .49 and .51, both within the .025 deadband.
        for t, x in enumerate([.4, .4, .4, .49, .51, .56, .57]):
            engine.update(t, [car(x)])
        self.assertEqual([e['type'] for e in engine.events], ['vehicle_entry'])
        self.assertEqual(engine.events[0]['offsetSeconds'], 6)

    def test_ambiguous_tracks_are_retired_instead_of_swapped(self):
        engine = ObservationEngine(config())
        for t in range(3):
            engine.update(t, [car(.3, y=.5), car(.3, y=.6)])
        for t in range(3, 6):
            engine.update(t, [car(.6, y=.55)])
        self.assertEqual(engine.events, [])

    def test_person_requires_stable_same_track_in_zone(self):
        engine = ObservationEngine(config())
        engine.update(0, [car(.3, 'person')])
        engine.update(1, [])
        engine.update(2, [car(.3, 'person')])
        engine.update(3, [car(.31, 'person')])
        self.assertEqual(engine.events, [])
        engine.update(4, [car(.32, 'person')])
        engine.update(5, [car(.33, 'person')])
        self.assertEqual(len(engine.events), 1)
        self.assertEqual(engine.events[0]['type'], 'first_seen')
        self.assertEqual(engine.events[0]['offsetSeconds'], 2)

    def test_person_outside_zone_is_not_first_seen(self):
        cfg = config()
        cfg['analysis']['personZone'] = [[0, 0], [.2, 0], [.2, 1], [0, 1]]
        engine = ObservationEngine(cfg)
        for t in range(5):
            engine.update(t, [car(.7, 'person')])
        self.assertEqual(engine.events, [])

    def test_gate_needs_initial_baseline_then_debounced_transition(self):
        gate = GateDebouncer(stable_samples=3)
        self.assertEqual([gate.update('closed', .9) for _ in range(3)], [None] * 3)
        self.assertIsNone(gate.update('opened', .9))
        self.assertIsNone(gate.update(None, 0))
        self.assertIsNone(gate.update('opened', .9))
        self.assertIsNone(gate.update('opened', .9))
        event = gate.update('opened', .9)
        self.assertEqual(event['type'], 'opened')
        self.assertTrue(event['needsReview'])
        self.assertIsNone(gate.update('opened', .9))


class ManifestAcceptance(unittest.TestCase):
    def test_configuration_is_explicit_and_timezone_checked(self):
        for key in ('personZone', 'vehicleZone', 'line'):
            cfg = config()
            del cfg['analysis'][key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                load_camera_config(cfg)
        cfg = config()
        cfg['timezone'] = 'Made/Up'
        with self.assertRaises(ValueError):
            load_camera_config(cfg)
        self.assertEqual(load_camera_config(config())['cameraId'], 'camera-1')

    def test_v1_manifest_partial_utc_seconds_and_no_private_paths(self):
        events = [{'type': 'first_seen', 'offsetSeconds': 2, 'confidence': .9, 'visitId': None}]
        manifest = make_manifest(config(), 'run-1', 'run-1/video.mp4', 'a' * 64,
                                 '2026-11-05T04:00:00.000Z', 30, 'estimated', events)
        self.assertEqual(manifest['coverage'], {'status': 'partial', 'sampleIntervalSeconds': 1})
        self.assertEqual(manifest['recording']['timing'], 'estimated')
        self.assertEqual(manifest['events'][0]['occurredAtUtc'], '2026-11-05T04:00:02.000Z')
        self.assertEqual(manifest['events'][0]['evidence'], {'recordingId': 'run-1', 'offsetSeconds': 2})
        self.assertTrue(manifest['events'][0]['needsReview'])
        self.assertEqual(set(manifest['events'][0]), {'id', 'type', 'occurredAtUtc', 'confidence',
                                                     'visitId', 'needsReview', 'evidence'})

    def test_invalid_paths_times_offsets_duration_and_timing_rejected(self):
        base = [config(), 'run-1', 'run-1/video.mp4', 'a' * 64,
                '2026-11-05T04:00:00.000Z', 30, 'estimated', []]
        for index, value in [(1, '../run'), (2, '../video.mp4'), (2, '/video.mp4'),
                             (4, '2026-11-05T04:00:00'), (5, 901), (5, float('nan')),
                             (6, 'camera_local_unverified')]:
            args = copy.deepcopy(base)
            args[index] = value
            with self.subTest(index=index, value=value), self.assertRaises(ValueError):
                make_manifest(*args)
        for offset in (-1, 31, float('nan')):
            args = copy.deepcopy(base)
            args[7] = [{'type': 'vehicle_entry', 'offsetSeconds': offset, 'confidence': .9, 'visitId': None}]
            with self.assertRaises(ValueError):
                make_manifest(*args)

    def test_atomic_publish_refuses_duplicate_run(self):
        manifest = make_manifest(config(), 'run-1', 'run-1/video.mp4', 'a' * 64,
                                 '2026-11-05T04:00:00Z', 30, 'verified', [])
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as root:
            path = publish_manifest(pathlib.Path(root), manifest)
            self.assertEqual(json.loads(path.read_text())['runId'], 'run-1')
            with self.assertRaises(FileExistsError):
                publish_manifest(pathlib.Path(root), manifest)
            self.assertEqual(list(pathlib.Path(root).glob('*.tmp')), [])

    def test_capture_checks_mapping_status_hash_and_archive_containment(self):
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as folder:
            archive = pathlib.Path(folder)
            run = archive / 'run-1'
            run.mkdir()
            (run / 'video.mp4').write_bytes(b'synthetic bytes only')
            record = {'id': 'run-1', 'file': 'run-1/video.mp4',
                      'sha256': hashlib.sha256(b'synthetic bytes only').hexdigest(),
                      'startedAt': '2026-11-05T04:00:00Z', 'durationSeconds': 30, 'timing': 'estimated'}
            capture = dict(schemaVersion=1, runId='run-1', cameraId='camera-1', stationId='station-1',
                           mappingVersion='v1', timezone='Asia/Barnaul', status='complete', recording=record)
            path = run / 'capture.json'
            path.write_text(json.dumps(capture))
            self.assertEqual(load_capture(path, config(), archive)['recording']['id'], 'run-1')
            for field, value in [('status', 'failed'), ('cameraId', 'camera-2')]:
                invalid = dict(capture, **{field: value})
                path.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError):
                    load_capture(path, config(), archive)
            path.write_text(json.dumps(capture))
            (run / 'video.mp4').write_bytes(b'changed')
            with self.assertRaises(ValueError):
                load_capture(path, config(), archive)

    def test_untrusted_model_is_rejected_before_importing_onnx(self):
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as folder:
            path = pathlib.Path(folder) / 'untrusted.onnx'
            path.write_bytes(b'not official ONNX')
            with self.assertRaises(ValueError):
                verify_model(path)

    def test_invalid_or_reused_visit_cannot_claim_two_entries_as_a_pair(self):
        events = [{'type': 'vehicle_entry', 'offsetSeconds': 2, 'confidence': .9, 'visitId': 'visit-1'},
                  {'type': 'vehicle_entry', 'offsetSeconds': 3, 'confidence': .9, 'visitId': 'visit-1'}]
        with self.assertRaises(ValueError):
            make_manifest(config(), 'run-1', 'run-1/video.mp4', 'a' * 64,
                          '2026-11-05T04:00:00Z', 30, 'estimated', events)

    def test_unicode_and_nonexistent_started_at_rejected(self):
        for start in ('2026-11-05T99:00:00Z', '２０２６-11-05T04:00:00Z'):
            with self.assertRaises(ValueError):
                make_manifest(config(), 'run-1', 'run-1/video.mp4', 'a' * 64, start, 30, 'estimated', [])


@unittest.skipUnless(importlib.util.find_spec('numpy'), 'optional numpy unavailable; pure counter tests run without it')
class DetectorSuppressionAcceptance(unittest.TestCase):
    def test_same_vehicle_car_and_truck_boxes_are_not_counted_twice(self):
        import numpy as np
        from video.detector import YoloXDetector
        detector = YoloXDetector.__new__(YoloXDetector)
        detector.np, detector.threshold, detector.nms_threshold = np, .35, .45
        boxes = np.array([[.1, .1, .4, .4], [.1, .1, .4, .4], [.6, .1, .9, .4]])
        detections = detector.select_detections(boxes, np.array([.9, .7, .8]), np.array([2, 7, 7]))
        self.assertEqual([d.class_name for d in detections], ['car', 'truck'])
        self.assertEqual(len(detections), 2)


@unittest.skipUnless(importlib.util.find_spec('cv2') and importlib.util.find_spec('numpy'),
                     'optional OpenCV unavailable; pure counter tests run without it')
class VideoDecodeAcceptance(unittest.TestCase):
    def test_oversized_frame_metadata_rejected_before_decoding(self):
        import cv2
        from unittest.mock import patch
        class OversizedDecoder:
            def isOpened(self):
                return True
            def get(self, key):
                return {cv2.CAP_PROP_FPS: 10, cv2.CAP_PROP_FRAME_COUNT: 40,
                        cv2.CAP_PROP_FRAME_WIDTH: 4000, cv2.CAP_PROP_FRAME_HEIGHT: 4000}.get(key, 0)
            def read(self):
                raise AssertionError('oversized frame must not be allocated')
            def release(self):
                pass
        with patch('cv2.VideoCapture', return_value=OversizedDecoder()), self.assertRaises(ValueError):
            analyze_file('unused-public-fixture.mp4', config(), None, 4)

    def test_real_decoder_stable_person_and_duration_mismatch(self):
        import cv2
        import numpy as np
        class SyntheticPersonDetector:
            def detect(self, frame):
                return [Detection('person', .9, (.2, .2, .4, .6))]
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as folder:
            path = pathlib.Path(folder) / 'video.mp4'
            writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'mp4v'), 10, (160, 120))
            self.assertTrue(writer.isOpened())
            try:
                for _ in range(40):
                    writer.write(np.full((120, 160, 3), 114, dtype=np.uint8))
            finally:
                writer.release()
            events = analyze_file(path, config(), SyntheticPersonDetector(), 4)
            self.assertEqual([event['type'] for event in events], ['first_seen'])
            self.assertEqual(events[0]['offsetSeconds'], 0)
            with self.assertRaises(ValueError):
                analyze_file(path, config(), SyntheticPersonDetector(), 30)

    def test_gate_reference_matching_unknown_and_initial_baseline(self):
        import cv2
        import numpy as np
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as folder:
            directory = pathlib.Path(folder)
            for name, value in [('opened', 0), ('closed', 255)]:
                ok, encoded = cv2.imencode('.png', np.full((64, 64), value, dtype=np.uint8))
                self.assertTrue(ok)
                (directory / f'{name}.png').write_bytes(encoded.tobytes())
            gate = GateTemplates({'roi': [0, 0, 1, 1], 'openedTemplate': 'opened.png',
                                  'closedTemplate': 'closed.png'}, directory)
            self.assertEqual(gate.classify(np.zeros((64, 64, 3), dtype=np.uint8))[0], 'opened')
            self.assertEqual(gate.classify(np.full((64, 64, 3), 255, dtype=np.uint8))[0], 'closed')
            self.assertEqual(gate.classify(np.full((64, 64, 3), 114, dtype=np.uint8)), (None, 0))


if __name__ == '__main__':
    unittest.main()
