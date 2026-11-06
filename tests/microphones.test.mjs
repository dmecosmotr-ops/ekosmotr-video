import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApp } from '../backend/app.mjs';

const adminAccount = { email: 'admin@ekosmotr.local', password: 'Pilot-Admin-2026!' };
const directorAccount = { email: 'director@ekosmotr.local', password: 'Pilot-Director-2026!' };
const syntheticAdmin = { email: 'owner@example.test', password: 'Synthetic-test-only-2026!' };
const publicOrigin = 'https://pilot.example.test';
const [alpha, beta] = [
  { id: 'test-alpha', region: 'Север', city: 'Тестовый А', address: 'Первая, 1', manager: 'Тест' },
  { id: 'test-beta', region: 'Юг', city: 'Тестовый Б', address: 'Вторая, 2', manager: 'Тест' },
];
const date = '2026-10-15';
const earlier = '2026-10-14';
const later = '2026-10-31';
const readyId = 'alpha-ready';
const pdf = id => `/api/microphones/reports/${id}/pdf`;
const list = '/api/microphones';
const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

function shifts() {
  return [
    { id: readyId, stationId: alpha.id, date, status: 'ready', pdf: 'alpha.pdf', demo: true,
      metrics: { offerEpisodes: 3, sales: 0, products: {
        first_aid_kit: { offerEpisodes: 2, sales: null },
        fire_extinguisher: { offerEpisodes: 0, sales: 0 },
      } } },
    { id: 'alpha-older', stationId: alpha.id, date: earlier, status: 'ready', pdf: 'alpha-older.pdf', demo: true,
      metrics: { offerEpisodes: 0, sales: null, products: {
        fire_extinguisher: { offerEpisodes: 0, sales: null },
        license_plate_frames: { offerEpisodes: 0, sales: null },
      } } },
    { id: 'alpha-processing', stationId: alpha.id, date, status: 'processing', demo: true },
    { id: 'alpha-missing', stationId: alpha.id, date, status: 'missing', demo: true },
    { id: 'beta-ready', stationId: beta.id, date: later, status: 'ready', pdf: 'beta.pdf', demo: true,
      metrics: { offerEpisodes: 19, sales: 13 } },
  ];
}

