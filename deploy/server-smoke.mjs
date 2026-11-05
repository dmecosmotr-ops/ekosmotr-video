import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

const origin = process.env.PILOT_PUBLIC_ORIGIN;
const email = process.env.PILOT_ADMIN_EMAIL;
const password = readFileSync(process.env.PILOT_ADMIN_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '');
const host = new URL(origin).host;
const base = `http://127.0.0.1:${process.env.PILOT_PORT || 3210}`;
const request = async (path, { body, cookie, csrf, requestOrigin = origin } = {}) => {
  const headers = { Host: host };
  if (requestOrigin !== null) headers.Origin = requestOrigin;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  // Node fetch replaces a supplied Host with the loopback URL host. Use the
  // HTTP client to reproduce the Host preserved by the real reverse proxy.
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method: payload ? 'POST' : 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const response = { status: res.statusCode, headers: new Headers() };
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) response.headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          resolve({ response, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('SMOKE_REQUEST_TIMEOUT')));
    req.on('error', reject);
    req.end(payload);
  });
};
const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(5000) });
assert.equal(health.status, 200);
assert.equal((await health.json()).ok, true);
const anonymous = await request('/api/session');
assert.equal(anonymous.response.status, 200);
assert.equal(anonymous.body.demoLoginAvailable, false);
assert.equal(anonymous.body.user, null);
assert.equal((await request('/api/cameras')).response.status, 401);
assert.equal((await request('/api/login', { body: { email, password }, requestOrigin: 'https://other.example.invalid' })).response.status, 403);
assert.equal((await request('/api/login', { body: { email: 'admin@ekosmotr.local', password: 'Pilot-Admin-2026!' } })).response.status, 401);
const login = await request('/api/login', { body: { email, password } });
assert.equal(login.response.status, 200);
assert.equal(login.body.user.role, 'admin');
assert.equal(login.body.user.email, email);
assert.equal(login.body.demoLoginAvailable, false);
const setCookie = login.response.headers.get('set-cookie');
assert.match(setCookie, /; Secure(?:;|$)/i);
assert.match(setCookie, /; HttpOnly(?:;|$)/i);
const cookie = setCookie.split(';')[0];
const cameras = await request('/api/cameras', { cookie });
assert.equal(cameras.response.status, 200);
assert.ok(cameras.body.cameras.every(camera => !camera.liveAvailable && !camera.archiveAvailable));
assert.equal((await request('/api/logout', { body: {}, cookie })).response.status, 403);
assert.equal((await request('/api/logout', { body: {}, cookie, csrf: login.body.csrfToken })).response.status, 200);
assert.equal((await request('/api/cameras', { cookie })).response.status, 401);
console.log('PASS: health, server auth, Secure cookie, Origin, CSRF, live/archive off');
