import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../backend/app.mjs';
import { createLiveManager } from '../backend/live.mjs';
import * as liveHelpers from '../backend/live.mjs';
import { loadConfig } from '../backend/config.mjs';

const accounts = { admin: ['admin@ekosmotr.local', 'Pilot-Admin-2026!'],
  regional: ['regional@ekosmotr.local', 'Pilot-Region-2026!'] };
const stations = Array.from({ length: 12 }, (_, i) => ({ id: `station-${i + 1}`,
  city: ['Екатеринбург', 'Новосибирск', 'Краснодар', 'Москва'][i % 4],
  region: 'Тест', address: `Улица Проверки, ${i + 1}`, manager: 'Тест' }));

async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'camera-pilot-live-'));
  const stationFile = path.join(dir, 'stations.json'), marker = path.join(dir, 'stopped.txt');
  const inventoryFile = path.join(dir, 'inventory.json');
  const program = path.join(dir, 'bridge.mjs'), liveConfigFile = path.join(dir, 'live.json');
  await writeFile(stationFile, JSON.stringify(stations));
  // A subprocess fixture exercises actual stdout, disconnect and STOP cleanup. Never a real camera.
  await writeFile(program, `import {writeFileSync} from 'node:fs';
const marker=process.argv[2];let done=false;
const stop=()=>{if(done)return;done=true;setTimeout(()=>{writeFileSync(marker,'stopped');process.exit(0)},${options.cleanupDelayMs || 0})};
process.stdin.on('data',b=>{if(b.toString().includes('STOP'))stop()});
process.on('SIGTERM',stop);
${options.empty ? '' : "setInterval(()=>process.stdout.write(Buffer.from(process.argv[3] || 'synthetic-fmp4-bytes')),30);"}
setInterval(()=>{},1000);
`);
  const config = { cameraId: 'probe-c300', command: process.execPath, args: [program, marker], cwd: dir,
    maxDurationSeconds: options.duration || 10, startupTimeoutMs: options.empty ? 100 : 1000,
    stallTimeoutMs: 1000 };
  if (options.routes) {
    await writeFile(inventoryFile, JSON.stringify([{ id: 'camera-two', name: 'Тестовая камера', model: 'test.camera.001' }]));
  }
  if (options.config !== false) await writeFile(liveConfigFile, JSON.stringify(
    options.routes ? { cameras: options.routes(config) } : { ...config, ...options.config }));
  const app = createApp({ dbPath: path.join(dir, 'pilot.sqlite'), stationFile,
    inventoryFile: options.routes ? inventoryFile : undefined,
    liveMaxStreams: options.liveMaxStreams,
    liveConfigFile: options.config === false ? undefined : liveConfigFile });
  const server = createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = (url, session, options = {}) => fetch(base + url, { ...options,
    headers: { ...(session && { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken }),
      ...(options.body && { 'Content-Type': 'application/json' }), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const request = async (...args) => { const r = await raw(...args); return { status: r.status, headers: r.headers, body: await r.json() }; };
  const login = async (role = 'admin') => {
    const [email, password] = accounts[role];
    const result = await request('/api/login', null, { method: 'POST', body: { email, password } });
    assert.equal(result.status, 200);
    return { ...result.body, cookie: result.headers.get('set-cookie').split(';')[0] };
  };
  const start = (session, cameraId = 'probe-c300') => request(`/api/cameras/${cameraId}/live`, session, { method: 'POST' });
  const stopped = async (name = 'stopped.txt') => { for (let i = 0; i < 60; i++) { try { return await readFile(path.join(dir, name), 'utf8'); } catch {} await delay(30); } return null; };
  return { app, server, request, raw, login, start, stopped, liveConfigFile, async close() {
    await app.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await delay(50);
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    assert.match(path.basename(dir), /^camera-pilot-live-/);
    await rm(dir, { recursive: true, force: true });
  } };
}
async function using(options, fn) { const f = await fixture(options); try { await fn(f); } finally { await f.close(); } }

test('live requires login, CSRF and camera rights; missing and forbidden are identical', async () => using({}, async f => {
  assert.equal((await f.start()).status, 401);
  const admin = await f.login(), regional = await f.login('regional');
  const noCSRF = await f.request('/api/cameras/probe-c300/live', admin, { method: 'POST', headers: { 'X-CSRF-Token': '' } });
  assert.equal(noCSRF.status, 403);
  const forbidden = await f.start(regional);
  assert.equal(forbidden.status, 403);
  assert.deepEqual((await f.request('/api/cameras/unknown/live', regional, { method: 'POST' })).body, forbidden.body);
  assert.equal((await f.request('/api/cameras/probe-c300/live', admin, { method: 'POST', headers: { Origin: 'https://foreign.invalid' } })).status, 403);
}));

test('only configured camera advertises live and disabled configuration stays unavailable', async () => {
  await using({}, async f => {
    const admin = await f.login();
    const configured = (await f.request('/api/cameras/probe-c300/playback', admin)).body;
    assert.equal(configured.live.status, 'available');
    assert.equal(configured.live.url, '/api/cameras/probe-c300/live');
    const cameras = (await f.request('/api/cameras', admin)).body.cameras;
    assert.equal(cameras.find(camera => camera.id === 'probe-c300').liveAvailable, true);
    assert.ok(cameras.filter(camera => camera.id !== 'probe-c300').every(camera => camera.liveAvailable === false));
    assert.equal(cameras.find(camera => camera.id === 'probe-c300').status, 'recorded_probe');
    assert.equal((await f.request('/api/cameras/demo-1/playback', admin)).body.live.status, 'not_connected');
    assert.equal((await f.request('/api/cameras/demo-1/live', admin, { method: 'POST' })).status, 503);
    assert.ok(!JSON.stringify(configured).includes(process.execPath));
  });
  await using({ config: false }, async f => {
    const admin = await f.login(); assert.equal((await f.start(admin)).status, 503);
  });
});

test('multiple live routes use the selected camera bridge and keep one shared slot', async () => using({
  routes: config => [
    config,
    { ...config, cameraId: 'camera-two', args: [...config.args, 'camera-two-fmp4'], maxDurationSeconds: 8 },
  ],
}, async f => {
  const admin = await f.login();
  const catalog = (await f.request('/api/cameras', admin)).body.cameras;
  assert.deepEqual(catalog.filter(camera => camera.liveAvailable).map(camera => camera.id).sort(), ['camera-two', 'probe-c300']);
  const first = await f.start(admin);
  assert.equal(first.status, 201);
  assert.equal((await f.start(admin, 'camera-two')).status, 409);
  const wrongStream = first.body.streamUrl.replace('/probe-c300/', '/camera-two/');
  const wrongStop = first.body.stopUrl.replace('/probe-c300/', '/camera-two/');
  assert.equal((await f.request(wrongStream, admin)).status, 403);
  assert.equal((await f.request(wrongStop, admin, { method: 'DELETE' })).status, 403);

  const firstStream = await f.raw(first.body.streamUrl, admin);
  assert.equal(firstStream.status, 200);
  const firstReader = firstStream.body.getReader();
  assert.match(Buffer.from((await firstReader.read()).value).toString(), /^synthetic-fmp4-bytes/);
  assert.equal((await f.request(first.body.stopUrl, admin, { method: 'DELETE' })).status, 200);
  await firstReader.cancel();

  const second = await f.start(admin, 'camera-two');
  assert.equal(second.status, 201);
  assert.equal(second.body.maxDurationSeconds, 8);
  assert.equal((await f.request(first.body.streamUrl, admin)).status, 403);
  assert.ok(!JSON.stringify(second.body).includes('camera-two-fmp4'));
  const secondStream = await f.raw(second.body.streamUrl, admin);
  assert.equal(secondStream.status, 200);
  const secondReader = secondStream.body.getReader();
  assert.match(Buffer.from((await secondReader.read()).value).toString(), /^camera-two-fmp4/);
  assert.equal((await f.request(second.body.stopUrl, admin, { method: 'DELETE' })).status, 200);
  await secondReader.cancel();
}));

test('unknown or duplicate IDs disable the multi-camera configuration', async () => {
  for (const cameraId of ['unknown-camera', 'probe-c300']) {
    await using({ routes: config => [config, { ...config, cameraId }] }, async f => {
      const admin = await f.login();
      assert.equal((await f.start(admin)).status, 503);
      assert.equal((await f.start(admin, 'camera-two')).status, 503);
    });
  }
});

test('live ticket is bounded, single-use and bound to exact login session', async () => using({}, async f => {
  const admin = await f.login(), otherLogin = await f.login();
  const started = await f.start(admin);
  assert.equal(started.status, 201);
  assert.ok(started.body.sessionId && started.body.streamUrl && started.body.stopUrl);
  assert.equal(started.body.maxDurationSeconds, 10);
  assert.equal((await f.start(admin)).status, 409);
  const stolen = await f.request(started.body.streamUrl, otherLogin);
  assert.equal(stolen.status, 403);
  assert.deepEqual((await f.request(started.body.streamUrl.replace(started.body.sessionId, 'absent'), otherLogin)).body, stolen.body);
  const response = await f.raw(started.body.streamUrl, admin);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const reader = response.body.getReader(); assert.ok((await reader.read()).value.length);
  assert.equal((await f.request(started.body.streamUrl, admin)).status, 409);
  assert.equal((await f.request(started.body.stopUrl, otherLogin, { method: 'DELETE' })).status, 403);
  assert.equal((await f.request(started.body.stopUrl, admin, { method: 'DELETE' })).status, 200);
  await reader.cancel(); assert.equal(await f.stopped(), 'stopped');
}));

test('closing video connection stops the bridge and releases the single camera slot', async () => using({}, async f => {
  const admin = await f.login(), ticket = (await f.start(admin)).body;
  const response = await f.raw(ticket.streamUrl, admin), reader = response.body.getReader();
  await reader.read(); await reader.cancel();
  assert.equal(await f.stopped(), 'stopped');
  for (let i = 0; i < 20; i++) { const next = await f.start(admin); if (next.status === 201) return; await delay(20); }
  assert.fail('bridge slot was not released');
}));

test('DELETE stop waits for bridge cleanup before allowing an immediate new start', async () => using({ cleanupDelayMs: 200 }, async f => {
  const admin = await f.login(), ticket = (await f.start(admin)).body;
  const response = await f.raw(ticket.streamUrl, admin), reader = response.body.getReader(); await reader.read();
  const started = Date.now(), stopped = await f.request(ticket.stopUrl, admin, { method: 'DELETE' });
  assert.equal(stopped.status, 200);
  assert.equal(await readFile(path.join(path.dirname(f.liveConfigFile), 'stopped.txt'), 'utf8'), 'stopped');
  assert.ok(Date.now() - started >= 180);
  assert.equal((await f.start(admin)).status, 201);
  await reader.cancel();
}));

test('logout ends an in-flight video and invalidates its ticket', async () => using({}, async f => {
  const admin = await f.login(), ticket = (await f.start(admin)).body;
  const response = await f.raw(ticket.streamUrl, admin), reader = response.body.getReader(); await reader.read();
  assert.equal((await f.request('/api/logout', admin, { method: 'POST' })).status, 200);
  assert.equal(await f.stopped(), 'stopped'); await reader.cancel();
  assert.equal((await f.request(ticket.streamUrl, admin)).status, 401);
}));

test('bridge without output fails safely and terminates on startup timeout', async () => using({ empty: true }, async f => {
  const admin = await f.login(), ticket = (await f.start(admin)).body;
  const result = await f.request(ticket.streamUrl, admin);
  assert.equal(result.status, 504);
  assert.equal(result.body.code, 'LIVE_START_TIMEOUT');
  assert.ok(!JSON.stringify(result.body).includes('bridge.mjs'));
  assert.equal(await f.stopped(), 'stopped');
  const audit = (await f.request('/api/audit', admin)).body.events;
  const stop = audit.find(event => event.action === 'Остановлен онлайн-просмотр');
  assert.deepEqual(JSON.parse(stop.details), { reason: 'startup_timeout' });
  assert.ok(audit.some(event => event.action === 'Запрошен онлайн-просмотр'));
}));

test('maximum live duration terminates actual subprocess and stream', async () => using({ duration: 1 }, async f => {
  const admin = await f.login(), ticket = (await f.start(admin)).body;
  const response = await f.raw(ticket.streamUrl, admin), reader = response.body.getReader(); await reader.read();
  await delay(1100); assert.equal(await f.stopped(), 'stopped'); await reader.cancel();
}));

test('server close ends the bridge and live audit never includes command or stream token', async () => using({}, async f => {
  const admin = await f.login(), ticket = (await f.start(admin)).body;
  const response = await f.raw(ticket.streamUrl, admin), reader = response.body.getReader(); await reader.read();
  const audit = await f.request('/api/audit', admin), text = JSON.stringify(audit.body);
  assert.ok(!text.includes(process.execPath)); assert.ok(!text.includes(ticket.sessionId));
  f.app.close(); assert.equal(await f.stopped(), 'stopped'); await reader.cancel();
}));

test('revoking a regional camera scope stops an already playing stream', async () => using({ config: { cameraId: 'demo-1' } }, async f => {
  const admin = await f.login(), regional = await f.login('regional');
  const ticket = await f.request('/api/cameras/demo-1/live', regional, { method: 'POST' });
  assert.equal(ticket.status, 201);
  const response = await f.raw(ticket.body.streamUrl, regional), reader = response.body.getReader(); await reader.read();
  const changed = await f.request(`/api/users/${regional.user.id}`, admin, { method: 'PATCH', body: { stationIds: [], cameraIds: [] } });
  assert.equal(changed.status, 200);
  assert.equal(await f.stopped(), 'stopped'); await reader.cancel();
  assert.equal((await f.request(ticket.body.streamUrl, regional)).status, 403);
}));

test('unused ticket expires without starting any subprocess and frees its slot', async () => using({}, async f => {
  const manager = createLiveManager({ configFile: f.liveConfigFile, cameraIds: ['probe-c300'], ticketTtlMs: 50 });
  try {
    const first = manager.create('probe-c300', 'owner', 'login');
    await delay(80);
    const next = manager.create('probe-c300', 'owner', 'login');
    assert.notEqual(next.sessionId, first.sessionId);
  } finally { manager.close(); }
}));

test('invalid local live config fails closed without exposing command values', async () => using({ config: { command: 'relative-program', args: ['PRIVATE_SECRET'] } }, async f => {
  const admin = await f.login();
  const response = await f.start(admin);
  assert.equal(response.status, 503);
  assert.ok(!JSON.stringify(response.body).includes('PRIVATE_SECRET'));
  assert.equal((await f.request('/api/cameras/probe-c300/playback', admin)).body.live.status, 'not_connected');
}));

test('live startup configuration accepts 110 seconds and caps excessive values at that default', async () => {
  assert.equal(typeof liveHelpers.loadLiveConfiguration, 'function');
  for (const input of [110000, 110001]) await using({ config: { startupTimeoutMs: input } }, async f => {
    const config = liveHelpers.loadLiveConfiguration(f.liveConfigFile, new Set(['probe-c300']));
    assert.equal(config.startupTimeoutMs, 110000);
    assert.equal(config.maxDurationSeconds, 10, 'startup budget does not extend the viewing session');
  });
});

test('graceful server shutdown closes active HTTP video and waits for bridge cleanup before returning', async () => using({ cleanupDelayMs: 200 }, async f => {
  assert.equal(typeof liveHelpers.closePilotServer, 'function');
  const admin = await f.login(), ticket = (await f.start(admin)).body;
  const response = await f.raw(ticket.streamUrl, admin), reader = response.body.getReader(); await reader.read();
  const started = Date.now();
  await liveHelpers.closePilotServer(f.app, f.server);
  assert.equal(f.server.listening, false);
  assert.equal(await readFile(path.join(path.dirname(f.liveConfigFile), 'stopped.txt'), 'utf8'), 'stopped');
  assert.ok(Date.now() - started >= 180, 'shutdown must await actual subprocess STOP cleanup');
  assert.ok(Date.now() - started < 2000, 'active stream must not hold shutdown until its ten-second lifetime');
  await reader.cancel();
}));

test('STOP grace permits a slow bridge to finish descendant cleanup beyond two seconds', async () => using({ cleanupDelayMs: 2400 }, async f => {
  const admin = await f.login(), ticket = (await f.start(admin)).body;
  const response = await f.raw(ticket.streamUrl, admin), reader = response.body.getReader(); await reader.read();
  const started = Date.now();
  await liveHelpers.closePilotServer(f.app, f.server);
  assert.equal(await readFile(path.join(path.dirname(f.liveConfigFile), 'stopped.txt'), 'utf8'), 'stopped');
  assert.ok(Date.now() - started >= 2300, 'bridge must survive the old two-second cutoff');
  assert.ok(Date.now() - started < 5000, 'bridge cleanup should finish before the new forced cutoff');
  await reader.cancel();
}));

const parallelRoutes = config => [config,
  { ...config, cameraId: 'camera-two', args: [config.args[0], path.join(config.cwd, 'stopped-two.txt'), 'second-stream'] },
  { ...config, cameraId: 'demo-1', args: [config.args[0], path.join(config.cwd, 'stopped-three.txt'), 'third-stream'] },
];
const openReader = async (f, ticket, session) => {
  const response = await f.raw(ticket.streamUrl, session);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value.length);
  return reader;
};

test('parallel live capacity is explicit, bounded and shared by tickets and streams', async () => {
  assert.equal(loadConfig({}).liveMaxStreams, 1);
  assert.equal(loadConfig({ PILOT_LIVE_MAX_STREAMS: '5' }).liveMaxStreams, 5);
  assert.equal(loadConfig({ PILOT_LIVE_MAX_STREAMS: '10' }).liveMaxStreams, 10);
  assert.equal(loadConfig({ PILOT_LIVE_MAX_STREAMS: '150' }).liveMaxStreams, 150);
  for (const value of ['', '0', '151', '1.5', '-1', 'false', ' 5', '05', '1e2'])
    assert.throws(() => loadConfig({ PILOT_LIVE_MAX_STREAMS: value }), /LIVE_MAX_STREAMS/);
  await using({ liveMaxStreams: 2, routes: parallelRoutes }, async f => {
    const anonymous = await f.request('/api/session');
    assert.deepEqual(anonymous.body.liveLimits, { maxStreams: 2 });
    const admin = await f.login();
    assert.deepEqual(admin.liveLimits, { maxStreams: 2 });
    const first = await f.start(admin), second = await f.start(admin, 'camera-two');
    assert.equal(first.status, 201); assert.equal(second.status, 201);
    const full = await f.start(admin, 'demo-1');
    assert.equal(full.status, 409); assert.equal(full.body.code, 'LIVE_BUSY');
    assert.equal((await f.request(first.body.stopUrl, admin, { method: 'DELETE' })).status, 200);
    assert.equal((await f.start(admin, 'demo-1')).status, 201);
  });
});

test('two live subprocesses play independently and stopping one leaves the other active', async () => using({
  liveMaxStreams: 2, routes: parallelRoutes,
}, async f => {
  const admin = await f.login();
  const first = await f.start(admin), second = await f.start(admin, 'camera-two');
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  const firstReader = await openReader(f, first.body, admin), secondReader = await openReader(f, second.body, admin);
  const duplicate = await f.start(admin, 'camera-two');
  assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'LIVE_DUPLICATE');
  assert.equal((await f.request(first.body.stopUrl, admin, { method: 'DELETE' })).status, 200);
  assert.equal(await f.stopped(), 'stopped');
  assert.match(Buffer.from((await secondReader.read()).value).toString(), /second-stream/);
  assert.equal((await f.start(admin)).status, 201);
  assert.equal((await f.request(second.body.stopUrl, admin, { method: 'DELETE' })).status, 200);
  assert.equal(await f.stopped('stopped-two.txt'), 'stopped');
  await firstReader.cancel(); await secondReader.cancel();
}));

