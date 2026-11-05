import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStationEventRows, describeAnalysis, recordingAction, reviewEvents, vehicleCounts } from './src/eventsPresentation.js';
import * as presentation from './src/eventsPresentation.js';

const stations = [
  { id: 's1', city: 'Бийск', address: 'Перевозный, 7', manager: 'Анна', region: 'Алтайский край', metrics: { source: 'none' } },
  { id: 's2', city: 'Тула', address: 'Ленина, 12', manager: 'Борис', region: 'Тульская область', metrics: { source: 'demo' } },
];
const event = (id, type, extra = {}) => ({ id, type, stationId: 's2', cameraId: 'c2', time: '09:00', ...extra });

test('station search finds an available station even when it has no analysis or events', () => {
  const rows = buildStationEventRows({ stations, events: [], cameras: [], search: 'перевозный' });
  assert.deepEqual(rows.map(row => row.station.id), ['s1']);
  assert.equal(rows[0].analysis.kind, 'none');
  assert.equal(vehicleCounts(rows[0].events, rows[0].analysis).entries, null);
});

test('manager and geographic region filters use different station fields', () => {
  assert.deepEqual(buildStationEventRows({ stations, search: 'анна' }).map(row => row.station.id), ['s1']);
  assert.deepEqual(buildStationEventRows({ stations, manager: 'Борис', region: 'Тульская область' }).map(row => row.station.id), ['s2']);
  assert.equal(buildStationEventRows({ stations, manager: 'Алтайский край' }).length, 0);
});

test('no analysis is different from an analyzed interval without observed events', () => {
  assert.equal(describeAnalysis([], 'none').kind, 'none');
  assert.equal(describeAnalysis([], undefined).countable, false);
  const analyzed = describeAnalysis([], 'demo');
  assert.equal(analyzed.kind, 'analyzed');
  assert.deepEqual(vehicleCounts([], analyzed), { entries: 0, exits: 0, completed: 0 });
});

test('gaps and unconfirmed coverage cannot produce a false zero', () => {
  const partial = describeAnalysis([event('gap', 'gap')], 'demo');
  assert.equal(partial.kind, 'partial');
  assert.equal(vehicleCounts([], partial).entries, null);
  assert.equal(describeAnalysis([event('open', 'opened')], undefined).kind, 'partial');
});

test('visit pairing preserves camera, local day and explicit visit ID boundaries', () => {
  const rows = buildStationEventRows({ stations, date: '2026-10-30', events: [
    event('entry', 'vehicle_entry', { visitId: 'v', time: '08:00' }),
    event('exit', 'vehicle_exit', { visitId: 'v', time: '08:15' }),
    event('other-camera', 'vehicle_exit', { visitId: 'v', cameraId: 'c3', time: '08:20' }),
    event('other-day', 'vehicle_entry', { visitId: 'v', date: '2026-10-31', time: '08:00' }),
  ] });
  const row = rows.find(item => item.station.id === 's2');
  assert.equal(row.visits.length, 3);
  assert.equal(row.visits.filter(visit => visit.status === 'paired').length, 1);
  assert.deepEqual(row.visits.find(visit => visit.status === 'paired').events.map(item => item.id), ['entry', 'exit']);
});

test('review includes incomplete visits even when input review flags are false', () => {
  const events = [event('entry', 'vehicle_entry', { needsReview: false }), event('gap', 'gap'), event('open', 'opened')];
  assert.deepEqual(reviewEvents(events, '2026-10-30').map(item => item.id), ['entry', 'gap']);
});

test('recording availability does not infer an archive from live availability', () => {
  assert.deepEqual(recordingAction({ archiveAvailable: false, liveAvailable: true }), { label: 'Запись пока недоступна', actionable: false });
  assert.deepEqual(recordingAction({ archiveAvailable: true }), { label: 'Посмотреть момент', actionable: true });
  assert.deepEqual(recordingAction({ liveAvailable: true }), { label: 'Проверить наличие записи', actionable: true });
  assert.equal(recordingAction(null).actionable, false);
});

test('events without an available station retain an honest unidentified group', () => {
  const rows = buildStationEventRows({ stations: [], cameras: [{ id: 'c2', name: 'Пробная камера' }], events: [event('open', 'opened', { stationId: null })] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].station, null);
  assert.equal(rows[0].title, 'ПТО не определён');
  assert.equal(rows[0].events.length, 1);
});

test('each metric shows stations with its observations before searchable stations without results', () => {
  assert.equal(typeof presentation.metricStationRows, 'function');
  const rows = buildStationEventRows({ stations, events: [event('open', 'opened')] });
  assert.deepEqual(presentation.metricStationRows(rows, 'start').map(row => row.id), ['s2', 's1']);
  assert.deepEqual(presentation.metricStationRows(rows, 'closed').map(row => row.id), ['s1', 's2']);
  assert.equal(rows[0].id, 's1');
});
