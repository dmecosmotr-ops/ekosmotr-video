import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../backend/app.mjs';
import { DatabaseSync } from 'node:sqlite';

const accounts = {
  admin: { email: 'admin@ekosmotr.local', password: 'Pilot-Admin-2026!' },
  director: { email: 'director@ekosmotr.local', password: 'Pilot-Director-2026!' },
  regional: { email: 'regional@ekosmotr.local', password: 'Pilot-Region-2026!' },
};
const demoDate = '2026-10-30';
const stations = Array.from({ length: 20 }, (_, i) => ({
  id: `test-station-${i + 1}`,
  region: i < 5 ? 'Свердловская область' : i < 10 ? 'Новосибирская область' : 'Краснодарский край',
  city: i < 5 ? 'Екатеринбург' : i < 10 ? 'Новосибирск' : 'Краснодар',
  address: `${i < 5 ? 'Екатеринбург' : i < 10 ? 'Новосибирск' : 'Краснодар'}, Тестовая улица, ${i + 1}`,
  manager: `Тестовый руководитель ${Math.floor(i / 5) + 1}`,
}));

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'camera-pilot-api-'));
  const stationFile = path.join(dir, 'stations.json');
  const mediaFile = path.join(dir, 'sample.mp4');
  const dbPath = path.join(dir, 'pilot.sqlite');
  await writeFile(stationFile, JSON.stringify(stations));
  await writeFile(mediaFile, Buffer.from('0123456789'));
  let server;
  let handler;
  let base;

  async function start() {
    handler = await createApp({ dbPath, stationFile, mediaFile });
    server = createServer(handler);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await handler.close();
    server = null;
  }
  await start();

  async function request(url, options = {}) {
    const headers = { ...options.headers };
    if (options.session?.cookie) headers.Cookie = options.session.cookie;
    if (options.csrf !== false && options.session?.csrfToken) {
      headers['X-CSRF-Token'] = options.session.csrfToken;
    }
    let body;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await fetch(base + url, {
      method: options.method || 'GET', headers, body, redirect: 'manual',
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let value;
    if (response.headers.get('content-type')?.includes('application/json')) {
      value = JSON.parse(bytes.toString('utf8'));
    } else value = bytes;
    return {
      status: response.status,
      body: value,
      headers: response.headers,
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }

  async function login(roleOrCredentials) {
    const credentials = typeof roleOrCredentials === 'string' ? accounts[roleOrCredentials] : roleOrCredentials;
    const result = await request('/api/login', { method: 'POST', body: credentials });
    assert.equal(result.status, 200, `login failed with status ${result.status}`);
    assert.equal(result.body.user.email, credentials.email);
    assert.ok(result.cookie, 'login must set a session cookie');
    assert.ok(result.body.csrfToken, 'login must provide a CSRF token');
    return { cookie: result.cookie, csrfToken: result.body.csrfToken, user: result.body.user };
  }

  async function close() {
    await stop();
    // Only delete this fixture's verified direct child of the system temp directory.
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.match(path.basename(resolved), /^camera-pilot-api-/);
    await rm(resolved, { recursive: true, force: true });
  }
  return { request, login, close, stop, start, dbPath, mediaFile };
}

async function withFixture(fn) {
  const f = await fixture();
  try { await fn(f); } finally { await f.close(); }
}

test('unauthenticated callers cannot read station, user, event or probe resources', async () => {
  await withFixture(async f => {
    const session = await f.request('/api/session');
    assert.equal(session.status, 200);
    assert.equal(session.body.user, null);
    for (const route of ['/api/stations', '/api/cameras', '/api/events', '/api/users', '/api/audit', '/api/cameras/probe-c300/media']) {
      assert.equal((await f.request(route)).status, 401, route);
    }
    const health = await f.request('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
  });
});

test('login establishes an HttpOnly strict session and logout invalidates the old cookie', async () => {
  await withFixture(async f => {
    const wrong = await f.request('/api/login', { method: 'POST', body: { ...accounts.admin, password: 'incorrect' } });
    assert.equal(wrong.status, 401);
    const result = await f.request('/api/login', { method: 'POST', body: accounts.admin });
    assert.equal(result.status, 200);
    assert.match(result.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(result.headers.get('set-cookie'), /SameSite=Strict/i);
    assert.doesNotMatch(JSON.stringify(result.body), /Pilot-Admin-2026!/);
    const session = { cookie: result.cookie, csrfToken: result.body.csrfToken };
    const restored = await f.request('/api/session', { session });
    assert.equal(restored.body.user.role, 'admin');
    assert.match(restored.headers.get('cache-control'), /no-store/);
    assert.equal((await f.request('/api/logout', { method: 'POST', session })).status, 200);
    assert.equal((await f.request('/api/stations', { session })).status, 401);
  });
});

test('CSRF and foreign origin checks apply to state changes and login', async () => {
  await withFixture(async f => {
    const admin = await f.login('admin');
    const payload = { name: 'CSRF test', email: 'csrf@pilot.local', password: 'Test-Password-2026!', role: 'regional', stationIds: [], cameraIds: [] };
    assert.equal((await f.request('/api/users', { method: 'POST', session: admin, csrf: false, body: payload })).status, 403);
    assert.equal((await f.request('/api/users', { method: 'POST', session: admin, headers: { Origin: 'https://untrusted.invalid' }, body: payload })).status, 403);
    assert.equal((await f.request('/api/login', { method: 'POST', headers: { Origin: 'https://untrusted.invalid' }, body: accounts.admin })).status, 403);
    assert.equal((await f.request('/api/logout', { method: 'POST', session: admin, csrf: false })).status, 403);
  });
});

test('director can delegate own station scope but cannot grant an outside station or an administrator role', async () => {
  await withFixture(async f => {
    const director = await f.login('director');
    const ownStations = (await f.request('/api/stations', { session: director })).body.stations;
    assert.equal(ownStations.length, 10);
    const own = ownStations[0].id;
    const outside = stations.find(station => !ownStations.some(visible => visible.id === station.id)).id;
    const payload = { name: 'Региональный тест', email: 'delegate@pilot.local', password: 'Test-Delegate-2026!', role: 'regional', stationIds: [own], cameraIds: [] };
    assert.equal((await f.request('/api/users', { method: 'POST', session: director, body: { ...payload, role: 'admin' } })).status, 403);
    assert.equal((await f.request('/api/users', { method: 'POST', session: director, body: { ...payload, role: 'director' } })).status, 403);
    assert.equal((await f.request('/api/users', { method: 'POST', session: director, body: { ...payload, stationIds: [outside] } })).status, 403);
    const created = await f.request('/api/users', { method: 'POST', session: director, body: payload });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.role, 'regional');
    assert.deepEqual(created.body.user.stationIds, [own]);
    const delegated = await f.login({ email: payload.email, password: payload.password });
    assert.deepEqual((await f.request('/api/stations', { session: delegated })).body.stations.map(station => station.id), [own]);
    assert.equal((await f.request('/api/users', { session: delegated })).status, 403);
    assert.equal((await f.request('/api/audit', { session: delegated })).status, 403);
    assert.equal((await f.request(`/api/users/${created.body.user.id}`, { method: 'PATCH', session: director, body: { stationIds: [outside] } })).status, 403);
  });
});

test('camera-only access exposes only its camera, its station and its events; unobserved dates stay null', async () => {
  await withFixture(async f => {
    const admin = await f.login('admin');
    const demoCameras = (await f.request(`/api/cameras?date=${demoDate}`, { session: admin })).body.cameras.filter(camera => camera.stationId && camera.status === 'demo');
    assert.ok(demoCameras.length >= 2);
    const allowed = demoCameras[0];
    const hidden = demoCameras.find(camera => camera.id !== allowed.id);
    const password = 'Test-Camera-Only-2026!';
    const created = await f.request('/api/users', { method: 'POST', session: admin, body: {
      name: 'Одна камера', email: 'camera-only@pilot.local', password,
      role: 'regional', stationIds: [], cameraIds: [allowed.id],
    } });
    assert.equal(created.status, 201);
    const regional = await f.login({ email: 'camera-only@pilot.local', password });
    const visibleCameras = (await f.request(`/api/cameras?date=${demoDate}`, { session: regional })).body.cameras;
    assert.deepEqual(visibleCameras.map(camera => camera.id), [allowed.id]);
    const visibleStations = (await f.request(`/api/stations?date=${demoDate}`, { session: regional })).body.stations;
    assert.deepEqual(visibleStations.map(station => station.id), [allowed.stationId]);
    assert.equal(visibleStations[0].cameraCount, 1);
    const events = (await f.request(`/api/events?date=${demoDate}`, { session: regional })).body.events;
    assert.ok(events.length > 0);
    assert.ok(events.every(event => event.cameraId === allowed.id && event.source === 'demo'));
    const hiddenQuery = await f.request(`/api/events?date=${demoDate}&cameraId=${encodeURIComponent(hidden.id)}`, { session: regional });
    assert.ok([200, 403, 404].includes(hiddenQuery.status));
    if (hiddenQuery.status === 200) assert.deepEqual(hiddenQuery.body.events, []);
    const otherDate = (await f.request('/api/stations?date=2026-10-31', { session: regional })).body.stations;
    assert.equal(otherDate[0].metrics.source, 'none');
    for (const key of ['openedAt', 'closedAt', 'firstSeenAt', 'entries']) assert.equal(otherDate[0].metrics[key], null, key);
  });
});

test('probe media is admin-only, supports ranges, and cannot be reached through traversal paths', async () => {
  await withFixture(async f => {
    const admin = await f.login('admin');
    const director = await f.login('director');
    const regional = await f.login('regional');
    const listed = (await f.request('/api/cameras', { session: admin })).body.cameras;
    assert.equal(listed.find(camera => camera.id === 'probe-c300').archiveAvailable, true);
    assert.ok(listed.filter(camera => camera.id !== 'probe-c300').every(camera => camera.archiveAvailable === false));
    for (const session of [director, regional]) {
      const result = await f.request('/api/cameras/probe-c300/media', { session });
      assert.ok([403, 404].includes(result.status));
      const cameras = (await f.request('/api/cameras', { session })).body.cameras;
      assert.ok(cameras.every(camera => camera.id !== 'probe-c300'));
    }
    const full = await f.request('/api/cameras/probe-c300/media', { session: admin });
    assert.equal(full.status, 200);
    assert.equal(full.body.toString('utf8'), '0123456789');
    const range = await f.request('/api/cameras/probe-c300/media', { session: admin, headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(range.body.toString('utf8'), '2345');
    assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
    for (const route of ['/api/cameras/%2e%2e%2f%2e%2e%2fsecret/media', '/%2e%2e%2f%2e%2e%2fCONTRACT.md', '/api/cameras/probe-c300/media/../../secret']) {
      const response = await f.request(route, { session: admin });
      assert.ok(response.status >= 400, route);
      assert.doesNotMatch(response.body.toString?.('utf8') || JSON.stringify(response.body), /Pilot-Admin-2026!/);
    }
  });
});

test('список камер не обещает архив при отсутствии файла и совпадает с playback', async () => {
  await withFixture(async f => {
    const admin = await f.login('admin');
    await rm(f.mediaFile);
    const listed = (await f.request('/api/cameras', { session: admin })).body.cameras;
    assert.equal(listed.find(camera => camera.id === 'probe-c300').archiveAvailable, false);
    const playback = await f.request('/api/cameras/probe-c300/playback', { session: admin });
    assert.equal(playback.body.archive.status, 'not_connected');
  });
});

test('saved users and exact grants survive restarting the backend with the same database', async () => {
  await withFixture(async f => {
    const admin = await f.login('admin');
    const payload = { name: 'Сохранённый пользователь', email: 'persistent@pilot.local', password: 'Test-Persistent-2026!', role: 'regional', stationIds: [stations[12].id], cameraIds: [] };
    const result = await f.request('/api/users', { method: 'POST', session: admin, body: payload });
    assert.equal(result.status, 201);
    await f.stop();
    await f.start();
    const persisted = await f.login({ email: payload.email, password: payload.password });
    assert.equal(persisted.user.id, result.body.user.id);
    assert.deepEqual(persisted.user.stationIds, payload.stationIds);
    assert.deepEqual((await f.request('/api/stations', { session: persisted })).body.stations.map(station => station.id), payload.stationIds);
  });
});

test('deactivation revokes an active session and the last administrator cannot be disabled', async () => {
  await withFixture(async f => {
    const admin = await f.login('admin');
    const regional = await f.login('regional');
    const users = (await f.request('/api/users', { session: admin })).body.users;
    const target = users.find(user => user.email === accounts.regional.email);
    assert.ok(target);
    const deactivated = await f.request(`/api/users/${target.id}`, { method: 'PATCH', session: admin, body: { active: false } });
    assert.equal(deactivated.status, 200);
    assert.equal((await f.request('/api/stations', { session: regional })).status, 401);
    assert.equal((await f.request('/api/login', { method: 'POST', body: accounts.regional })).status, 401);
    const lastAdmin = await f.request(`/api/users/${admin.user.id}`, { method: 'PATCH', session: admin, body: { active: false } });
    assert.ok([400, 403, 409].includes(lastAdmin.status));
    assert.equal((await f.request('/api/stations', { session: admin })).status, 200);
  });
});

test('audit records changes without exposing passwords, cookie or CSRF secrets', async () => {
  await withFixture(async f => {
    const admin = await f.login('admin');
    const password = 'Test-Audit-Secret-2026!';
    const created = await f.request('/api/users', { method: 'POST', session: admin, body: {
      name: 'Журнал тест', email: 'audit@pilot.local', password, role: 'regional', stationIds: [], cameraIds: [],
    } });
    assert.equal(created.status, 201);
    const audit = await f.request('/api/audit', { session: admin });
    assert.equal(audit.status, 200);
    assert.ok(audit.body.events.length > 0);
    const serialized = JSON.stringify(audit.body);
    for (const secret of [password, accounts.admin.password, admin.cookie, admin.csrfToken]) assert.equal(serialized.includes(secret), false);
  });
});

test('delegated regional rights shrink with director scope and disappear when the parent is inactive, demoted or missing', async () => {
  await withFixture(async f => {
    const admin = await f.login('admin');
    const director = await f.login('director');
    const camera = (await f.request('/api/cameras', { session: director })).body.cameras.find(c => c.stationId && c.status === 'demo');
    assert.ok(camera);
    const payload = { name: 'Делегированный доступ', email: 'inherited@pilot.local', password: 'Test-Inherited-2026!',
      role: 'regional', stationIds: [camera.stationId], cameraIds: [] };
    assert.equal((await f.request('/api/users', { method: 'POST', session: director, body: payload })).status, 201);
    const regional = await f.login({ email: payload.email, password: payload.password });
    const independentPayload = { ...payload, email: 'independent@pilot.local', name: 'Прямой доступ администратора' };
    assert.equal((await f.request('/api/users', { method: 'POST', session: admin, body: independentPayload })).status, 201);
    const independent = await f.login({ email: independentPayload.email, password: independentPayload.password });

    const restricted = await f.request(`/api/users/${director.user.id}`, { method: 'PATCH', session: admin,
      body: { stationIds: [], cameraIds: [camera.id] } });
    assert.equal(restricted.status, 200);
    const refreshed = (await f.request('/api/session', { session: regional })).body.user;
    assert.deepEqual(refreshed.stationIds, []);
    assert.deepEqual(refreshed.cameraIds, [camera.id]);
    const effectiveCameras = (await f.request('/api/cameras', { session: regional })).body.cameras;
    assert.deepEqual(effectiveCameras.map(c => c.id), [camera.id]);
    const effectiveStations = (await f.request('/api/stations', { session: regional })).body.stations;
    assert.equal(effectiveStations.length, 1);
    assert.equal(effectiveStations[0].cameraCount, 1);
    assert.equal(effectiveStations[0].metrics.entries, camera.metrics.entries);
    assert.ok((await f.request('/api/events', { session: regional })).body.events.every(e => e.cameraId === camera.id));
    const managed = (await f.request('/api/users', { session: director })).body.users.find(u => u.email === payload.email);
    assert.deepEqual(managed.stationIds, []);
    assert.deepEqual(managed.cameraIds, [camera.id]);

    // A real UI editor can submit all unchanged effective grants with a name edit.
    // That must neither detach delegation nor overwrite the stored intended scope.
    const adminVisible = (await f.request('/api/users', { session: admin })).body.users.find(u => u.email === payload.email);
    const renamed = await f.request(`/api/users/${adminVisible.id}`, { method: 'PATCH', session: admin,
      body: { name: 'Переименован через полный UI payload', email: adminVisible.email,
        role: adminVisible.role, stationIds: [...adminVisible.stationIds].reverse(),
        cameraIds: [...adminVisible.cameraIds].reverse(), active: adminVisible.active } });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.body.user.stationIds, []);
    assert.deepEqual(renamed.body.user.cameraIds, [camera.id]);
    const stored = new DatabaseSync(f.dbPath);
    const storedChild = stored.prepare('SELECT station_ids,camera_ids,delegated_by FROM users WHERE id=?').get(adminVisible.id);
    assert.equal(storedChild.delegated_by, director.user.id);
    assert.deepEqual(JSON.parse(storedChild.station_ids), [camera.stationId]);
    assert.deepEqual(JSON.parse(storedChild.camera_ids), []);
    stored.close();

    const assertRevoked = async () => {
      const session = (await f.request('/api/session', { session: regional })).body;
      assert.equal(session.user.role, 'regional');
      assert.deepEqual(session.user.stationIds, []);
      assert.deepEqual(session.user.cameraIds, []);
      assert.deepEqual((await f.request('/api/stations', { session: regional })).body.stations, []);
      assert.deepEqual((await f.request('/api/cameras', { session: regional })).body.cameras, []);
      assert.deepEqual((await f.request('/api/events', { session: regional })).body.events, []);
      assert.equal((await f.request('/api/stations', { session: independent })).body.stations.length, 1);
    };
    assert.equal((await f.request(`/api/users/${director.user.id}`, { method: 'PATCH', session: admin, body: { active: false } })).status, 200);
    await assertRevoked();
    assert.equal((await f.request(`/api/users/${director.user.id}`, { method: 'PATCH', session: admin, body: { active: true, role: 'regional' } })).status, 200);
    await assertRevoked();
    const direct = new DatabaseSync(f.dbPath);
    direct.exec('PRAGMA foreign_keys=ON');
    direct.prepare('DELETE FROM sessions WHERE user_id=?').run(director.user.id);
    direct.prepare('DELETE FROM users WHERE id=?').run(director.user.id);
    direct.close();
    await assertRevoked();
  });
});
