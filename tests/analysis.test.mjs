import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { createServer } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { loadAnalysisConfig, readAnalysis, analysisMetrics, localParts } from '../backend/analysis.mjs';
import { analysisPlayback, searchAnalysisArchive, openAnalysisMedia, mediaRange } from '../backend/analysisArchive.mjs';
import { createApp } from '../backend/app.mjs';
import { loadConfig } from '../backend/config.mjs';

const stations = [{ id: 'station-1', city: 'Тест', address: 'Улица 1', region: 'Регион', manager: 'Тест' },
  { id: 'station-2', city: 'Тест', address: 'Улица 2', region: 'Регион', manager: 'Тест' }];
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'camera-pilot-analysis-'));
  const resultsDir = resolve(root, 'results'), archiveRoot = resolve(root, 'archive');
  mkdirSync(resultsDir); mkdirSync(archiveRoot);
  const camera = { cameraId: 'real-camera', stationId: 'station-1', mappingVersion: 'v1',
    timezone: 'Asia/Barnaul', name: 'Проверенная камера', model: 'Synthetic', primary: true };
  const raw = { resultsDir, archiveRoot, cameras: [camera] }, configFile = resolve(root, 'config.json');
  writeFileSync(configFile, JSON.stringify(raw));
  const config = () => loadAnalysisConfig(configFile, stations, []);
  function run(id = 'run-1', changes = {}) {
    mkdirSync(resolve(archiveRoot, id), { recursive: true });
    writeFileSync(resolve(archiveRoot, id, 'video.mp4'), '0123456789');
    const data = { schemaVersion: 1, runId: id, pipelineVersion: 'synthetic-v1', cameraId: camera.cameraId,
      stationId: camera.stationId, mappingVersion: camera.mappingVersion, timezone: camera.timezone,
      generatedAt: '2026-11-05T18:05:00.000Z',
      recording: { id, file: `${id}/video.mp4`, sha256: '0'.repeat(64),
        startedAt: '2026-11-05T17:59:30.000Z', durationSeconds: 120, timing: 'estimated' },
      coverage: { status: 'partial', sampleIntervalSeconds: 1 }, events: [
        { id: `${id}-entry`, type: 'vehicle_entry', occurredAtUtc: '2026-11-05T18:00:02.000Z', confidence: 0.8,
          visitId: null, needsReview: true, evidence: { recordingId: id, offsetSeconds: 32 } }], ...changes };
    writeFileSync(resolve(resultsDir, `${id}.json`), JSON.stringify(data)); return data;
  }
  return { root, raw, camera, configFile, config, run, resultsDir, archiveRoot,
    close() { assert.equal(dirname(root), resolve(tmpdir())); assert.match(basename(root), /^camera-pilot-analysis-/); rmSync(root, { recursive: true }); } };
}
function using(fn) { const f = fixture(); try { return fn(f); } finally { f.close(); } }

test('analysis config is explicit, immutable across names, rejects unknown station/duplicate primary/unsafe roots', () => using(f => {
  assert.equal(f.config().cameras[0].stationId, 'station-1');
  assert.equal(loadAnalysisConfig(undefined, stations).cameras.length, 0);
  for (const change of [{ cameras: [{ ...f.camera, stationId: 'missing' }] },
    { cameras: [f.camera, { ...f.camera, cameraId: 'second' }] }, { resultsDir: 'relative' },
    { cameras: [{ ...f.camera, cameraId: '../bad' }] }, { cameras: [{ ...f.camera, timezone: 'invalid' }] }]) {
    writeFileSync(f.configFile, JSON.stringify({ ...f.raw, ...change }));
    assert.throws(() => f.config(), /analysis configuration/i);
  }
}));

