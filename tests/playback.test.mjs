import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../backend/app.mjs';
import * as demo from '../backend/demo.mjs';

const stations = Array.from({ length: 12 }, (_, i) => ({
  id: `station-${i + 1}`, city: ['Екатеринбург', 'Новосибирск', 'Краснодар', 'Москва', 'Тула'][i % 5],
  region: 'Тестовый регион', address: `Тестовая улица, ${i + 1}`, manager: 'Тестовый руководитель',
}));
const accounts = {
  admin: { email: 'admin@ekosmotr.local', password: 'Pilot-Admin-2026!' },
  director: { email: 'director@ekosmotr.local', password: 'Pilot-Director-2026!' },
  regional: { email: 'regional@ekosmotr.local', password: 'Pilot-Region-2026!' },
};
const search = (cameraId = 'probe-c300', date = '2026-10-30', from = '12:21:20', to = '12:22:00') =>
  `/api/archive?${new URLSearchParams({ cameraId, date, from, to })}`;

async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'camera-pilot-playback-'));
  let handler, server;
  try {
    const stationFile = path.join(dir, 'stations.json'), mediaFile = path.join(dir, 'probe.mp4');
    await writeFile(stationFile, JSON.stringify(stations));
    // Synthetic bytes test HTTP seek/range handling; never stand in for the real probe in the app.
    if (options.media !== false) await writeFile(mediaFile, '0123456789');
    let inventoryFile;
    if (options.inventory !== undefined) {
      inventoryFile = path.join(dir, 'inventory.json');
      await writeFile(inventoryFile, JSON.stringify(options.inventory));
    }
    handler = createApp({ dbPath: path.join(dir, 'test.sqlite'), stationFile,
      mediaFile: options.media === false ? undefined : mediaFile, inventoryFile });
    server = createServer(handler);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (url, session, options = {}) => {
      const headers = { ...options.headers };
      if (session) { headers.Cookie = session.cookie; headers['X-CSRF-Token'] = session.csrfToken; }
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + url, { method: options.method || 'GET', headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body) });
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers,
        body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : bytes };
    };
    const login = async role => {
      const result = await request('/api/login', null, { method: 'POST', body: typeof role === 'string' ? accounts[role] : role });
      assert.equal(result.status, 200);
      return { ...result.body, cookie: result.headers.get('set-cookie').split(';')[0] };
    };
    return { request, login, async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      handler.close();
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
      assert.match(path.basename(dir), /^camera-pilot-playback-/);
      await rm(dir, { recursive: true, force: true });
    } };
  } catch (error) { handler?.close(); throw error; }
}
async function using(options, fn) { const f = await fixture(options); try { await fn(f); } finally { await f.close(); } }

test('demo entries and exits share visits, occur in order and agree with all camera totals', () => {
  const { cameras, events } = demo.makeDemo(stations);
  for (const camera of cameras.filter(c => c.status === 'demo')) {
    const own = events.filter(e => e.cameraId === camera.id);
    const entries = own.filter(e => e.type === 'vehicle_entry'), exits = own.filter(e => e.type === 'vehicle_exit');
    assert.equal(exits.length, entries.length, 'demo must include explicit paired exits');
    assert.equal(camera.metrics.exits, entries.length);
    assert.equal(camera.metrics.completedVisits, entries.length);
    for (const entry of entries) {
      assert.ok(entry.visitId);
      const exit = exits.find(e => e.visitId === entry.visitId);
      assert.ok(exit && exit.time > entry.time);
      assert.equal(exit.source, 'demo');
    }
  }
});

