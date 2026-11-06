import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../backend/app.mjs';
import { loadConfig } from '../backend/config.mjs';
import { closePilotServer } from '../backend/live.mjs';

const camera = (id, stationId) => ({ id, name: `Camera ${id}`, model: 'test.camera', mapping: 'confirm',
  ...(stationId && { stationId }) });
const writeJson = (file, value) => writeFile(file, JSON.stringify(value));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'camera-xiaomi-sync-'));
  const syncDir = join(root, 'private', 'sync');
  const marker = join(root, 'bridge-stopped');
  const script = join(root, 'bridge.mjs');
  const inventoryFile = join(root, 'fallback.json');
  const stationFile = join(root, 'stations.json');
  await mkdir(syncDir, { recursive: true });
  await writeJson(stationFile, Array.from({ length: 5 }, (_, i) => ({ id: `s${i + 1}`,
    city: 'Test', region: 'Test', address: `Test address ${i + 1}`, manager: 'Test' })));
  await writeJson(inventoryFile, [camera('fallback', 's1')]);
  await writeFile(script, `import { writeFileSync } from 'node:fs';
const stop = () => { writeFileSync(process.argv[2], 'stopped'); process.exit(0); };
process.stdin.on('data', data => { if (data.toString().includes('STOP')) stop(); });
setInterval(() => process.stdout.write('fixture video'), 30);
`);
  let app, server, base, revision = 0;
  async function boot() {
    app = createApp({ dbPath: join(root, 'pilot.sqlite'), stationFile, inventoryFile, xiaomiSyncDir: syncDir });
    server = createServer(app);
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() {
    if (server?.listening) await closePilotServer(app, server);
    else await app?.close();
  }
  t.after(async () => {
    await close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.match(basename(root), /^camera-xiaomi-sync-/);
    await rm(root, { recursive: true, force: true });
  });
  await boot();
  async function publish(cameras, routes = []) {
    const generation = `gen-${(++revision).toString(16).padStart(32, '0')}`;
    const folder = join(syncDir, generation);
    await mkdir(folder);
    await writeJson(join(folder, 'camera-inventory.json'), { version: 1, cameras });
    await writeJson(join(folder, 'live-config.json'), { cameras: routes.map(cameraId => ({
      cameraId, command: process.execPath, cwd: root, args: [script, marker], startupTimeoutMs: 2000,
    })) });
    await writeJson(join(syncDir, 'pointer.tmp'), { version: 1, generation });
    await rename(join(syncDir, 'pointer.tmp'), join(syncDir, 'current.json'));
  }
  function request(url, session, options = {}) {
    return fetch(base + url, { method: options.method,
      headers: { ...(session && { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken }),
        ...(options.body && { 'Content-Type': 'application/json' }) },
      body: options.body && JSON.stringify(options.body) });
  }
  async function login(email = 'admin@ekosmotr.local', password = 'Pilot-Admin-2026!') {
    const result = await request('/api/login', null, { method: 'POST', body: { email, password } });
    assert.equal(result.status, 200);
    return { ...await result.json(), cookie: result.headers.get('set-cookie').split(';')[0] };
  }
  async function cameras(session) { return (await (await request('/api/cameras', session)).json()).cameras; }
  async function ticket(session, id) { return request(`/api/cameras/${id}/live`, session, { method: 'POST' }); }
  async function restart() { await close(); await boot(); }
  function startSlowGrant(session) {
    let incoming;
    const result = new Promise((done, reject) => {
      incoming = httpRequest(base + '/api/users', { method: 'POST', headers: {
        Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json',
      } }, response => { response.resume(); response.on('end', () => done(response.statusCode)); });
      incoming.once('error', reject);
      incoming.write(' ');
    });
    return { result, finish: body => incoming.end(JSON.stringify(body)) };
  }
  return { syncDir, marker, publish, login, cameras, ticket, request, restart, startSlowGrant };
}

test('sync opts in through server configuration', () => {
  const path = resolve('private/sync');
  assert.equal(loadConfig({ PILOT_XIAOMI_SYNC_DIR: path }).xiaomiSyncDir, path);
  assert.equal(loadConfig({}).xiaomiSyncDir, undefined);
});