test('logout stops every stream of that exact login while another login continues', async () => using({
  liveMaxStreams: 3, routes: parallelRoutes,
}, async f => {
  const admin = await f.login(), another = await f.login();
  const first = await f.start(admin), second = await f.start(admin, 'camera-two'), third = await f.start(another, 'demo-1');
  assert.equal(first.status, 201); assert.equal(second.status, 201); assert.equal(third.status, 201);
  const readers = [await openReader(f, first.body, admin), await openReader(f, second.body, admin), await openReader(f, third.body, another)];
  assert.equal((await f.request(second.body.stopUrl, another, { method: 'DELETE' })).status, 403);
  assert.equal((await f.request(first.body.streamUrl, another)).status, 403);
  assert.equal((await f.request('/api/logout', admin, { method: 'POST' })).status, 200);
  assert.equal(await f.stopped(), 'stopped');
  assert.equal(await f.stopped('stopped-two.txt'), 'stopped');
  assert.match(Buffer.from((await readers[2].read()).value).toString(), /third-stream/);
  assert.equal((await f.request(third.body.stopUrl, another, { method: 'DELETE' })).status, 200);
  await Promise.all(readers.map(reader => reader.cancel()));
}));

test('revocation stops all affected parallel streams while an administrator stream continues', async () => using({
  liveMaxStreams: 3, routes: config => [config,
    { ...config, cameraId: 'demo-1', args: [config.args[0], path.join(config.cwd, 'stopped-two.txt'), 'regional-one'] },
    { ...config, cameraId: 'demo-2', args: [config.args[0], path.join(config.cwd, 'stopped-three.txt'), 'regional-two'] }],
}, async f => {
  const admin = await f.login(), regional = await f.login('regional');
  const first = await f.start(regional, 'demo-1'), second = await f.start(regional, 'demo-2'), third = await f.start(admin);
  assert.equal(first.status, 201); assert.equal(second.status, 201); assert.equal(third.status, 201);
  const readers = [await openReader(f, first.body, regional), await openReader(f, second.body, regional), await openReader(f, third.body, admin)];
  const changed = await f.request(`/api/users/${regional.user.id}`, admin, { method: 'PATCH', body: { stationIds: [], cameraIds: [] } });
  assert.equal(changed.status, 200);
  assert.equal(await f.stopped('stopped-two.txt'), 'stopped');
  assert.equal(await f.stopped('stopped-three.txt'), 'stopped');
  assert.match(Buffer.from((await readers[2].read()).value).toString(), /synthetic-fmp4-bytes/);
  assert.equal((await f.request(third.body.stopUrl, admin, { method: 'DELETE' })).status, 200);
  await Promise.all(readers.map(reader => reader.cancel()));
}));