test('visit builder preserves unmatched observations and never pairs across camera or invalid time order', () => {
  assert.equal(typeof demo.buildVisits, 'function');
  const event = (id, type, cameraId, time, visitId = 'same') => ({ id, type, cameraId, time, visitId,
    stationId: cameraId, source: 'demo', needsReview: false });
  const observations = [event('a', 'vehicle_entry', 'a', '08:00'), event('b', 'vehicle_exit', 'b', '08:10'),
    event('c', 'vehicle_entry', 'c', '08:20'), event('d', 'vehicle_exit', 'c', '08:10'),
    event('e', 'vehicle_entry', 'd', '09:00', 'paired'), event('f', 'vehicle_exit', 'd', '09:15', 'paired'),
    event('g', 'vehicle_entry', 'e', '09:00', null), event('h', 'vehicle_exit', 'e', '09:10', null)];
  const visits = demo.buildVisits(observations);
  assert.equal(visits.filter(v => v.status === 'paired').length, 1);
  assert.equal(visits.find(v => v.status === 'paired').durationMinutes, 15);
  assert.equal(visits.filter(v => v.status !== 'paired').length, 6);
  assert.ok(visits.filter(v => v.status !== 'paired').every(v => v.needsReview && v.durationMinutes === null));
});

test('playback and archive require authentication and use identical missing/forbidden camera denials', async () => {
  await using({}, async f => {
    for (const route of ['/api/visits', '/api/cameras/probe-c300/playback', search()])
      assert.equal((await f.request(route)).status, 401);
    const regional = await f.login('regional');
    const director = await f.login('director');
    for (const session of [regional, director]) {
      const probe = await f.request('/api/cameras/probe-c300/playback', session);
      const absent = await f.request('/api/cameras/missing-camera/playback', session);
      assert.equal(probe.status, 403);
      assert.deepEqual(absent.body, probe.body);
      assert.deepEqual((await f.request(search(), session)).body, probe.body);
      assert.deepEqual((await f.request(search('missing-camera'), session)).body, probe.body);
    }
  });
});

test('probe playback is recorded archive only, has a valid searchable sample and clamps to the 10.35 second file', async () => {
  await using({}, async f => {
    const admin = await f.login('admin');
    const playback = await f.request('/api/cameras/probe-c300/playback', admin);
    assert.equal(playback.status, 200);
    assert.deepEqual({ status: playback.body.live.status, url: playback.body.live.url }, { status: 'not_connected', url: null });
    assert.equal(playback.body.archive.timeBasis, 'camera_local_unverified');
    assert.deepEqual(playback.body.archive.days, ['2026-10-30']);
    const sample = playback.body.archive.sampleRange;
    const found = await f.request(search('probe-c300', sample.date, sample.from, sample.to), admin);
    assert.equal(found.status, 200);
    assert.equal(found.body.status, 'available');
    assert.equal(found.body.records.length, 1);
    const record = found.body.records[0];
    assert.equal(record.startAt, '2026-10-30T12:21:28');
    assert.equal(record.endAt, '2026-10-30T12:21:38.350');
    assert.equal(record.startOffsetSeconds, 0);
    assert.equal(record.endOffsetSeconds, 10.35);
    assert.equal(record.durationSeconds, 10.35);
    assert.equal(record.source, 'recorded_probe');
    assert.ok(!/[zZ]|[+]\d\d:\d\d$/.test(record.endAt), 'unknown timezone must not be asserted');
    const range = await f.request(record.mediaUrl, admin, { headers: { Range: 'bytes=3-6' } });
    assert.equal(range.status, 206);
    assert.equal(range.body.toString(), '3456');
    assert.equal(range.headers.get('content-range'), 'bytes 3-6/10');
  });
});

test('archive search intersects exact offsets and distinguishes connected empty intervals from unconnected archive', async () => {
  await using({}, async f => {
    const admin = await f.login('admin');
    const result = await f.request(search('probe-c300', '2026-10-30', '12:21:30', '12:21:35'), admin);
    assert.equal(result.status, 200);
    assert.equal(result.body.records[0].startOffsetSeconds, 2);
    assert.equal(result.body.records[0].endOffsetSeconds, 7);
    assert.equal(result.body.records[0].durationSeconds, 5);
    for (const route of [search('probe-c300', '2026-10-29'), search('probe-c300', '2026-10-30', '12:20', '12:21:28'),
      search('probe-c300', '2026-10-30', '12:21:39', '12:22')]) {
      const result = await f.request(route, admin);
      assert.equal(result.status, 200);
      assert.equal(result.body.status, 'empty');
      assert.deepEqual(result.body.records, []);
    }
    const unconnected = await f.request(search('demo-1'), admin);
    assert.equal(unconnected.body.status, 'not_connected');
    assert.deepEqual(unconnected.body.records, []);
    const live = await f.request('/api/cameras/demo-1/playback', admin);
    assert.equal(live.body.live.url, null);
    assert.equal(live.body.archive.status, 'not_connected');
    assert.deepEqual(live.body.archive.days, []);
  });
});