test('results validate mapping, UTC timestamps, offsets and schema without promoting partial zero to full day', () => using(f => {
  f.run(); const config = f.config(), runs = readAnalysis(config);
  assert.equal(runs.length, 1);
  assert.deepEqual(localParts('2026-11-05T18:00:02.000Z', 'Asia/Barnaul'), { date: '2026-11-06', time: '01:00:02' });
  const m = analysisMetrics(runs, 'real-camera', '2026-11-06');
  assert.equal(m.entries, 1); assert.equal(m.exits, null); assert.equal(m.coverage, 'partial');
  assert.equal(m.openedAt, null); assert.equal(analysisMetrics(runs, 'real-camera', '2026-11-07').source, 'none');
  f.run('run-1', { events: [] });
  assert.equal(analysisMetrics(readAnalysis(config), 'real-camera', '2026-11-06').entries, null);
  for (const change of [{ stationId: 'station-2' }, { mappingVersion: 'v2' }, { timezone: 'UTC' }, { schemaVersion: 2 },
    { events: [{ id: 'bad', type: 'vehicle_entry', occurredAtUtc: '2026-11-05T18:00:02.000Z', confidence: 0.8,
      visitId: null, needsReview: true, evidence: { recordingId: 'run-1', offsetSeconds: 500 } }] }]) {
    f.run('run-1', change); assert.equal(readAnalysis(config).length, 0);
  }
}));

test('duplicate physical clips deduplicate and ambiguous overlapping recordings are all excluded', () => using(f => {
  const a = f.run();
  writeFileSync(resolve(f.resultsDir, 'duplicate.json'), JSON.stringify(a));
  assert.equal(readAnalysis(f.config()).length, 1);
  f.run('run-2');
  assert.equal(readAnalysis(f.config()).length, 1, 'same hash and time is same physical recording');
  f.run('run-2', { recording: { ...a.recording, id: 'run-2', file: 'run-2/video.mp4', sha256: '1'.repeat(64) }, events: [] });
  assert.equal(readAnalysis(f.config()).length, 0, 'no arbitrary winner for conflicting overlap');
}));

test('estimated gate changes remain review events with unknown opening metrics', () => using(f => {
  const a = f.run(); a.events[0].type = 'opened'; f.run('run-1', a);
  assert.equal(analysisMetrics(readAnalysis(f.config()), 'real-camera', '2026-11-06').openedAt, null);
}));

test('archive availability uses existing regular files and exact station-local date, offset and safe URL', () => using(f => {
  f.run(); const config = f.config(), runs = readAnalysis(config);
  const state = analysisPlayback(runs, 'real-camera');
  assert.equal(state.status, 'available'); assert.deepEqual(state.days, ['2026-11-06']);
  const result = searchAnalysisArchive(runs, 'real-camera', { date: '2026-11-06', from: '01:00:00', to: '01:00:10' });
  assert.equal(result.status, 'available'); const r = result.records[0];
  assert.equal(r.startOffsetSeconds, 30); assert.equal(r.endOffsetSeconds, 40);
  assert.equal(r.mediaUrl, '/api/cameras/real-camera/recordings/run-1/media');
  assert.equal(r.startAt, '2026-11-06T01:00:00'); assert.equal(r.timing, 'estimated');
  assert.ok(!JSON.stringify(result).includes(f.root));
  unlinkSync(resolve(f.archiveRoot, 'run-1', 'video.mp4'));
  assert.equal(analysisPlayback(readAnalysis(config), 'real-camera').status, 'not_connected');
}));

test('media range is bounded, rejects malformed/multiple ranges, and opens only registered safe files', () => using(f => {
  f.run(); const runs = readAnalysis(f.config());
  assert.deepEqual(mediaRange('bytes=3-6', 10), { start: 3, end: 6, status: 206 });
  assert.deepEqual(mediaRange('bytes=-2', 10), { start: 8, end: 9, status: 206 });
  for (const value of ['bytes=0-1,3-4', 'bytes=10-', 'bytes=-0', 'bytes=9007199254740993-', 'bytes=0-9007199254740993'])
    assert.equal(mediaRange(value, 10), null);
  const opened = openAnalysisMedia(runs, 'real-camera', 'run-1'); assert.ok(opened); opened.close();
  assert.equal(openAnalysisMedia(runs, 'other', 'run-1'), null);
  assert.equal(openAnalysisMedia(runs, 'real-camera', '../run-1'), null);
  assert.ok(mediaRange('bytes=0-', 20 * 1024 * 1024).end < 8 * 1024 * 1024);
}));

