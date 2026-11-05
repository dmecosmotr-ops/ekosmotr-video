import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createApp } from '../backend/app.mjs';

const publicOrigin = 'https://cameras.example.test';
const owner = { email: 'owner@example.test', password: 'Synthetic-only-admin-password-2026!' };

async function files(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'camera-deployment-'));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    assert.match(path.basename(dir), /^camera-deployment-/);
    await rm(dir, { recursive: true, force: true });
  });
  const stationFile = path.join(dir, 'stations.json');
  const adminPasswordFile = path.join(dir, 'admin-password');
  await writeFile(stationFile, JSON.stringify([{ id: 'one', region: 'Test', city: 'Test', address: 'Test', manager: 'Test' }]));
  await writeFile(adminPasswordFile, owner.password + '\n');
  return { dir, cleanups, dbPath: path.join(dir, 'pilot.sqlite'), stationFile, adminPasswordFile,
    deploymentConfig: { mode: 'server', publicOrigin, adminEmail: owner.email, adminPasswordFile } };
}

async function fixture(t, options) {
  const f = options || await files(t);
  const app = createApp(f);
  const server = createServer(app);
  f.cleanups.push(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await app.close();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  async function request(route, { method = 'GET', body, headers = {}, cookie, csrf } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const requestHeaders = { Host: 'cameras.example.test', ...headers };
    if (payload) { requestHeaders['Content-Type'] = 'application/json'; requestHeaders['Content-Length'] = Buffer.byteLength(payload); }
    if (cookie) requestHeaders.Cookie = cookie;
    if (csrf) requestHeaders['X-CSRF-Token'] = csrf;
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: route, method, headers: requestHeaders }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text,
            body: text && res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text,
            cookie: res.headers['set-cookie']?.[0]?.split(';')[0] });
        });
      });
      req.on('error', reject); req.end(payload);
    });
  }
  return { ...f, request, port };
}

test('server bootstrap creates only the configured administrator and never returns its password', async t => {
  const f = await fixture(t);
  const anonymous = await f.request('/api/session');
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.body.demoLoginAvailable, false);
  const login = await f.request('/api/login', { method: 'POST', headers: { Origin: publicOrigin }, body: owner });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'admin');
  assert.equal(login.body.user.email, owner.email);
  assert.equal(login.body.demoLoginAvailable, false);
  assert.doesNotMatch(login.body.user.id, /^seed-/);
  assert.ok(login.headers['set-cookie'][0].includes('; Secure'));
  const users = await f.request('/api/users', { cookie: login.cookie });
  assert.equal(users.body.users.length, 1);
  assert.equal(users.body.users[0].email, owner.email);
  const audit = await f.request('/api/audit', { cookie: login.cookie });
  assert.equal((anonymous.text + login.text + users.text + audit.text).includes(owner.password), false);
  const logout = await f.request('/api/logout', { method: 'POST', cookie: login.cookie, csrf: login.body.csrfToken });
  assert.equal(logout.status, 200);
  assert.ok(logout.headers['set-cookie'][0].includes('; Secure'));
  assert.equal((await f.request('/api/users', { cookie: login.cookie })).status, 401);
});

test('local createApp default retains demo accounts, nonsecure local cookies and demo login availability', async t => {
  const filesOnly = await files(t);
  const f = await fixture(t, { ...filesOnly, deploymentConfig: undefined });
  const headers = { Host: `127.0.0.1:${f.port}` };
  assert.equal((await f.request('/api/session', { headers })).body.demoLoginAvailable, true);
  const login = await f.request('/api/login', { method: 'POST', headers,
    body: { email: 'admin@ekosmotr.local', password: 'Pilot-Admin-2026!' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.demoLoginAvailable, true);
  assert.doesNotMatch(login.headers['set-cookie'][0], /; Secure/);
});

test('server rejects incorrect Host or Origin on login, session and static requests despite forwarded headers', async t => {
  const f = await fixture(t);
  for (const headers of [
    { Host: 'attacker.example.test' },
    { Host: `127.0.0.1:${f.port}`, 'X-Forwarded-Host': 'cameras.example.test', 'X-Forwarded-Proto': 'https' },
    { Origin: 'https://attacker.example.test' },
    { Origin: `${publicOrigin}/unexpected` },
    { Origin: '' },
    { Origin: 'null' },
  ]) {
    assert.equal((await f.request('/api/session', { headers })).status, 403, JSON.stringify(headers));
    assert.equal((await f.request('/api/login', { method: 'POST', body: owner, headers })).status, 403);
    assert.equal((await f.request('/', { headers })).status, 403);
  }
  assert.equal((await f.request('/api/session', { headers: { Origin: publicOrigin } })).status, 200);
});

test('only GET health permits the container loopback host without public origin or authentication', async t => {
  const f = await fixture(t);
  const localHeaders = { Host: `127.0.0.1:${f.port}` };
  assert.equal((await f.request('/api/health', { headers: localHeaders })).status, 200);
  assert.equal((await f.request('/api/health', { method: 'HEAD', headers: localHeaders })).status, 403);
  assert.equal((await f.request('/api/health', { method: 'POST', headers: localHeaders })).status, 403);
  assert.equal((await f.request('/api/session', { headers: localHeaders })).status, 403);
  assert.equal((await f.request('/api/health', { headers: { ...localHeaders, Origin: 'https://attacker.example.test' } })).status, 403);
  assert.equal((await f.request('/api/health', { headers: { ...localHeaders, Origin: '' } })).status, 403);
  assert.equal((await f.request('/api/health', { headers: { Host: 'attacker.example.test' } })).status, 403);
  assert.equal((await f.request('/api/health')).status, 200);
});

test('server preserves an existing administrator and changed bootstrap secret does not reset credentials', async t => {
  const f = await files(t);
  const initial = createApp(f);
  await initial.close();
  await writeFile(f.adminPasswordFile, 'A-different-synthetic-password-2026!\n');
  const server = await fixture(t, f);
  assert.equal((await server.request('/api/login', { method: 'POST', body: owner })).status, 200);
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE id LIKE 'seed-%'").get().n, 0);
  } finally { db.close(); }
  assert.equal((await readFile(f.dbPath)).includes(Buffer.from(owner.password)), false);
});

test('server rejects an existing local seed database without modifying its accounts', async t => {
  const f = await files(t);
  const local = createApp({ ...f, deploymentConfig: undefined });
  await local.close();
  assert.throws(() => createApp(f), /seed|local|demo/i);
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 3); }
  finally { db.close(); }
});

