import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { hashPassword } from './security.mjs';
import { normalizeXiaomiSyncDir } from './inventory.mjs';
import { normalizeLiveMaxStreams } from './live.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validated = new WeakMap();
const localConfig = Object.freeze({ mode: 'local', secureCookies: false, demoLoginAvailable: true });
validated.set(localConfig, null);

// Bootstrap hashes stay outside the serializable configuration. Plaintext is
// read only from the mounted secret file and never retained by the application.
export function normalizeDeploymentConfig(value = localConfig) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid PILOT_DEPLOYMENT configuration');
  if (validated.has(value)) return value;
  if (value.mode === 'local') return localConfig;
  if (value.mode !== 'server') throw new Error('Invalid PILOT_DEPLOYMENT; use local or server');
  let origin;
  try { origin = new URL(value.publicOrigin); } catch { throw new Error('Invalid PILOT_PUBLIC_ORIGIN'); }
  if (origin.protocol !== 'https:' || origin.origin !== value.publicOrigin || origin.username || origin.password
    || origin.hostname.includes('*')) throw new Error('PILOT_PUBLIC_ORIGIN must be one exact HTTPS origin without path, query or credentials');
  const email = typeof value.adminEmail === 'string' ? value.adminEmail.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid PILOT_ADMIN_EMAIL');
  if (['admin@ekosmotr.local', 'director@ekosmotr.local', 'regional@ekosmotr.local'].includes(email))
    throw new Error('PILOT_ADMIN_EMAIL must not be a local demo account');
  if (typeof value.adminPasswordFile !== 'string' || !value.adminPasswordFile.trim())
    throw new Error('PILOT_ADMIN_PASSWORD_FILE is required');
  let password;
  try {
    const info = statSync(value.adminPasswordFile);
    if (!info.isFile() || info.size > 4096) throw new Error();
    password = readFileSync(value.adminPasswordFile, 'utf8').replace(/\r?\n$/, '');
  } catch { throw new Error('PILOT_ADMIN_PASSWORD_FILE must be a readable regular secret file'); }
  if (password.length < 16 || password.length > 200 || !password.trim() || /[\r\n\x00]/.test(password))
    throw new Error('PILOT_ADMIN_PASSWORD_FILE must contain one password of 16 to 200 characters');
  const { salt, hash } = hashPassword(password);
  const config = Object.freeze({ mode: 'server', publicOrigin: origin.origin, publicHost: origin.host,
    adminEmail: email, adminPasswordFile: value.adminPasswordFile,
    secureCookies: true, demoLoginAvailable: false });
  validated.set(config, Object.freeze({ email, salt, hash }));
  return config;
}

export function bootstrapAdminFor(config) {
  if (!validated.has(config)) throw new Error('Deployment configuration must be validated before opening the database');
  return validated.get(config);
}

export function loadConfig(env = process.env) {
  const mode = env.PILOT_DEPLOYMENT || 'local';
  const deploymentConfig = normalizeDeploymentConfig(mode === 'local' ? { mode } : {
    mode, publicOrigin: env.PILOT_PUBLIC_ORIGIN, adminEmail: env.PILOT_ADMIN_EMAIL,
    adminPasswordFile: env.PILOT_ADMIN_PASSWORD_FILE,
  });
  const portValue = String(env.PILOT_PORT || '3210');
  const port = Number(portValue);
  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PILOT_PORT');
  const host = env.PILOT_HOST || '127.0.0.1';
  if (typeof host !== 'string' || !(isIP(host) || host === 'localhost')) throw new Error('Invalid PILOT_HOST; use an IP address or localhost');
  if (mode === 'local' && !['127.0.0.1', '::1', 'localhost'].includes(host))
    throw new Error('PILOT_HOST must be loopback in local deployment');
  const liveLimit = env.PILOT_LIVE_MAX_STREAMS === undefined ? '1' : String(env.PILOT_LIVE_MAX_STREAMS);
  const liveMaxStreams = normalizeLiveMaxStreams(/^[1-9][0-9]{0,2}$/.test(liveLimit) ? Number(liveLimit) : NaN);
  return { host, port, deploymentConfig,
    liveMaxStreams,
    dbPath: env.PILOT_DB || resolve(appRoot, 'private/pilot.sqlite'),
    stationFile: env.PILOT_STATIONS || resolve(appRoot, 'data/stations.json'),
    mediaFile: env.PILOT_PROBE_MEDIA || undefined,
    inventoryFile: env.PILOT_CAMERA_INVENTORY || undefined,
    analysisConfigFile: env.PILOT_ANALYSIS_CONFIG || undefined,
    microphoneDir: env.PILOT_MICROPHONE_DIR || undefined,
    liveConfigFile: env.PILOT_LIVE_CONFIG || undefined,
    xiaomiSyncDir: normalizeXiaomiSyncDir(env.PILOT_XIAOMI_SYNC_DIR || undefined) };
}
