"""Offline bounded-fragment video analysis. Never connects to a camera or API.

Use ``python -m video.analysis --help``. Zones and line coordinates are normalized;
line directions use the oriented cross product of start→end and the object anchor.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .tracking import GateDebouncer, ObservationEngine

PIPELINE_VERSION = 'yolox-nano-v1'
MAX_BYTES = 256 * 1024 * 1024
MAX_DURATION = 900
MAX_EVENTS = 2000
MAX_MANIFEST_BYTES = 256 * 1024
IDENTIFIER = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$')
EVENT_TYPES = frozenset(('first_seen', 'vehicle_entry', 'vehicle_exit', 'opened', 'closed'))


def _number(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'invalid {name}')
    return value


def _identifier(value, name='identifier', maximum=80):
    if not isinstance(value, str) or len(value) > maximum or not IDENTIFIER.fullmatch(value):
        raise ValueError(f'invalid {name}')
    return value


def _point(value):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ValueError('invalid normalized point')
    return tuple(_number(v, 0, 1, 'coordinate') for v in value)


def _polygon(value):
    if not isinstance(value, list) or not 3 <= len(value) <= 32:
        raise ValueError('zone needs 3..32 normalized points')
    points = [_point(p) for p in value]
    area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1]))
    if abs(area) < .00001:
        raise ValueError('zone has zero area')


def _load_json(path, limit=65536):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError('invalid or oversized JSON file')
    try:
        obj = json.loads(path.read_text(encoding='utf-8-sig'))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('invalid JSON') from exc
    if not isinstance(obj, dict):
        raise ValueError('JSON must be an object')
    return obj


def load_camera_config(source):
    config = _load_json(source) if not isinstance(source, dict) else source
    for key in ('cameraId', 'stationId', 'mappingVersion'):
        _identifier(config.get(key), key)
    zone = config.get('timezone')
    if not isinstance(zone, str) or '/' not in zone or len(zone) > 100:
        raise ValueError('IANA timezone required')
    try:
        ZoneInfo(zone)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise ValueError('unknown IANA timezone; install tzdata on Windows') from exc
    if not isinstance(config.get('primary'), bool):
        raise ValueError('primary must be explicitly true or false')
    analysis = config.get('analysis')
    if not isinstance(analysis, dict):
        raise ValueError('explicit camera analysis settings required')
    _number(analysis.get('sampleIntervalSeconds'), .1, 5, 'sample interval')
    for key in ('personZone', 'vehicleZone'):
        _polygon(analysis.get(key))
    line = analysis.get('line')
    if not isinstance(line, dict):
        raise ValueError('explicit counting line required')
    start, end = _point(line.get('start')), _point(line.get('end'))
    if math.dist(start, end) < .05:
        raise ValueError('counting line too short')
    if line.get('entryDirection') not in ('positive_to_negative', 'negative_to_positive'):
        raise ValueError('explicit entryDirection required')
    tracking = analysis.get('tracking', {})
    if not isinstance(tracking, dict):
        raise ValueError('invalid tracking settings')
    for key, default in [('minTrackHits', 3), ('sideStableSamples', 2)]:
        value = tracking.get(key, default)
        if not isinstance(value, int) or isinstance(value, bool) or not 2 <= value <= 30:
            raise ValueError('invalid track stability')
    _number(tracking.get('lineMargin', .025), .001, .2, 'line margin')
    _number(tracking.get('maxDistance', .2), .01, .5, 'maximum association distance')
    gate = analysis.get('gate')
    if gate is not None:
        if not isinstance(gate, dict):
            raise ValueError('invalid gate settings')
        roi = gate.get('roi')
        if not isinstance(roi, list) or len(roi) != 4:
            raise ValueError('gate ROI needs [left,top,right,bottom]')
        for v in roi:
            _number(v, 0, 1, 'ROI coordinate')
        if roi[0] >= roi[2] or roi[1] >= roi[3]:
            raise ValueError('invalid gate ROI')
        for key in ('openedTemplate', 'closedTemplate'):
            if not isinstance(gate.get(key), str) or not gate[key]:
                raise ValueError('gate needs private ROI reference images')
        for key, default in [('maxMeanError', .08), ('minErrorSeparation', .03)]:
            _number(gate.get(key, default), .001, .5, key)
        value = gate.get('stableSamples', 3)
        if not isinstance(value, int) or isinstance(value, bool) or not 2 <= value <= 30:
            raise ValueError('invalid gate stability')
    return config


def _utc(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z', value):
        raise ValueError('UTC timestamp with Z required')
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ValueError('invalid UTC timestamp') from exc


def _iso(value):
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def file_sha256(path):
    hasher = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def archive_video(archive_root, run_id, relative_file):
    _identifier(run_id, 'runId', 40)
    if relative_file != f'{run_id}/video.mp4':
        raise ValueError('recording must be runId/video.mp4')
    root = Path(archive_root).resolve(strict=True)
    run_path = root / run_id
    video = run_path / 'video.mp4'
    if run_path.is_symlink() or video.is_symlink() or not video.is_file() or not video.resolve().is_relative_to(root):
        raise ValueError('recording outside archive or not a regular file')
    if not 0 < video.stat().st_size <= MAX_BYTES:
        raise ValueError('recording is empty or exceeds 256MiB')
    return video


def make_manifest(config, run_id, relative_file, sha256, started_at, duration_seconds, timing, events):
    load_camera_config(config)
    _identifier(run_id, 'runId', 40)
    if relative_file != f'{run_id}/video.mp4':
        raise ValueError('recording must be runId/video.mp4')
    if not isinstance(sha256, str) or not re.fullmatch('[0-9a-f]{64}', sha256):
        raise ValueError('invalid recording SHA256')
    start = _utc(started_at)
    _number(duration_seconds, .001, MAX_DURATION, 'duration')
    if timing not in ('estimated', 'verified'):
        raise ValueError('timing must be explicit estimated or verified')
    if not isinstance(events, list) or len(events) > MAX_EVENTS:
        raise ValueError('too many events')
    manifest = {
        'schemaVersion': 1, 'runId': run_id, 'pipelineVersion': PIPELINE_VERSION,
        **{k: config[k] for k in ('cameraId', 'stationId', 'mappingVersion', 'timezone')},
        'generatedAt': _iso(datetime.now(timezone.utc)),
        'recording': {'id': run_id, 'file': relative_file, 'sha256': sha256,
                      'startedAt': _iso(start), 'durationSeconds': duration_seconds, 'timing': timing},
        'coverage': {'status': 'partial', 'sampleIntervalSeconds': config['analysis']['sampleIntervalSeconds']},
        'events': [],
    }
    for index, event in enumerate(sorted(events, key=lambda e: e['offsetSeconds']), 1):
        kind = event.get('type')
        if kind not in EVENT_TYPES:
            raise ValueError('unknown event type')
        offset = _number(event.get('offsetSeconds'), 0, duration_seconds, 'event offset')
        confidence = _number(event.get('confidence'), 0, 1, 'confidence')
        visit = event.get('visitId')
        if visit is not None:
            _identifier(visit, 'visitId', 35)
            if kind not in ('vehicle_entry', 'vehicle_exit'):
                raise ValueError('visit only applies to vehicle crossings')
            visit = f'{run_id}-{visit}'
        manifest['events'].append({
            'id': f'{run_id}-event-{index}', 'type': kind,
            'occurredAtUtc': _iso(start + timedelta(seconds=offset)),
            'confidence': confidence, 'visitId': visit, 'needsReview': True,
            'evidence': {'recordingId': run_id, 'offsetSeconds': offset},
        })
    paired = {}
    for event in manifest['events']:
        if event['visitId']:
            paired.setdefault(event['visitId'], []).append(event)
    for pair in paired.values():
        if len(pair) != 2 or [e['type'] for e in pair] != ['vehicle_entry', 'vehicle_exit'] or pair[0]['evidence']['offsetSeconds'] >= pair[1]['evidence']['offsetSeconds']:
            raise ValueError('visitId requires one ordered entry/exit pair')
    return manifest


def load_capture(path, config, archive_root):
    capture = _load_json(path)
    if capture.get('schemaVersion') != 1 or capture.get('status') != 'complete':
        raise ValueError('only completed v1 captures can be analyzed')
    for key in ('cameraId', 'stationId', 'mappingVersion', 'timezone'):
        if capture.get(key) != config[key]:
            raise ValueError('capture camera mapping mismatch')
    record = capture.get('recording')
    if not isinstance(record, dict) or record.get('id') != capture.get('runId'):
        raise ValueError('invalid capture recording')
    make_manifest(config, capture['runId'], record.get('file'), record.get('sha256'),
                  record.get('startedAt'), record.get('durationSeconds'), record.get('timing'), [])
    video = archive_video(archive_root, capture['runId'], record['file'])
    if Path(path).resolve().parent != video.parent:
        raise ValueError('capture must be adjacent to its recording')
    if file_sha256(video) != record['sha256']:
        raise ValueError('capture recording hash mismatch')
    return capture


def publish_manifest(results_dir, manifest):
    """Publish complete JSON atomically, never overwrite a published run."""
    results = Path(results_dir)
    results.mkdir(parents=True, exist_ok=True)
    _identifier(manifest['runId'], 'runId', 40)
    data = json.dumps(manifest, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    if len(data) > MAX_MANIFEST_BYTES:
        raise ValueError('manifest exceeds 256KiB')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='wb', prefix='.analysis-', suffix='.tmp', dir=results, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        output = results / f"{manifest['runId']}.json"
        if os.name == 'nt':
            # Windows rename is atomic and fails if the destination exists.
            # It also works in restricted environments without hardlink rights.
            os.rename(temporary, output)
        else:
            # POSIX rename would overwrite; link gives atomic exclusive publish.
            os.link(temporary, output)
        return output
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class GateTemplates:
    """Optional whole-ROI reference matching; conservative unknown on poor match.

    Private templates must be CROPPED to the configured ROI, same viewpoint and
    lighting. Confidence is a similarity heuristic, not a calibrated probability.
    """
    def __init__(self, settings, config_directory):
        import cv2
        import numpy as np
        self.settings = settings
        self.templates = {}
        for state, key in [('opened', 'openedTemplate'), ('closed', 'closedTemplate')]:
            path = Path(settings[key])
            if not path.is_absolute():
                path = config_directory / path
            if not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
                raise ValueError('missing or oversized gate template')
            # Python handles Unicode paths consistently on Windows; OpenCV's
            # narrow-character imread can fail and expose private paths in logs.
            reference = cv2.imdecode(np.frombuffer(path.read_bytes(), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
            if reference is None:
                raise ValueError('invalid gate template image')
            self.templates[state] = cv2.resize(reference, (64, 64)).astype('float32') / 255
        separation = float(np.abs(self.templates['opened'] - self.templates['closed']).mean())
        if separation < settings.get('minErrorSeparation', .03) * 2:
            raise ValueError('gate references are insufficiently distinct')

    def classify(self, frame):
        import cv2
        import numpy as np
        height, width = frame.shape[:2]
        a, b, c, d = self.settings['roi']
        crop = frame[int(b * height):int(d * height), int(a * width):int(c * width)]
        if crop.size == 0:
            return None, 0
        sample = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), (64, 64)).astype('float32') / 255
        errors = sorted((float(np.abs(sample - reference).mean()), state) for state, reference in self.templates.items())
        if errors[0][0] > self.settings.get('maxMeanError', .08) or errors[1][0] - errors[0][0] < self.settings.get('minErrorSeparation', .03):
            return None, 0
        return errors[0][1], max(0, min(1, 1 - errors[0][0]))


def analyze_file(video_path, config, detector, expected_duration, config_directory=Path('.')):
    """Decode every frame to EOF, sample inference; incomplete/decode mismatch fails.

    The sample interval is recorded. A sampling interval can miss short crossings;
    it is not full continuous surveillance or a guarantee of tracking identity.
    """
    import cv2
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        capture.release()
        raise ValueError('cannot decode recording')
    engine = ObservationEngine(config)
    settings = config['analysis']
    interval = settings['sampleIntervalSeconds']
    gate_settings = settings.get('gate')
    frame_count, next_sample, previous_timestamp = 0, 0.0, None
    try:
        gate = GateTemplates(gate_settings, config_directory) if gate_settings else None
        debounce = GateDebouncer(gate_settings.get('stableSamples', 3)) if gate else None
        fps = capture.get(cv2.CAP_PROP_FPS)
        reported_count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
        width = capture.get(cv2.CAP_PROP_FRAME_WIDTH)
        height = capture.get(cv2.CAP_PROP_FRAME_HEIGHT)
        if not math.isfinite(width) or not math.isfinite(height) or not 1 <= width <= 3840 or not 1 <= height <= 2160:
            raise ValueError('recording exceeds 3840x2160 frame budget')
        if not math.isfinite(fps) or not .5 <= fps <= 120:
            raise ValueError('invalid recording frame rate')
        if not math.isfinite(reported_count) or reported_count <= 0:
            raise ValueError('invalid recording frame count')
        if abs(reported_count / fps - expected_duration) > max(.5, expected_duration * .03):
            raise ValueError('recording duration disagrees with capture metadata')
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            offset = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            # FFmpeg-generated fixed-fps captures have usable PTS. Missing PTS
            # cannot silently become verified timing; reject rather than invent.
            if not math.isfinite(offset) or offset < 0 or (previous_timestamp is not None and offset <= previous_timestamp):
                raise ValueError('missing or nonmonotonic video timestamps')
            previous_timestamp = offset
            frame_count += 1
            if offset > expected_duration + .5 or frame_count > 120 * MAX_DURATION:
                raise ValueError('recording exceeds declared duration or frame budget')
            if offset + 1e-7 < next_sample:
                continue
            if offset >= expected_duration:
                continue
            if frame.shape[0] > 2160 or frame.shape[1] > 3840:
                raise ValueError('recording exceeds 3840x2160 frame budget')
            engine.update(offset, detector.detect(frame))
            if gate:
                state, confidence = gate.classify(frame)
                event = debounce.update(state, confidence)
                if event:
                    event['offsetSeconds'] = offset
                    engine.events.append(event)
            if len(engine.events) > MAX_EVENTS:
                raise ValueError('analysis exceeds event budget')
            next_sample = offset + interval
        if frame_count == 0 or abs(frame_count - reported_count) > 1 or abs(frame_count / fps - expected_duration) > max(.5, expected_duration * .03):
            raise ValueError('recording incomplete or decoding failed')
        return engine.events
    finally:
        capture.release()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True, help='private single-camera JSON with explicit zones/line/timezone/mapping')
    parser.add_argument('--archive-root', type=Path, required=True)
    parser.add_argument('--results-dir', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True, help='official SHA256-pinned YOLOX Nano ONNX, fetched separately')
    parser.add_argument('--capture', type=Path, help='completed collector capture.json')
    parser.add_argument('--run-id', help='explicit existing archive run directory; required without --capture')
    parser.add_argument('--started-at', help='explicit UTC start with Z; required without --capture')
    parser.add_argument('--timing', choices=('estimated', 'verified'), help='required without --capture; verified is operator assertion, not camera clock validation')
    parser.add_argument('--duration-seconds', type=float, help='known/ffprobe duration; required without --capture')
    parser.add_argument('--score-threshold', type=float, default=.35)
    args = parser.parse_args(argv)
    try:
        config = load_camera_config(args.config)
        if args.capture:
            if any(value is not None for value in (args.run_id, args.started_at, args.timing, args.duration_seconds)):
                raise ValueError('capture mode cannot override capture metadata')
            metadata = load_capture(args.capture, config, args.archive_root)
            run_id, record = metadata['runId'], metadata['recording']
        else:
            if any(value is None for value in (args.run_id, args.started_at, args.timing, args.duration_seconds)):
                raise ValueError('recorded file mode requires run-id/started-at/timing/duration-seconds')
            run_id = args.run_id
            video = archive_video(args.archive_root, run_id, f'{run_id}/video.mp4')
            record = {'file': f'{run_id}/video.mp4', 'sha256': file_sha256(video),
                      'startedAt': args.started_at, 'durationSeconds': args.duration_seconds, 'timing': args.timing}
        make_manifest(config, run_id, record['file'], record['sha256'], record['startedAt'], record['durationSeconds'], record['timing'], [])
        video = archive_video(args.archive_root, run_id, record['file'])
        if (args.results_dir / f'{run_id}.json').exists():
            raise FileExistsError('analysis run already published')
        from .detector import YoloXDetector
        detector = YoloXDetector(args.model, score_threshold=args.score_threshold)
        events = analyze_file(video, config, detector, record['durationSeconds'], args.config.resolve().parent)
        if file_sha256(video) != record['sha256']:
            raise ValueError('recording changed during analysis')
        result = make_manifest(config, run_id, record['file'], record['sha256'], record['startedAt'],
                               record['durationSeconds'], record['timing'], events)
        publish_manifest(args.results_dir, result)
        print(json.dumps({'runId': run_id, 'status': 'complete', 'events': len(events),
                          'coverage': 'partial', 'timing': record['timing'], 'pipelineVersion': PIPELINE_VERSION}))
        return 0
    except Exception:
        # Deliberately no private paths, exception dumps, credentials or image
        # contents in process logs. Operator can reproduce with public fixtures.
        print(json.dumps({'status': 'failed', 'message': 'analysis failed; check private config, completed file, timestamps, dependencies and pinned model'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