test('direct server createApp rejects incomplete or unsafe deployment configuration before creating a database', async t => {
  const f = await files(t);
  for (const deploymentConfig of [
    { mode: 'unknown' },
    { mode: 'server' },
    { ...f.deploymentConfig, publicOrigin: 'http://cameras.example.test' },
    { ...f.deploymentConfig, adminEmail: 'invalid' },
    { ...f.deploymentConfig, adminPasswordFile: undefined, adminPassword: owner.password },
  ]) assert.throws(() => createApp({ ...f, deploymentConfig }));
  await assert.rejects(readFile(f.dbPath), { code: 'ENOENT' });
});

test('startup config validates HTTPS origin, secret files and host binding and never serializes the secret', async t => {
  const f = await files(t);
  const { loadConfig } = await import('../backend/config.mjs');
  const base = { PILOT_DEPLOYMENT: 'server', PILOT_PUBLIC_ORIGIN: publicOrigin,
    PILOT_ADMIN_EMAIL: owner.email, PILOT_ADMIN_PASSWORD_FILE: f.adminPasswordFile,
    PILOT_DB: f.dbPath, PILOT_STATIONS: f.stationFile };
  const config = loadConfig({ ...base, PILOT_HOST: '0.0.0.0', PILOT_PORT: '3211' });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 3211);
  assert.equal(config.dbPath, f.dbPath);
  assert.equal(config.deploymentConfig.mode, 'server');
  assert.equal(JSON.stringify(config).includes(owner.password), false);
  assert.equal(loadConfig({}).host, '127.0.0.1');
  assert.throws(() => loadConfig({ PILOT_HOST: '0.0.0.0' }), /HOST|loopback|local/i);
  for (const origin of ['http://cameras.example.test', 'https://user:pass@cameras.example.test',
    'https://cameras.example.test/path', 'https://cameras.example.test?x=1',
    'https://cameras.example.test#fragment', 'https://cameras.example.test,https://evil.test', 'null']) {
    assert.throws(() => loadConfig({ ...base, PILOT_PUBLIC_ORIGIN: origin }), /ORIGIN/);
  }
  for (const patch of [{ PILOT_PUBLIC_ORIGIN: '' }, { PILOT_ADMIN_EMAIL: '' },
    { PILOT_ADMIN_PASSWORD_FILE: '' }, { PILOT_ADMIN_PASSWORD_FILE: path.join(f.dir, 'missing') },
    { PILOT_PORT: '0' }, { PILOT_PORT: 'NaN' }, { PILOT_DEPLOYMENT: 'production' }]) {
    assert.throws(() => loadConfig({ ...base, ...patch }));
  }
  await writeFile(f.adminPasswordFile, 'too-short\n');
  assert.throws(() => loadConfig(base), /PASSWORD/);
  await writeFile(f.adminPasswordFile, 'strong-but-multiline\npassword');
  assert.throws(() => loadConfig(base), /PASSWORD/);
});