test('catalog and routes update together and preserve the last valid generation across malformed updates and restart', async t => {
  const f = await fixture(t), admin = await f.login(), regional = await f.login('regional@ekosmotr.local', 'Pilot-Region-2026!');
  assert.ok((await f.cameras(admin)).some(item => item.id === 'fallback'));
  await f.publish([camera('new'), camera('mapped', 's1')], ['new']);
  const shown = await f.cameras(admin);
  assert.equal(shown.find(item => item.id === 'new')?.liveAvailable, true);
  assert.equal(shown.find(item => item.id === 'new')?.stationId, null);
  assert.ok(!shown.some(item => item.id === 'fallback'));
  const scoped = await f.cameras(regional);
  assert.ok(!scoped.some(item => item.id === 'new'));
  assert.ok(scoped.some(item => item.id === 'mapped'));
  assert.equal((await f.ticket(regional, 'new')).status, 403);
  assert.ok(!JSON.stringify(shown).includes(process.execPath));

  await f.publish([camera('invalid')], ['missing']);
  assert.equal((await f.cameras(admin)).find(item => item.id === 'new')?.liveAvailable, true);
  await writeJson(join(f.syncDir, 'current.json'), { version: 1, generation: '../outside' });
  await f.restart();
  assert.equal((await f.cameras(admin)).find(item => item.id === 'new')?.liveAvailable, true);
  await f.publish([]);
  assert.ok(!(await f.cameras(admin)).some(item => item.source === 'xiaomi_inventory'));
  assert.equal((await f.ticket(admin, 'new')).status, 403);
});

test('station moves stop an active bridge without a request and remove old camera-specific grants', async t => {
  const f = await fixture(t), admin = await f.login();
  await f.publish([camera('moved', 's1')], ['moved']);
  const email = 'sync-fixture@local.invalid', password = 'Fixture-2026-Access!';
  assert.equal((await f.request('/api/users', admin, { method: 'POST', body: {
    email, password, role: 'regional', name: 'Sync fixture', stationIds: [], cameraIds: ['moved'],
  } })).status, 201);
  const regional = await f.login(email, password);
  const ticket = await f.ticket(regional, 'moved');
  assert.equal(ticket.status, 201);
  const stream = await f.request((await ticket.json()).streamUrl, regional);
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  assert.ok((await reader.read()).value.length);

  await f.publish([camera('moved', 's1'), camera('other')], ['moved']);
  assert.ok((await f.cameras(regional)).some(item => item.id === 'moved'));
  assert.ok((await reader.read()).value.length);
  await f.publish([camera('moved', 's3')], ['moved']);
  let stopped = false;
  for (let i = 0; i < 80; i++) {
    try { stopped = (await readFile(f.marker, 'utf8')) === 'stopped'; } catch {}
    if (stopped) break;
    await delay(25);
  }
  assert.ok(stopped, 'bridge stopped after background sync without API traffic');
  await reader.cancel();
  assert.equal((await f.ticket(regional, 'moved')).status, 403);
  assert.equal((await f.cameras(admin)).find(item => item.id === 'moved')?.stationId, 's3');
  await f.restart();
  assert.equal((await f.ticket(regional, 'moved')).status, 403);
});

test('a director cannot delegate a revoked camera grant after waiting for a request body', async t => {
  const f = await fixture(t), admin = await f.login();
  await f.publish([camera('moved', 's1')], ['moved']);
  const email = 'director-fixture@local.invalid', password = 'Fixture-2026-Access!';
  assert.equal((await f.request('/api/users', admin, { method: 'POST', body: {
    email, password, role: 'director', name: 'Director fixture', stationIds: [], cameraIds: ['moved'],
  } })).status, 201);
  const director = await f.login(email, password);
  const pending = f.startSlowGrant(director);
  try {
    await delay(80);
    await f.publish([camera('moved', 's3')], ['moved']);
    assert.equal((await f.cameras(admin)).find(item => item.id === 'moved')?.stationId, 's3');
  } finally {
    pending.finish({ email: 'delegation-fixture@local.invalid', password, role: 'regional',
      name: 'Delegation fixture', stationIds: [], cameraIds: ['moved'] });
  }
  assert.equal(await pending.result, 403);
});
