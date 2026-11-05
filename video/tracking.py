"""Conservative, dependency-free observations within ONE partial video fragment.

No identity inference or cross-gap reidentification. Coordinates are normalized.
One missed sample retires a track; ambiguous associations retire both hypotheses.
"""
from dataclasses import dataclass
from math import hypot, isfinite

VEHICLES = frozenset(('car', 'motorcycle', 'bus', 'truck'))


@dataclass(frozen=True)
class Detection:
    class_name: str
    confidence: float
    bbox: tuple

    @property
    def anchor(self):
        return ((self.bbox[0] + self.bbox[2]) / 2, self.bbox[3])


def in_polygon(point, polygon):
    """Ray casting, with polygon boundaries included."""
    x, y = point
    inside = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0])
        if abs(cross) < 1e-10 and min(a[0], b[0]) <= x <= max(a[0], b[0]) and min(a[1], b[1]) <= y <= max(a[1], b[1]):
            return True
        if (a[1] > y) != (b[1] > y):
            if x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
                inside = not inside
    return inside


def _distance(a, b):
    return hypot(a[0] - b[0], a[1] - b[1])


@dataclass
class _Track:
    number: int
    detection: Detection
    first_offset: float
    hits: int = 0
    stable_side: int = 0
    candidate_side: int = 0
    side_hits: int = 0
    previous_point: tuple | None = None
    crossing_side: int = 0
    entry_event: dict | None = None


class GateDebouncer:
    """Unknown frames reset the candidate. First known baseline emits no event."""
    def __init__(self, stable_samples=3):
        if not isinstance(stable_samples, int) or stable_samples < 2:
            raise ValueError('gate stable_samples must be >=2')
        self.required = stable_samples
        self.baseline = None
        self.candidate = None
        self.count = 0
        self.confidence = 1.0

    def update(self, state, confidence):
        if state not in ('opened', 'closed'):
            self.candidate, self.count = None, 0
            return None
        if not isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError('invalid gate confidence')
        if state == self.candidate:
            self.count += 1
            self.confidence = min(self.confidence, confidence)
        else:
            self.candidate, self.count, self.confidence = state, 1, confidence
        if self.count < self.required or state == self.baseline:
            return None
        previous, self.baseline = self.baseline, state
        if previous is None:
            return None
        return {'type': state, 'confidence': self.confidence, 'visitId': None, 'needsReview': True}