test('traversal, absolute file names, corrupt JSON and symlinks do not register media', t => using(f => {
  const a = f.run();
  for (const file of ['../video.mp4', '/video.mp4', 'run-1/../video.mp4', 'run-1\\video.mp4', 'http://host/video.mp4']) {
    f.run('run-1', { recording: { ...a.recording, file } }); assert.equal(readAnalysis(f.config()).length, 0);
  }
  writeFileSync(resolve(f.resultsDir, 'run-1.json'), '{broken'); assert.equal(readAnalysis(f.config()).length, 0);
  f.run(); const file = resolve(f.archiveRoot, 'run-1', 'video.mp4'); unlinkSync(file);
  writeFileSync(resolve(f.root, 'outside.mp4'), 'outside');
  try { symlinkSync(resolve(f.root, 'outside.mp4'), file); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Windows symlink creation denied; junction-directory case tested below');
    rmSync(resolve(f.archiveRoot, 'run-1'), { recursive: true });
    mkdirSync(resolve(f.root, 'outside')); writeFileSync(resolve(f.root, 'outside', 'video.mp4'), 'outside');
    symlinkSync(resolve(f.root, 'outside'), resolve(f.archiveRoot, 'run-1'), 'junction');
  } else throw error; }
  assert.equal(readAnalysis(f.config()).length, 0);
}));

test('deployment loader forwards only configured analysis manifest path', () => {
  assert.equal(loadConfig({ PILOT_ANALYSIS_CONFIG: 'manifest.json' }).analysisConfigFile, 'manifest.json');
});

test('directory and individual report bounds fail closed; incomplete temporary files are ignored', () => using(f => {
  f.run(); const config = f.config();
  writeFileSync(resolve(f.resultsDir, 'pending.json.part'), '{');
  assert.equal(readAnalysis(config).length, 1);
  writeFileSync(resolve(f.resultsDir, 'run-1.json'), ' '.repeat(256 * 1024 + 1));
  assert.equal(readAnalysis(config).length, 0);
  f.run();
  for (let n = 0; n < 128; n++) writeFileSync(resolve(f.resultsDir, `overflow-${n}.json`), '{}');
  assert.equal(readAnalysis(config).length, 0);
}));

test('wrong event time, stale mapping, unapproved fields, invalid partial coverage and unfinished results are rejected', () => using(f => {
  const a = f.run(), config = f.config();
  for (const change of [{ command: 'arbitrary' }, { generatedAt: '2026-11-05T17:59:29.000Z' },
    { recording: { ...a.recording, durationSeconds: 901 } }, { recording: { ...a.recording, timing: 'camera_verified' } },
    { coverage: { status: 'complete', sampleIntervalSeconds: 1 } },
    { coverage: { status: 'partial', sampleIntervalSeconds: 0 } },
    { events: [{ ...a.events[0], needsReview: false }] },
    { events: [{ ...a.events[0], occurredAtUtc: '2026-11-05T18:00:03.000Z' }] },
    { events: [{ ...a.events[0], confidence: 2 }] }, { events: [a.events[0], a.events[0]] },
    { events: Array.from({ length: 2001 }, (_, i) => ({ ...a.events[0], id: `event-${i}` })) }]) {
    f.run('run-1', change); assert.equal(readAnalysis(config).length, 0, JSON.stringify(change).slice(0, 150));
  }
}));

test('same run ID with conflicting results excludes the run; independent clips never pair track IDs', () => using(f => {
  const a = f.run();
  writeFileSync(resolve(f.resultsDir, 'duplicate.json'), JSON.stringify({ ...a, events: [] }));
  assert.equal(readAnalysis(f.config()).length, 0);
  unlinkSync(resolve(f.resultsDir, 'duplicate.json'));
  f.run('run-2', { recording: { ...a.recording, id: 'run-2', file: 'run-2/video.mp4', sha256: '1'.repeat(64),
    startedAt: '2026-11-05T18:10:00.000Z' }, generatedAt: '2026-11-05T18:15:00.000Z', events: [] });
  assert.equal(readAnalysis(f.config()).length, 2);
  assert.equal(analysisMetrics(readAnalysis(f.config()), 'real-camera', '2026-11-06').completedVisits, null);
}));

test('a clip reused with conflicting time or analysis is not counted twice', () => using(f => {
  const a = f.run();
  f.run('run-2', { recording: { ...a.recording, id: 'run-2', file: 'run-2/video.mp4',
    startedAt: '2026-11-05T18:10:00.000Z' }, generatedAt: '2026-11-05T18:15:00.000Z', events: [] });
  assert.equal(readAnalysis(f.config()).length, 0, 'same media hash with incompatible timestamps has no arbitrary winner');
  f.run('run-2', { events: [] });
  assert.equal(readAnalysis(f.config()).length, 0, 'same footage with conflicting detections has no arbitrary winner');
}));

