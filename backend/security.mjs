import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const SESSION_SECONDS = 8 * 60 * 60;
export const randomToken = () => randomBytes(32).toString('base64url');
export const tokenHash = value => createHash('sha256').update(value).digest('hex');
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
export function equalTokens(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function verifyPassword(password, salt, hash) {
  if (typeof password !== 'string' || password.length > 200) return false;
  return equalTokens(hashPassword(password, salt).hash, hash);
}
export function cookieToken(request) {
  const value = String(request.headers.cookie || '').split(';').find(v => v.trim().startsWith('pilot_session='));
  return value ? value.trim().slice('pilot_session='.length) : null;
}
export function sessionCookie(token, expired = false, secure = false) {
  return `pilot_session=${expired ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expired ? 0 : SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}
const loopbackHost = host => /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host);
const loopbackAddress = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
export function validOrigin(request, deploymentConfig = { mode: 'local' }) {
  const host = String(request.headers.host || '');
  if (deploymentConfig.mode === 'server') {
    // A container health probe may use its own loopback address, but this narrow
    // exception never trusts forwarded headers or applies to any other method.
    if (request.method === 'GET' && String(request.url || '').split('?')[0] === '/api/health'
      && loopbackHost(host) && loopbackAddress(request.socket?.remoteAddress) && request.headers.origin === undefined) return true;
    return host === deploymentConfig.publicHost
      && (request.headers.origin === undefined || request.headers.origin === deploymentConfig.publicOrigin);
  }
  if (!loopbackHost(host)) return false;
  if (!request.headers.origin) return true;
  try { return new URL(request.headers.origin).origin === `http://${host}`; }
  catch { return false; }
}