class ObservationEngine:
    def __init__(self, camera_config):
        self.config = camera_config
        cfg = camera_config['analysis']
        tracking = cfg.get('tracking', {})
        self.minimum_hits = tracking.get('minTrackHits', 3)
        self.side_samples = tracking.get('sideStableSamples', 2)
        self.margin = tracking.get('lineMargin', .025)
        self.maximum_distance = tracking.get('maxDistance', .2)
        self.maximum_gap = cfg['sampleIntervalSeconds'] * 1.75
        self.line = cfg['line']
        self.tracks = []
        self.events = []
        self.last_offset = None
        self.next_track = 1
        self.first_person = False

    def _signed_distance(self, point):
        a, b = self.line['start'], self.line['end']
        return ((b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])) / _distance(a, b)

    def _side(self, point):
        value = self._signed_distance(point)
        return 1 if value > self.margin else -1 if value < -self.margin else 0

    def _crosses_segment(self, old, new):
        a, b = self.line['start'], self.line['end']
        # Old and new have opposite signs, so intersection of their segment
        # with the infinite line exists. Check its projection on the finite line.
        vx, vy = b[0] - a[0], b[1] - a[1]
        d0 = vx * (old[1] - a[1]) - vy * (old[0] - a[0])
        d1 = vx * (new[1] - a[1]) - vy * (new[0] - a[0])
        if abs(d0 - d1) < 1e-12:
            return False
        ratio = d0 / (d0 - d1)
        intersection = (old[0] + ratio * (new[0] - old[0]), old[1] + ratio * (new[1] - old[1]))
        projection = ((intersection[0] - a[0]) * vx + (intersection[1] - a[1]) * vy) / (vx * vx + vy * vy)
        return 0 <= ratio <= 1 and 0 <= projection <= 1

    def _observe(self, track, offset):
        track.hits += 1
        detection = track.detection
        if detection.class_name == 'person':
            if not self.first_person and track.hits >= self.minimum_hits:
                self.first_person = True
                self.events.append({'type': 'first_seen', 'offsetSeconds': track.first_offset,
                                    'confidence': detection.confidence, 'visitId': None})
            return
        if not self.config['primary']:
            return
        previous = track.previous_point
        track.previous_point = detection.anchor
        if previous is not None and track.stable_side:
            d0 = self._signed_distance(previous)
            d1 = self._signed_distance(detection.anchor)
            if d0 * d1 <= 0 and abs(d0 - d1) > 1e-12 and d1 != 0:
                # Validate the actual consecutive trajectory segment at the
                # crossing. A later confirmation point must never create an
                # imaginary chord through the finite line. This also retains
                # crossings inside the neutral margin until side confirmation.
                track.crossing_side = (1 if d1 > 0 else -1) if self._crosses_segment(previous, detection.anchor) else 0
        side = self._side(detection.anchor)
        if side == 0:
            track.candidate_side, track.side_hits = 0, 0
            return
        if side == track.candidate_side:
            track.side_hits += 1
        else:
            track.candidate_side, track.side_hits = side, 1
        if track.hits < self.minimum_hits or track.side_hits < self.side_samples:
            return
        old_side = track.stable_side
        if not old_side or old_side == side:
            track.stable_side, track.crossing_side = side, 0
            return
        crossing = track.crossing_side == side
        track.stable_side, track.crossing_side = side, 0
        if not crossing:
            return
        positive_entry = self.line['entryDirection'] == 'positive_to_negative'
        entering = (old_side == 1) == positive_entry
        event = {'type': 'vehicle_entry' if entering else 'vehicle_exit',
                 'offsetSeconds': offset, 'confidence': detection.confidence, 'visitId': None}
        if entering:
            track.entry_event = event
        elif track.entry_event is not None:
            visit_id = f"visit-{track.number}-{len(self.events) + 1}"
            event['visitId'] = track.entry_event['visitId'] = visit_id
            track.entry_event = None
        self.events.append(event)

    def update(self, offset_seconds, detections):
        if not isfinite(offset_seconds) or offset_seconds < 0:
            raise ValueError('invalid observation offset')
        if self.last_offset is not None:
            if offset_seconds <= self.last_offset:
                raise ValueError('observations must have increasing offsets')
            if offset_seconds - self.last_offset > self.maximum_gap:
                self.tracks = []
        self.last_offset = offset_seconds
        accepted = []
        for detection in detections:
            if detection.class_name not in VEHICLES | {'person'}:
                continue
            box = detection.bbox
            if len(box) != 4 or not all(isfinite(v) and 0 <= v <= 1 for v in box):
                raise ValueError('detection coordinates must be normalized')
            if box[0] >= box[2] or box[1] >= box[3] or not isfinite(detection.confidence) or not 0 <= detection.confidence <= 1:
                raise ValueError('invalid detection')
            zone = self.config['analysis']['personZone' if detection.class_name == 'person' else 'vehicleZone']
            if in_polygon(detection.anchor, zone):
                accepted.append(detection)
        # A mutual unique candidate is conservative and avoids assigning an
        # arbitrary identity when two vehicles are close. Lost tracks expire now.
        candidates = {}
        reverse = {}
        for i, track in enumerate(self.tracks):
            for j, detection in enumerate(accepted):
                if track.detection.class_name == detection.class_name and _distance(track.detection.anchor, detection.anchor) <= self.maximum_distance:
                    candidates.setdefault(i, []).append(j)
                    reverse.setdefault(j, []).append(i)
        current = []
        for j, detection in enumerate(accepted):
            matches = reverse.get(j, [])
            if len(matches) == 1 and len(candidates[matches[0]]) == 1:
                track = self.tracks[matches[0]]
                track.detection = detection
            else:
                track = _Track(self.next_track, detection, offset_seconds)
                self.next_track += 1
            self._observe(track, offset_seconds)
            current.append(track)
        self.tracks = current
        return self.events