test('a fragment straddling station midnight is split by local day and retains original media offsets', () => using(f => {
  const a = f.run(), startedAt = '2026-11-05T16:59:30.000Z';
  f.run('run-1', { recording: { ...a.recording, startedAt }, events: [{ ...a.events[0], occurredAtUtc: '2026-11-05T17:00:02.000Z' }] });
  const runs = readAnalysis(f.config());
  assert.deepEqual(analysisPlayback(runs, 'real-camera').days, ['2026-11-05', '2026-11-06']);
  assert.equal(analysisMetrics(runs, 'real-camera', '2026-11-05').source, 'analysis');
  assert.equal(analysisMetrics(runs, 'real-camera', '2026-11-05').entries, null);
  const result = searchAnalysisArchive(runs, 'real-camera', { date: '2026-11-06', from: '00:00:00', to: '00:00:10' });
  assert.equal(result.records[0].startOffsetSeconds, 30); assert.equal(result.records[0].endOffsetSeconds, 40);
}));

test('media disappearing or becoming a symlink after report load is denied at open time', t => using(f => {
  f.run(); const runs = readAnalysis(f.config());
  const file = resolve(f.archiveRoot, 'run-1', 'video.mp4'); unlinkSync(file);
  assert.equal(openAnalysisMedia(runs, 'real-camera', 'run-1'), null);
  rmSync(resolve(f.archiveRoot, 'run-1'), { recursive: true }); mkdirSync(resolve(f.root, 'outside'));
  writeFileSync(resolve(f.root, 'outside', 'video.mp4'), 'outside');
  symlinkSync(resolve(f.root, 'outside'), resolve(f.archiveRoot, 'run-1'), 'junction');
  assert.equal(openAnalysisMedia(runs, 'real-camera', 'run-1'), null);
}));

test('unsafe explicit config is rejected before opening user DB or network', () => using(f => {
  const stationFile = resolve(f.root, 'stations.json'); writeFileSync(stationFile, JSON.stringify(stations));
  writeFileSync(f.configFile, JSON.stringify({ ...f.raw, cameras: [{ ...f.camera, cameraId: 'demo-1' }] }));
  assert.throws(() => createApp({ stationFile, dbPath: resolve(f.root, 'no.sqlite'), analysisConfigFile: f.configFile }), /analysis configuration/i);
}));