test('server shutdown waits for all parallel subprocesses and releases every stream', async () => using({
  liveMaxStreams: 2, cleanupDelayMs: 200, routes: parallelRoutes,
}, async f => {
  const admin = await f.login(), first = await f.start(admin), second = await f.start(admin, 'camera-two');
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  const readers = [await openReader(f, first.body, admin), await openReader(f, second.body, admin)];
  await liveHelpers.closePilotServer(f.app, f.server);
  assert.equal(f.server.listening, false);
  assert.equal(await f.stopped(), 'stopped');
  assert.equal(await f.stopped('stopped-two.txt'), 'stopped');
  await Promise.all(readers.map(reader => reader.cancel()));
}));

test('route replacement revokes every affected ticket without clearing unrelated sessions', async () => using({
  routes: parallelRoutes,
}, async f => {
  const manager = createLiveManager({ configFile: f.liveConfigFile, cameraIds: ['probe-c300', 'camera-two', 'demo-1'], maxStreams: 3 });
  try {
    const configuration = JSON.parse(await readFile(f.liveConfigFile, 'utf8'));
    const first = manager.create('probe-c300', 'owner', 'login');
    const second = manager.create('camera-two', 'owner', 'login');
    const third = manager.create('demo-1', 'other', 'another-login');
    manager.replaceRoutes(configuration.cameras, new Set(['probe-c300', 'camera-two']));
    for (const [camera, ticket] of [['probe-c300', first], ['camera-two', second]])
      assert.throws(() => manager.stop(camera, ticket.sessionId, 'owner', 'login'), { code: 'LIVE_FORBIDDEN' });
    assert.throws(() => manager.create('demo-1', 'other', 'another-login'), { code: 'LIVE_DUPLICATE' });
    assert.ok(manager.create('probe-c300', 'owner', 'login').sessionId);
    assert.ok(manager.create('camera-two', 'owner', 'login').sessionId);
    assert.throws(() => manager.create('probe-c300', 'new-owner', 'new-login'), { code: 'LIVE_BUSY' });
    await manager.stop('demo-1', third.sessionId, 'other', 'another-login');
  } finally { await manager.close(); }
}));