function startProcess(f, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PILOT_')));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../backend/server.mjs', import.meta.url))], {
    cwd: f.dir, windowsHide: true, env: { ...env, PILOT_DEPLOYMENT: 'server',
      PILOT_PUBLIC_ORIGIN: publicOrigin, PILOT_ADMIN_EMAIL: owner.email,
      PILOT_ADMIN_PASSWORD_FILE: f.adminPasswordFile, PILOT_DB: f.dbPath,
      PILOT_STATIONS: f.stationFile, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  f.cleanups.push(async () => { if (child.exitCode === null) child.kill(); await exited; });
  return { child, exited, output: () => output };
}

test('server entry point refuses invalid configuration before listening or creating its database without leaking supplied values', async t => {
  const f = await files(t);
  const proc = startProcess(f, { PILOT_PUBLIC_ORIGIN: `http://user:${owner.password}@cameras.example.test` });
  assert.notEqual(await proc.exited, 0);
  assert.doesNotMatch(proc.output(), /Camera pilot:/);
  assert.equal(proc.output().includes(owner.password), false);
  await assert.rejects(readFile(f.dbPath), { code: 'ENOENT' });
});

test('server entry point supports container bind configuration and the internal health probe with a configured public origin', async t => {
  const f = await files(t);
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const proc = startProcess(f, { PILOT_HOST: '0.0.0.0', PILOT_PORT: String(port) });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
    const done = () => { if (proc.output().includes('Camera pilot:')) { clearTimeout(timer); resolve(); } };
    proc.child.stdout.on('data', done);
    proc.exited.then(() => { clearTimeout(timer); reject(new Error('Server exited before startup')); }, reject);
    done();
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/session`)).status, 403);
  assert.equal(proc.output().includes(owner.password), false);
});

// Exercise the HTTP handler directly for synthetic peer addresses. This avoids
// opening a thousand sockets or pretending X-Forwarded-For is a trusted peer IP.
function directLogin(app, ip, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  const request = Object.assign(Readable.from([Buffer.from(payload)]), { method: 'POST', url: '/api/login',
    headers: { host: 'cameras.example.test', origin: publicOrigin, 'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)), ...extraHeaders }, socket: { remoteAddress: ip } });
  return new Promise((resolve, reject) => {
    const response = { writableEnded: false, headersSent: false, headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers) { this.status = status; this.headersSent = true; Object.assign(this.headers, headers); },
      end(data) { this.writableEnded = true; resolve({ status: this.status, body: JSON.parse(data.toString()) }); },
      destroy() { reject(new Error('Unexpected response destruction')); } };
    app(request, response);
  });
}

test('a changing login email or forwarded IP cannot bypass the total socket-IP attempt limit', async t => {
  const f = await files(t);
  const app = createApp(f);
  f.cleanups.push(() => app.close());
  // Malformed and well-formed attempts share the same budget. The final twenty
  // attempts exercise actual password checking with twenty distinct emails.
  for (let i = 0; i < 120; i++) {
    assert.equal((await directLogin(app, '192.0.2.10', { email: `different-${i}@example.test`,
      password: i < 100 ? null : 'wrong-synthetic-password' },
    { 'x-forwarded-for': `198.51.100.${i}` })).status, i < 100 ? 400 : 401);
  }
  const limited = await directLogin(app, '192.0.2.10', owner, { 'x-forwarded-for': '203.0.113.50' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'LOGIN_RATE_LIMIT');
  assert.equal((await directLogin(app, '192.0.2.11', owner)).status, 200);
});

test('login limiter fails closed at its bounded capacity and reclaims expired entries', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T00:00:00Z') });
  const f = await files(t);
  const app = createApp(f);
  f.cleanups.push(() => app.close());
  for (let i = 0; i < 1000; i++) {
    const ip = `192.0.${Math.floor(i / 250)}.${i % 250 + 1}`;
    assert.equal((await directLogin(app, ip, { email: null, password: null })).status, 400);
  }
  assert.equal((await directLogin(app, '203.0.113.1', owner)).status, 429);
  // Existing buckets remain bounded; a new pair bucket is also denied when full.
  assert.equal((await directLogin(app, '192.0.0.1', owner)).status, 429);
  t.mock.timers.tick(60001);
  assert.equal((await directLogin(app, '203.0.113.1', owner)).status, 200);
});

test('a failed email pair keeps its ten-attempt budget while another email remains independently usable', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T00:00:00Z') });
  const f = await files(t);
  const app = createApp(f);
  f.cleanups.push(() => app.close());
  for (let i = 0; i < 10; i++) {
    assert.equal((await directLogin(app, '192.0.2.20', { ...owner, password: 'wrong-synthetic-password' })).status, 401);
  }
  assert.equal((await directLogin(app, '192.0.2.20', owner)).status, 429);
  assert.equal((await directLogin(app, '192.0.2.20', { email: 'different@example.test', password: 'wrong-synthetic-password' })).status, 401);
  t.mock.timers.tick(60001);
  assert.equal((await directLogin(app, '192.0.2.20', owner)).status, 200);
});