test('archive rejects missing and malformed date/time or nonincreasing intervals', async () => {
  await using({}, async f => {
    const admin = await f.login('admin');
    const invalid = [
      '/api/archive', '/api/archive?cameraId=probe-c300',
      search('probe-c300', '2026-02-30'), search('probe-c300', '2026-13-01'), search('probe-c300', '2026-1-01'),
      search('probe-c300', '2026-10-30', '24:00', '25:00'), search('probe-c300', '2026-10-30', '12:60', '13:00'),
      search('probe-c300', '2026-10-30', '12:21:60', '12:22'), search('probe-c300', '2026-10-30', '12:21:28.1', '12:22'),
      search('probe-c300', '2026-10-30', '8:00', '09:00'), search('probe-c300', '2026-10-30', '12:22', '12:22'),
      search('probe-c300', '2026-10-30', '23:00', '01:00'),
      `${search()}&from=12:21:30`, `${search()}&date=2026-10-31`,
    ];
    for (const route of invalid) assert.equal((await f.request(route, admin)).status, 400, route);
    assert.equal((await f.request(search('probe-c300', '2028-02-29', '00:00', '23:59:59'), admin)).status, 200);
    assert.equal((await f.request('/api/visits?date=2026-02-30', admin)).status, 400);
  });
});

test('a missing probe file reports unconnected archive and does not advertise a media URL', async () => {
  await using({ media: false }, async f => {
    const admin = await f.login('admin');
    const state = await f.request('/api/cameras/probe-c300/playback', admin);
    assert.equal(state.body.archive.status, 'not_connected');
    assert.equal(state.body.archive.sampleRange, null);
    assert.deepEqual(state.body.archive.days, []);
    assert.equal((await f.request(search(), admin)).body.status, 'not_connected');
    assert.equal((await f.request('/api/cameras', admin)).body.cameras.find(c => c.id === 'probe-c300').mediaUrl, null);
  });
});

test('camera-only regional visits and totals contain only visible demo observations', async () => {
  await using({}, async f => {
    const admin = await f.login('admin');
    const created = await f.request('/api/users', admin, { method: 'POST', body: {
      name: 'Одна камера', email: 'one@pilot.local', password: 'OnlyCamera-2026!', role: 'regional', stationIds: [], cameraIds: ['demo-1'],
    } });
    assert.equal(created.status, 201);
    const user = await f.login({ email: 'one@pilot.local', password: 'OnlyCamera-2026!' });
    const events = (await f.request('/api/events', user)).body.events;
    const visits = (await f.request('/api/visits', user)).body.visits;
    assert.ok(visits.length > 0);
    assert.ok(visits.every(v => v.cameraId === 'demo-1' && v.status === 'paired' && v.durationMinutes > 0));
    const station = (await f.request('/api/stations', user)).body.stations[0];
    assert.equal(station.metrics.entries, visits.length);
    assert.equal(station.metrics.exits, visits.length);
    assert.equal(station.metrics.completedVisits, visits.length);
    assert.equal(events.filter(e => e.type === 'vehicle_exit').length, visits.length);
    assert.deepEqual((await f.request('/api/visits?cameraId=demo-2', user)).body.visits, []);
    assert.deepEqual((await f.request('/api/visits?date=2026-10-31', user)).body.visits, []);
    const otherDay = (await f.request('/api/stations?date=2026-10-31', user)).body.stations[0].metrics;
    assert.equal(otherDay.exits, null);
    assert.equal(otherDay.completedVisits, null);
    assert.equal((await f.request('/api/cameras/demo-1/playback', user)).status, 200);
    assert.equal((await f.request('/api/cameras/demo-2/playback', user)).status, 403);
  });
});

test('empty optional metadata inventory does not break the service', async () => {
  await using({ inventory: [] }, async f => {
    const admin = await f.login('admin');
    assert.equal((await f.request('/api/cameras', admin)).body.cameras.length, 6);
  });
});