test('invalid direct live limits fail before opening a store or starting a subprocess', async () => {
  for (const maxStreams of [0, 151, 1.5, '5', true, null, NaN]) {
    assert.throws(() => createLiveManager({ cameraIds: [], maxStreams }), /LIVE_MAX_STREAMS/);
    assert.throws(() => createApp({ liveMaxStreams: maxStreams, dbPath: ':memory:' }), /LIVE_MAX_STREAMS/);
  }
});

test('a stopping parallel subprocess keeps its capacity slot until its close event', async () => using({
  liveMaxStreams: 2, cleanupDelayMs: 300, routes: parallelRoutes,
}, async f => {
  const admin = await f.login(), first = await f.start(admin), second = await f.start(admin, 'camera-two');
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  const readers = [await openReader(f, first.body, admin), await openReader(f, second.body, admin)];
  const stopping = f.request(first.body.stopUrl, admin, { method: 'DELETE' });
  await delay(40);
  const beforeClose = await f.start(admin, 'demo-1');
  assert.equal(beforeClose.status, 409); assert.equal(beforeClose.body.code, 'LIVE_BUSY');
  assert.equal((await stopping).status, 200);
  assert.equal((await f.start(admin, 'demo-1')).status, 201);
  assert.match(Buffer.from((await readers[1].read()).value).toString(), /second-stream/);
  await Promise.all(readers.map(reader => reader.cancel()));
}));