test('shutdown cancels held archive stream and permission timer before closing SQLite', async t => {
  const f = fixture(); let app, media;
  class Response extends Writable {
    constructor(hold = false) { super(); this.hold = hold; this.headers = {}; this.chunks = []; this.first = new Promise(resolve => { this.firstWrite = resolve; }); }
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
    writeHead(status, headers = {}) { this.statusCode = status; for (const [key, value] of Object.entries(headers)) this.setHeader(key, value); this.headersSent = true; }
    _write(chunk, encoding, callback) { this.chunks.push(chunk); this.firstWrite(); if (!this.hold) callback(); }
  }
  const request = (url, method = 'GET', body, headers = {}) => Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    { url, method, headers: { host: '127.0.0.1', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  try {
    f.run(); writeFileSync(resolve(f.archiveRoot, 'run-1', 'video.mp4'), Buffer.alloc(1024 * 1024));
    const stationFile = resolve(f.root, 'stations.json'); writeFileSync(stationFile, JSON.stringify(stations));
    app = createApp({ stationFile, dbPath: resolve(f.root, 'held.sqlite'), analysisConfigFile: f.configFile });
    const login = new Response(), finished = new Promise(resolve => login.on('finish', resolve));
    app(request('/api/login', 'POST', { email: 'admin@ekosmotr.local', password: 'Pilot-Admin-2026!' }), login);
    await finished; assert.equal(login.statusCode, 200);
    t.mock.timers.enable({ apis: ['setInterval'] });
    media = new Response(true);
    app(request('/api/cameras/real-camera/recordings/run-1/media', 'GET', undefined,
      { cookie: login.headers['set-cookie'].split(';')[0] }), media);
    await media.first; assert.equal(media.statusCode, 200);
    await app.close();
    assert.doesNotThrow(() => t.mock.timers.tick(1500), 'permission callback must never access a closed database');
    assert.equal(media.destroyed, true, 'active archive response is cancelled on application shutdown');
  } finally {
    media?.destroy(); await new Promise(resolve => setImmediate(resolve)); t.mock.timers.reset();
    await app?.close(); await new Promise(resolve => setTimeout(resolve, 20)); f.close();
  }
});

test('HTTP applies camera scope before aggregates and protects recording access while preserving probe', async () => {
  const f = fixture(); let app, server;
  try {
    f.run(); const other = { ...f.camera, cameraId: 'hidden-camera', primary: false };
    writeFileSync(f.configFile, JSON.stringify({ ...f.raw, cameras: [f.camera, other] }));
    const a = f.run('hidden-run', { cameraId: other.cameraId });
    a.events[0].id = 'hidden-event'; writeFileSync(resolve(f.resultsDir, 'hidden-run.json'), JSON.stringify(a));
    const stationFile = resolve(f.root, 'stations.json'); writeFileSync(stationFile, JSON.stringify(stations));
    app = createApp({ dbPath: resolve(f.root, 'test.sqlite'), stationFile, analysisConfigFile: f.configFile });
    server = createServer(app); await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function req(path, user, body, method = 'GET', extra = {}) {
      const r = await fetch(base + path, { method, headers: { ...(user ? { Cookie: user.cookie, 'X-CSRF-Token': user.csrfToken } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
      const value = r.headers.get('content-type')?.includes('application/json') ? await r.json() : await r.text();
      return { status: r.status, body: value, cookie: r.headers.get('set-cookie')?.split(';')[0] };
    }
    const login = await req('/api/login', null, { email: 'admin@ekosmotr.local', password: 'Pilot-Admin-2026!' }, 'POST');
    const admin = { ...login.body, cookie: login.cookie };
    const password = 'Test-Only-Password!';
    const user = await req('/api/users', admin, { name: 'Тест области', email: 'scope@test.local', password,
      role: 'regional', stationIds: [], cameraIds: ['real-camera'] }, 'POST'); assert.equal(user.status, 201);
    const entered = await req('/api/login', null, { email: 'scope@test.local', password }, 'POST');
    const scoped = { ...entered.body, cookie: entered.cookie };
    const metrics = await req('/api/stations?date=2026-11-06', scoped);
    assert.equal(metrics.body.stations[0].cameraCount, 1); assert.equal(metrics.body.stations[0].metrics.entries, 1);
    const ev = await req('/api/events?date=2026-11-06', scoped); assert.equal(ev.body.events.length, 1);
    assert.equal(ev.body.events[0].time, '01:00:02'); assert.equal(ev.body.events[0].needsReview, true);
    assert.equal(ev.body.events[0].evidence.offsetSeconds, 32);
    const media = '/api/cameras/real-camera/recordings/run-1/media';
    assert.equal((await req(media)).status, 401);
    assert.equal((await req(media, scoped, null, 'GET', { Range: 'bytes=3-6' })).body, '3456');
    for (const path of ['/api/cameras/hidden-camera/playback', '/api/cameras/hidden-camera/recordings/hidden-run/media'])
      assert.equal((await req(path, scoped)).status, 403);
    assert.equal((await req('/api/cameras/real-camera/recordings/hidden-run/media', scoped)).status, 404);
    assert.equal((await req('/api/cameras/probe-c300/playback', admin)).status, 200);
    const secondaryUser = await req('/api/users', admin, { name: 'Тест второго ракурса', email: 'secondary@test.local', password,
      role: 'regional', stationIds: [], cameraIds: ['hidden-camera'] }, 'POST'); assert.equal(secondaryUser.status, 201);
    const secondaryLogin = await req('/api/login', null, { email: 'secondary@test.local', password }, 'POST');
    const secondary = { ...secondaryLogin.body, cookie: secondaryLogin.cookie };
    const secondaryMetrics = await req('/api/stations?date=2026-11-06', secondary);
    assert.equal(secondaryMetrics.body.stations[0].metrics.entries, null, 'hidden primary never contributes');
    assert.equal(secondaryMetrics.body.stations[0].cameraCount, 1);
    const adminMetrics = await req('/api/stations?date=2026-11-06', admin);
    assert.equal(adminMetrics.body.stations[0].metrics.entries, 1, 'two angles never summed');
    const missing = await req('/api/cameras/missing-camera/recordings/hidden-run/media', scoped);
    const forbidden = await req('/api/cameras/hidden-camera/recordings/hidden-run/media', scoped);
    assert.deepEqual(missing.body, forbidden.body);
    const head = await req(media, scoped, null, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body, '');
    assert.equal((await req(media, scoped, null, 'GET', { Range: 'bytes=0-1,3-4' })).status, 416);
    assert.equal((await req('/api/events?date=2026-11-05', scoped)).body.events.length, 0);
    const exact = await req('/api/cameras/real-camera/recordings/run-1?offsetSeconds=32', scoped);
    assert.equal(exact.status, 200); assert.equal(exact.body.record.id, 'run-1');
    assert.equal(exact.body.record.startOffsetSeconds, 32); assert.equal(exact.body.record.endOffsetSeconds, 62);
    const precise = await req('/api/cameras/real-camera/recordings/run-1?offsetSeconds=9.54321', scoped);
    assert.equal(precise.status, 200);
    assert.equal(precise.body.record.startOffsetSeconds, 9.54321, 'exact evidence offset must not be rounded');
    assert.equal(precise.body.record.endOffsetSeconds, 39.54321);
    const exponent = await req('/api/cameras/real-camera/recordings/run-1?offsetSeconds=1e-7', scoped);
    assert.equal(exponent.status, 200);
    assert.equal(exponent.body.record.startOffsetSeconds, 1e-7, 'serialized finite exponent offset stays exact');
    const clamp = await req('/api/cameras/real-camera/recordings/run-1?offsetSeconds=119.5', scoped);
    assert.equal(clamp.body.record.endOffsetSeconds, 120);
    for (const value of ['', 'NaN', 'Infinity', '-1', '120', '999999999999999999999', '1e999', '1e-7junk', '0'.repeat(33)])
      assert.equal((await req(`/api/cameras/real-camera/recordings/run-1?offsetSeconds=${value}`, scoped)).status, 400, value);
    assert.equal((await req('/api/cameras/real-camera/recordings/run-1?offsetSeconds=1&offsetSeconds=2', scoped)).status, 400);
    assert.equal((await req('/api/cameras/real-camera/recordings/hidden-run?offsetSeconds=1', scoped)).status, 404);
    assert.equal((await req('/api/cameras/hidden-camera/recordings/hidden-run?offsetSeconds=1', scoped)).status, 403);
    assert.equal((await req('/api/cameras/real-camera/recordings/run-1?offsetSeconds=1')).status, 401);
    assert.equal((await req('/api/cameras/missing-camera/recordings/run-1?offsetSeconds=1', scoped)).status, 403);
    assert.equal(secondaryMetrics.body.stations[0].demoMetrics.source, 'none', 'demo day is explicit');
    const original = f.run();
    f.run('run-1', { recording: { ...original.recording, startedAt: '2026-10-30T16:59:50.000Z', durationSeconds: 20 },
      generatedAt: '2026-10-30T17:02:00.000Z', events: [] });
    const midnight = await req('/api/cameras/real-camera/recordings/run-1?offsetSeconds=9.5', scoped);
    assert.equal(midnight.body.record.startAt, '2026-10-30T23:59:59.500');
    assert.equal(midnight.body.record.endAt, '2026-10-31T00:00:10');
    assert.equal(midnight.body.record.startOffsetSeconds, 9.5); assert.equal(midnight.body.record.endOffsetSeconds, 20);
    const bothSources = await req('/api/stations?date=2026-10-30', admin);
    assert.equal(bothSources.body.stations[0].metrics.source, 'analysis');
    assert.equal(bothSources.body.stations[0].demoMetrics.source, 'demo');
    assert.equal(bothSources.body.stations[0].demoMetrics.entries, 38);
    const noDemoGrant = await req('/api/stations?date=2026-10-30', scoped);
    assert.equal(noDemoGrant.body.stations[0].demoMetrics.source, 'none');
    assert.equal(noDemoGrant.body.stations[0].demoMetrics.entries, null);
    unlinkSync(resolve(f.archiveRoot, 'run-1', 'video.mp4'));
    assert.equal((await req('/api/cameras/real-camera/recordings/run-1?offsetSeconds=9.5', scoped)).status, 404);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(yes => server.close(yes)); }
    await app?.close(); f.close();
  }
});