async function fixture(t, { serverMode = false, withCatalog = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'microphones-api-'));
  let server, handler;
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    }
    await handler?.close();
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.match(basename(dir), /^microphones-api-/);
    await rm(dir, { recursive: true, force: true });
  });
  const stationFile = join(dir, 'stations.json');
  const microphoneDir = join(dir, 'reports');
  const staticDir = join(dir, 'static');
  await mkdir(microphoneDir);
  await mkdir(staticDir);
  await writeFile(stationFile, JSON.stringify([alpha, beta]));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Test cabinet</title>');
  const writeCatalog = rows => writeFile(join(microphoneDir, 'catalog.json'), JSON.stringify({ version: 1, shifts: rows }));
  await writeCatalog(shifts());
  await Promise.all(['alpha.pdf', 'alpha-older.pdf', 'beta.pdf'].map(name => writeFile(join(microphoneDir, name), pdfBytes)));
  const adminPasswordFile = join(dir, 'test-password');
  if (serverMode) await writeFile(adminPasswordFile, syntheticAdmin.password);
  handler = createApp({ dbPath: join(dir, 'pilot.sqlite'), stationFile, staticDir,
    microphoneDir: withCatalog ? microphoneDir : undefined,
    deploymentConfig: serverMode ? { mode: 'server', publicOrigin, adminEmail: syntheticAdmin.email, adminPasswordFile } : undefined });
  server = createServer(handler);
  await new Promise((listen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', listen); });

  async function request(route, { session, method = 'GET', body, headers = {} } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const requestHeaders = { ...(serverMode && { Host: new URL(publicOrigin).host }), ...headers };
    if (session) {
      requestHeaders.Cookie = session.cookie;
      requestHeaders['X-CSRF-Token'] = session.csrfToken;
    }
    if (payload !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    return new Promise((done, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: server.address().port, path: route, method, headers: requestHeaders }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          const json = bytes.length > 0 && res.headers['content-type']?.includes('application/json');
          done({ status: res.statusCode, headers: res.headers, body: json ? JSON.parse(bytes) : bytes,
            cookie: res.headers['set-cookie']?.[0]?.split(';')[0] });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  async function login(credentials = serverMode ? syntheticAdmin : adminAccount) {
    const response = await request('/api/login', { method: 'POST', body: credentials });
    assert.equal(response.status, 200);
    assert.ok(response.cookie);
    return { cookie: response.cookie, csrfToken: response.body.csrfToken, user: response.body.user };
  }

  function patchUser(session, id, body) {
    return request(`/api/users/${id}`, { session, method: 'PATCH', body });
  }

  return { dir, microphoneDir, request, login, patchUser, writeCatalog };
}

test('anonymous and camera-only sessions cannot open microphone reports, even via HEAD and byte ranges', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(list)).status, 401);
  assert.equal((await f.request(pdf(readyId), { method: 'HEAD', headers: { Range: 'bytes=0-3' } })).status, 401);

  const admin = await f.login();
  assert.deepEqual(admin.user.microphoneStationIds, []);
  assert.equal((await f.request(list, { session: admin })).status, 403);
  assert.equal((await f.request(pdf(readyId), { session: admin })).status, 403);

  const camera = (await f.request('/api/cameras', { session: admin })).body.cameras.find(item => item.stationId === alpha.id);
  assert.ok(camera);
  const credentials = { email: 'camera-only@example.test', password: 'Only-camera-test-2026!' };
  const created = await f.request('/api/users', { method: 'POST', session: admin, body: {
    ...credentials, name: 'Только камера', role: 'regional', cameraIds: [camera.id], stationIds: [],
  } });
  assert.equal(created.status, 201);
  const cameraUser = await f.login(credentials);
  assert.deepEqual((await f.request('/api/cameras', { session: cameraUser })).body.cameras.map(item => item.id), [camera.id]);
  assert.equal((await f.request(list, { session: cameraUser })).status, 403);
  const denied = await f.request(pdf(readyId), { session: cameraUser, headers: { Range: 'bytes=0-3' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers['x-frame-options'], 'DENY');
  assert.equal(denied.headers['content-range'], undefined);
});

test('report list, latest date, aggregates and direct PDF access stay inside the granted stations', async t => {
  const f = await fixture(t);
  const admin = await f.login();
  const grant = await f.patchUser(admin, admin.user.id, { microphoneStationIds: [alpha.id] });
  assert.equal(grant.status, 200);
  assert.deepEqual(grant.body.user.microphoneStationIds, [alpha.id]);

  const result = await f.request(list, { session: admin });
  assert.equal(result.status, 200);
  assert.equal(result.body.configured, true);
  assert.equal(result.body.latestDate, date);
  assert.deepEqual(result.body.stations.map(station => station.id), [alpha.id]);
  assert.ok(result.body.shifts.every(row => row.stationId === alpha.id && row.demo === true));
  assert.ok(result.body.shifts.every(row => !Object.hasOwn(row, 'pdf')));
  assert.deepEqual(new Set(result.body.shifts.map(row => row.id)), new Set(['alpha-ready', 'alpha-older', 'alpha-processing', 'alpha-missing']));
  const { ready, processing, missing, offerEpisodes, sales, products, coverage } = result.body.summary;
  assert.deepEqual({ ready, processing, missing, offerEpisodes, sales }, { ready: 2, processing: 1, missing: 1, offerEpisodes: 3, sales: 0 });
  assert.deepEqual(products.first_aid_kit, { offerEpisodes: 2, sales: null });
  assert.deepEqual(products.fire_extinguisher, { offerEpisodes: 0, sales: 0 });
  assert.deepEqual(products.warning_triangle, { offerEpisodes: null, sales: null });
  assert.deepEqual(coverage.products.fire_extinguisher, { offerEpisodes: 2, sales: 1 });
  assert.equal(coverage.offerEpisodes, 2);
  assert.equal(coverage.sales, 1);

  const filtered = await f.request(`${list}?from=${earlier}&to=${earlier}&region=${encodeURIComponent(alpha.region)}&stationId=${alpha.id}`, { session: admin });
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.shifts.map(row => row.id), ['alpha-older']);
  assert.equal(filtered.body.summary.offerEpisodes, 0);
  assert.equal(filtered.body.summary.sales, null);
  assert.equal(filtered.body.summary.missing, 0);

  for (const query of [`stationId=${beta.id}`, `region=${encodeURIComponent(beta.region)}`]) {
    const hidden = await f.request(`${list}?${query}`, { session: admin });
    assert.equal(hidden.status, 200);
    assert.deepEqual(hidden.body.shifts, []);
    assert.equal(hidden.body.latestDate, null);
    assert.equal(hidden.body.summary.offerEpisodes, null);
    assert.equal(hidden.body.summary.missing, 0);
  }

  const unknown = await f.request(pdf('not-a-report'), { session: admin });
  assert.equal(unknown.status, 404);
  for (const id of ['beta-ready', 'alpha-processing', 'alpha-missing']) {
    const result = await f.request(pdf(id), { session: admin });
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, unknown.body);
    assert.equal(result.headers['x-frame-options'], 'DENY');
  }

  const report = await f.request(pdf(readyId), { session: admin });
  assert.equal(report.status, 200);
  assert.deepEqual(report.body, pdfBytes);
  assert.equal(report.headers['content-type'], 'application/pdf');
  assert.match(report.headers['content-disposition'], /^inline\b/);
  assert.match(report.headers['cache-control'], /no-store/);
  assert.equal(report.headers['x-frame-options'], 'DENY');
  assert.match(report.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(report.headers['cross-origin-resource-policy'], 'same-origin');
  const head = await f.request(pdf(readyId), { session: admin, method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], String(pdfBytes.length));
  const range = await f.request(pdf(readyId), { session: admin, headers: { Range: 'bytes=0-4' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-range'], `bytes 0-4/${pdfBytes.length}`);
  assert.equal(range.body.toString(), '%PDF-');
  const cabinet = await f.request('/');
  assert.equal(cabinet.headers['x-frame-options'], 'DENY');
  assert.match(cabinet.headers['content-security-policy'], /frame-ancestors 'none'/);
  for (const route of ['/alpha.pdf', '/reports/alpha.pdf', '/%2e%2e/reports/alpha.pdf']) {
    assert.equal((await f.request(route)).status, 404);
  }
});

test('only administrators can set microphone scope, and changes apply to the current session', async t => {
  const f = await fixture(t);
  const admin = await f.login();
  const director = await f.login(directorAccount);
  const credentials = { email: 'delegated@example.test', password: 'Delegated-camera-test-2026!' };
  const newUser = { ...credentials, name: 'Региональный пользователь', role: 'regional', stationIds: [alpha.id], cameraIds: [] };

  const createWithScope = (session, microphoneStationIds) => f.request('/api/users', { method: 'POST', session,
    body: { ...newUser, microphoneStationIds } });
  assert.equal((await createWithScope(director, [alpha.id])).status, 403);
  const outsideScope = await createWithScope(admin, [beta.id]);
  assert.equal(outsideScope.status, 400);
  assert.equal(outsideScope.body.code, 'INVALID_MICROPHONE_SCOPE');
  const created = await f.request('/api/users', { method: 'POST', session: director, body: newUser });
  assert.equal(created.status, 201);
  const delegatedId = created.body.user.id;
  const regional = await f.login(credentials);

  assert.equal((await f.patchUser(director, delegatedId, { microphoneStationIds: [alpha.id] })).status, 403);
  const granted = await f.patchUser(admin, delegatedId, { microphoneStationIds: [alpha.id] });
  assert.equal(granted.status, 200);
  assert.equal((await f.request(pdf(readyId), { session: regional })).status, 200);

  const cameras = async () => (await f.request('/api/cameras', { session: regional })).body.cameras.map(camera => camera.id);
  const cameraIds = await cameras();
  assert.ok(cameraIds.length);
  assert.equal((await f.patchUser(director, delegatedId, { name: 'Новое имя' })).status, 200);
  assert.equal((await f.request(pdf(readyId), { session: regional })).status, 200);
  assert.equal((await f.patchUser(admin, delegatedId, { microphoneStationIds: [] })).status, 200);
  assert.equal((await f.request(pdf(readyId), { session: regional, method: 'HEAD' })).status, 403);
  assert.deepEqual(await cameras(), cameraIds);

  assert.equal((await f.patchUser(admin, delegatedId, { microphoneStationIds: [alpha.id] })).status, 200);
  assert.equal((await f.patchUser(admin, director.user.id, { stationIds: [beta.id] })).status, 200);
  assert.equal((await f.request(pdf(readyId), { session: regional })).status, 403);
  assert.deepEqual(await cameras(), []);
});

test('unsafe catalog paths fail closed and changing a PDF to a symlink does not expose bytes', async t => {
  const f = await fixture(t);
  const admin = await f.login();
  assert.equal((await f.patchUser(admin, admin.user.id, { microphoneStationIds: [alpha.id] })).status, 200);
  assert.equal((await f.request(pdf(readyId), { session: admin })).status, 200);
  const outsidePath = join(f.dir, 'outside.pdf');
  const outsideBytes = Buffer.from('%PDF-1.7\nOUTSIDE-SENTINEL');
  await writeFile(outsidePath, outsideBytes);
  const [row] = shifts();
  for (const invalidPath of ['../outside.pdf', '..\\outside.pdf', outsidePath]) {
    await f.writeCatalog([{ ...row, pdf: invalidPath }]);
    for (const route of [list, pdf(readyId)]) {
      const denied = await f.request(route, { session: admin });
      assert.equal(denied.status, 503);
      assert.doesNotMatch(JSON.stringify(denied.body), /outside\.pdf|OUTSIDE-SENTINEL/);
    }
  }
  await f.writeCatalog([row]);
  const linkPath = join(f.microphoneDir, row.pdf);
  await rm(linkPath);
  try {
    await symlink(outsidePath, linkPath, 'file');
  } catch (error) {
    if (error.code !== 'EPERM' || process.platform !== 'win32') throw error;
    t.diagnostic('This Windows account cannot create file symlinks. Testing directory junction and unavailable-file handling.');
    const outsideDir = join(f.dir, 'outside-directory');
    await mkdir(outsideDir);
    await symlink(outsideDir, linkPath, 'junction');
  }
  const denied = await f.request(pdf(readyId), { session: admin });
  assert.equal(denied.status, 404);
  const result = await f.request(list, { session: admin });
  assert.equal(result.status, 200);
  assert.equal(result.body.shifts[0].status, 'missing');
  assert.equal(result.body.summary.ready, 0);
  assert.equal(result.body.summary.offerEpisodes, null);
});

test('server mode rejects a configured demo catalog', async t => {
  const f = await fixture(t, { serverMode: true });
  const admin = await f.login();
  assert.equal((await f.patchUser(admin, admin.user.id, { microphoneStationIds: [alpha.id] })).status, 200);
  assert.equal((await f.request(list, { session: admin })).status, 503);
  assert.equal((await f.request(pdf(readyId), { session: admin })).status, 503);
});

test('no configured catalog leaves status coverage and figures unknown', async t => {
  const f = await fixture(t, { withCatalog: false });
  const admin = await f.login();
  assert.equal((await f.patchUser(admin, admin.user.id, { microphoneStationIds: [alpha.id] })).status, 200);
  const result = await f.request(list, { session: admin });
  assert.equal(result.status, 200);
  assert.equal(result.body.configured, false);
  assert.deepEqual(result.body.shifts, []);
  assert.equal(result.body.summary.offerEpisodes, null);
  assert.equal(result.body.summary.sales, null);
  assert.equal((await f.request(pdf(readyId), { session: admin })).status, 404);
});