test('safe inventory imports are admin-only when unmapped, strip unknown fields and cannot replace built-in cameras', async () => {
  await using({ inventory: [
    { id: 'safe-unmapped', name: 'Без подписи', model: 'Xiaomi C200', did: 'private-did',
      url: 'https://example.invalid/secret', password: 'private-password', stationId: 'station-1' },
    { id: 'demo-1', name: 'Collision', model: 'C300' }, { id: 'probe-c300', name: 'Collision', model: 'C300' },
    { id: 'invalid/path', name: 'Invalid', model: 'C200' }, { id: 123456, name: 'Invalid', model: 'C200' }, null,
  ] }, async f => {
    const admin = await f.login('admin');
    const listed = await f.request('/api/cameras', admin);
    assert.equal(listed.body.cameras.length, 7);
    const camera = listed.body.cameras.find(c => c.id === 'safe-unmapped');
    assert.equal(camera.stationId, null, 'input stationId must be ignored');
    assert.equal(camera.status, 'unconnected');
    assert.equal(camera.view, 'unknown');
    assert.equal(camera.metrics.source, 'none');
    assert.equal(camera.metrics.entries, null);
    assert.equal(camera.mediaUrl, null);
    assert.doesNotMatch(JSON.stringify(listed.body), /private-did|private-password|example\.invalid/);
    for (const role of ['regional', 'director']) {
      const session = await f.login(role);
      assert.ok(!(await f.request('/api/cameras', session)).body.cameras.some(c => c.id === camera.id));
      assert.equal((await f.request(`/api/cameras/${camera.id}/playback`, session)).status, 403);
      assert.equal((await f.request(search(camera.id), session)).status, 403);
    }
    const deniedGrant = await f.request('/api/users', admin, { method: 'POST', body: {
      name: 'Без адреса', email: 'unmapped@pilot.local', password: 'Unmapped-Pilot-2026!', role: 'regional',
      stationIds: [], cameraIds: [camera.id],
    } });
    assert.equal(deniedGrant.status, 403);
  });
});

test('matched inventory camera inherits station rights but its own scope cannot expose hidden demo metrics or visits', async () => {
  await using({ inventory: [{ id: 'safe-matched', name: stations[0].address, model: 'Xiaomi C300' }] }, async f => {
    const admin = await f.login('admin'), director = await f.login('director');
    const all = (await f.request('/api/cameras', admin)).body.cameras;
    const imported = all.find(c => c.id === 'safe-matched');
    assert.equal(imported.stationId, stations[0].id);
    assert.equal(imported.mappingStatus, 'matched');
    assert.equal(imported.status, 'unconnected');
    assert.equal(imported.metrics.source, 'none');
    assert.ok((await f.request('/api/cameras', director)).body.cameras.some(c => c.id === imported.id));
    const created = await f.request('/api/users', director, { method: 'POST', body: {
      name: 'Реальная камера', email: 'matched@pilot.local', password: 'Matched-Pilot-2026!',
      role: 'regional', stationIds: [], cameraIds: [imported.id],
    } });
    assert.equal(created.status, 201);
    const user = await f.login({ email: 'matched@pilot.local', password: 'Matched-Pilot-2026!' });
    const visible = (await f.request('/api/cameras', user)).body.cameras;
    assert.equal(visible.length, 1);
    assert.equal(visible[0].candidateStationIds, undefined);
    assert.equal(visible[0].id, imported.id);
    const station = (await f.request('/api/stations', user)).body.stations[0];
    assert.equal(station.cameraCount, 1);
    assert.equal(station.metrics.entries, null);
    assert.equal(station.metrics.exits, null);
    assert.equal(station.metrics.completedVisits, null);
    assert.deepEqual((await f.request('/api/events', user)).body.events, []);
    assert.deepEqual((await f.request('/api/visits', user)).body.visits, []);
    assert.equal((await f.request(search(imported.id), user)).body.status, 'not_connected');
    assert.equal((await f.request('/api/cameras/demo-1/playback', user)).status, 403);
    assert.equal((await f.request('/api/cameras/probe-c300/media', user)).status, 403);
  });
});
