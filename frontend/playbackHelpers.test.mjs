import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveDateLabel, buildVisits, eventArchiveRange, playbackBounds, secondsOf } from './src/playbackHelpers.js';

const event = (id, type, cameraId, visitId, time) => ({ id, type, cameraId, visitId, time, stationId: 'station' });
test('only matching visit ID within the same camera is a completed visit', () => {
  const rows = buildVisits([event('e', 'vehicle_entry', 'a', 'v', '08:00'), event('x', 'vehicle_exit', 'a', 'v', '08:15')], '2026-10-30');
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'paired'); assert.equal(rows[0].durationSeconds, 900);
});
test('different cameras or absent IDs are not inferred into pairs', () => {
  const rows = buildVisits([event('e', 'vehicle_entry', 'a', 'v', '08:00'), event('x', 'vehicle_exit', 'b', 'v', '08:15'), event('e2', 'vehicle_entry', 'c', null, '09:00'), event('x2', 'vehicle_exit', 'c', null, '09:10')]);
  assert.equal(rows.length, 4); assert.ok(rows.every(row => row.status !== 'paired'));
});
test('duplicate entries and reversed chronology remain separate observations', () => {
  const rows = buildVisits([event('e', 'vehicle_entry', 'a', 'v', '08:00'), event('e2', 'vehicle_entry', 'a', 'v', '08:01'), event('x', 'vehicle_exit', 'a', 'v', '08:15'), event('e3', 'vehicle_entry', 'b', 'v', '10:00'), event('x3', 'vehicle_exit', 'b', 'v', '09:00')]);
  assert.equal(rows.length, 5); assert.ok(rows.every(row => row.durationSeconds === null));
});
test('same visit on different local days is not paired', () => {
  assert.equal(buildVisits([event('e', 'vehicle_entry', 'a', 'v', '2026-10-30T08:00:00'), event('x', 'vehicle_exit', 'a', 'v', '2026-10-31T08:15:00')]).length, 2);
});
test('singleton entry and exit always require review even if source flags are false', () => {
  const rows = buildVisits([
    { ...event('single-entry', 'vehicle_entry', 'a', 'entry-visit', '08:00'), needsReview: false },
    { ...event('single-exit', 'vehicle_exit', 'a', 'exit-visit', '08:15'), needsReview: false },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.status), ['entry_only', 'exit_only']);
  assert.ok(rows.every(row => row.needsReview === true && row.durationSeconds === null));
});
test('playback bounds seek to exact sample offset and clamp the end', () => {
  assert.deepEqual(playbackBounds({ startOffsetSeconds: 2, endOffsetSeconds: 20 }, 10.35), { start: 2, end: 10.35 });
  assert.equal(playbackBounds({ startOffsetSeconds: 12, endOffsetSeconds: 20 }, 10.35), null);
});
test('event archive request uses local day and does not cross midnight', () => {
  assert.deepEqual(eventArchiveRange('2026-10-30T12:21:28', '2026-01-01'), { date: '2026-10-30', from: '12:21:28', to: '12:21:58' });
  assert.equal(eventArchiveRange('23:59:45', '2026-10-30').to, '23:59:59');
  assert.equal(secondsOf('12:21:38.350'), 44498.35);
});
test('unconnected camera without actual sample has no claimed recording date', () => {
  assert.equal(archiveDateLabel({ archive: { status: 'not_connected', timeBasis: 'camera_local_unverified', sampleRange: null } }), null);
});
test('recording date is taken from an actual sample or returned record', () => {
  assert.equal(archiveDateLabel({ archive: { sampleRange: { date: '2026-10-30' } } }), '30.10.2026');
  assert.equal(archiveDateLabel({}, [{ startAt: '2026-11-03T12:00:00' }]), '03.11.2026');
});
