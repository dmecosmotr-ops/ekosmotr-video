import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const MAX_LIVE_ROUTES = 150;

export class LiveError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const deny = () => { throw new LiveError(403, 'Нет доступа к этой видеосессии', 'LIVE_FORBIDDEN'); };
const bounded = (value, fallback, min, max) => Number.isFinite(value) && value >= min && value <= max ? value : fallback;
const STOP_REASONS = new Set(['stopped', 'startup_timeout', 'ticket_expired', 'duration_limit', 'access_revoked',
  'stalled', 'disconnected', 'bridge_error', 'bridge_closed', 'logout', 'server_closed']);

function liveRoute(input, cameraIds) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !cameraIds.has(input.cameraId)
    || typeof input.command !== 'string' || !isAbsolute(input.command) || !statSync(input.command).isFile()
    || typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || !statSync(input.cwd).isDirectory()
    || !Array.isArray(input.args) || input.args.length > 16
    || input.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\0\r\n]/.test(arg))) return null;
  return { cameraId: input.cameraId, command: input.command, args: input.args, cwd: input.cwd,
    maxDurationSeconds: bounded(input.maxDurationSeconds, 600, 1, 600),
    startupTimeoutMs: bounded(input.startupTimeoutMs, 110000, 50, 110000),
    stallTimeoutMs: bounded(input.stallTimeoutMs, 15000, 50, 15000) };
}

export function loadLiveConfiguration(file, cameraIds) {
  try {
    if (!file) return null;
    const info = statSync(file);
    if (!info.isFile() || info.size > 512 * 1024) return null;
    const input = JSON.parse(readFileSync(file, 'utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    if (!Object.hasOwn(input, 'cameras')) return info.size <= 16384 ? liveRoute(input, cameraIds) : null;
    return parseLiveRoutes(input, cameraIds);
  } catch { return null; }
}

export function parseLiveRoutes(input, cameraIds, { allowEmpty = false } = {}) {
  if (!Array.isArray(input?.cameras) || Object.keys(input).length !== 1 || input.cameras.length > MAX_LIVE_ROUTES
    || (!allowEmpty && !input.cameras.length)) return null;
  const routes = new Map();
  try {
    for (const entry of input.cameras) {
      const route = liveRoute(entry, cameraIds);
      if (!route || routes.has(route.cameraId)) return null;
      routes.set(route.cameraId, route);
    }
  } catch { return null; }
  return { cameras: [...routes.values()] };
}

const jsonError = (response, status, code, message) => {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.end(); return; }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: message, code }));
};

export function normalizeLiveMaxStreams(value = 1) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIVE_ROUTES)
    throw new Error(`Invalid PILOT_LIVE_MAX_STREAMS: expected an integer from 1 to ${MAX_LIVE_ROUTES}`);
  return value;
}

/** Bounded live subprocesses. Configuration is local-only; HTTP cannot choose commands or sources. */
export function createLiveManager({ configFile, cameraIds, onEvent = () => {}, ticketTtlMs = 20000,
  rightsIntervalMs = 1000, maxStreams = 1 } = {}) {
  maxStreams = normalizeLiveMaxStreams(maxStreams);
  const input = loadLiveConfiguration(configFile, new Set(cameraIds));
  let routes = new Map((input?.cameras ?? (input ? [input] : [])).map(route => [route.cameraId, route]));
  const sessions = new Map();
  let closed = false, closePromise = null;
  const notify = (action, item, reason) => { try { onEvent(action, item.ownerId, item.cameraId,
    action === 'stop' ? (STOP_REASONS.has(reason) ? reason : 'stopped') : undefined); } catch {} };
  const release = item => {
    for (const timer of item.timers) { clearTimeout(timer); clearInterval(timer); }
    item.timers.clear();
    if (sessions.get(item.id) === item) sessions.delete(item.id);
  };
  function stop(item, reason = 'stopped') {
    if (!item || item.state === 'stopping') return;
    item.state = 'stopping';
    for (const timer of item.timers) { clearTimeout(timer); clearInterval(timer); }
    item.timers.clear();
    if (item.response && !item.response.writableEnded && !item.response.destroyed) {
      if (reason === 'startup_timeout') jsonError(item.response, 504, 'LIVE_START_TIMEOUT', 'Камера не передала видео вовремя. Повторите подключение.');
      else if (!item.response.headersSent) jsonError(item.response, 502, 'LIVE_UNAVAILABLE', 'Не удалось получить видео камеры. Повторите подключение.');
      else item.response.end();
    }
    notify('stop', item, reason);
    if (!item.child || item.child.exitCode !== null) { release(item); return; }
    try { item.child.stdin.end('STOP\n'); } catch {}
    // The bridge owns descendant cleanup. Give it time to stop camera, FFmpeg and Java gracefully.
    const killer = setTimeout(() => {
      try { item.child.kill('SIGTERM'); } catch {}
    }, 5000);
    killer.unref(); item.timers.add(killer);
  }
  function own(cameraId, sessionId, ownerId, loginHash) {
    const item = sessions.get(sessionId);
    if (!item || item.cameraId !== cameraId
      || item.ownerId !== ownerId || item.loginHash !== loginHash) deny();
    return item;
  }
  const available = cameraId => !closed && routes.has(cameraId);
  const waitForBridge = item => !item?.child || item.child.exitCode !== null ? Promise.resolve() : new Promise(resolve => {
    const deadline = setTimeout(resolve, 6000);
    deadline.unref();
    item.child.once('close', () => { clearTimeout(deadline); resolve(); });
  });
  return {
    available,
    replaceRoutes(next, revoked) {
      routes = new Map(next.map(route => [route.cameraId, route]));
      for (const item of [...sessions.values()]) {
        const route = routes.get(item.cameraId);
        if (!route || revoked.has(item.cameraId)) stop(item, 'access_revoked');
        else if (item.state === 'ticket') item.config = route;
      }
    },
    create(cameraId, ownerId, loginHash) {
      const config = routes.get(cameraId);
      if (closed || !config) throw new LiveError(503, 'Онлайн этой камеры пока не подключён', 'LIVE_NOT_CONFIGURED');
      if ([...sessions.values()].some(item => item.cameraId === cameraId && item.loginHash === loginHash))
        throw new LiveError(409, 'Эта камера уже открыта в вашей сессии. Остановите её перед повторным подключением.', 'LIVE_DUPLICATE');
      if (sessions.size >= maxStreams)
        throw new LiveError(409, `Достигнут лимит одновременных просмотров (${maxStreams}). Остановите одну из камер и повторите подключение.`, 'LIVE_BUSY');
      const id = randomBytes(24).toString('base64url');
      const item = { id, cameraId, ownerId, loginHash, config, state: 'ticket', child: null,
        timers: new Set(), response: null, startedAt: Date.now(), lastByteAt: 0 };
      sessions.set(id, item);
      const ttl = setTimeout(() => stop(item, 'ticket_expired'), Math.min(20000, ticketTtlMs));
      ttl.unref(); item.timers.add(ttl); notify('start', item);
      return { sessionId: id, streamUrl: `/api/cameras/${encodeURIComponent(cameraId)}/live/${id}/stream`,
        stopUrl: `/api/cameras/${encodeURIComponent(cameraId)}/live/${id}`,
        expiresAt: new Date(item.startedAt + config.maxDurationSeconds * 1000).toISOString(),
        maxDurationSeconds: config.maxDurationSeconds };
    },
    stream(request, response, { cameraId, sessionId, ownerId, loginHash, isAuthorized }) {
      const item = own(cameraId, sessionId, ownerId, loginHash);
      const { config } = item;
      if (item.state !== 'ticket') throw new LiveError(409, 'Эта видеосессия уже открыта или завершена', 'LIVE_ALREADY_USED');
      if (!isAuthorized()) deny();
      for (const timer of item.timers) clearTimeout(timer);
      item.timers.clear(); item.state = 'streaming'; item.response = response;
      const setTimer = (callback, ms, interval = false) => {
        const timer = interval ? setInterval(callback, ms) : setTimeout(callback, ms);
        timer.unref(); item.timers.add(timer); return timer;
      };
      const startup = setTimer(() => stop(item, 'startup_timeout'), config.startupTimeoutMs);
      setTimer(() => stop(item, 'duration_limit'), Math.max(1,
        item.startedAt + config.maxDurationSeconds * 1000 - Date.now()));
      setTimer(() => {
        let authorized = false;
        try { authorized = isAuthorized(); } catch {}
        if (!authorized) stop(item, 'access_revoked');
        else if (item.lastByteAt && Date.now() - item.lastByteAt > config.stallTimeoutMs) stop(item, 'stalled');
      }, Math.min(2000, Math.max(50, rightsIntervalMs)), true);
      response.once('close', () => stop(item, 'disconnected'));
      try {
        const child = item.child = spawn(config.command, config.args, { cwd: config.cwd,
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        child.stdin.on('error', () => {});
        child.stdout.on('error', () => stop(item, 'bridge_error'));
        child.on('error', () => stop(item, 'bridge_error'));
        child.once('close', () => { stop(item, 'bridge_closed'); release(item); });
        child.stdout.on('data', chunk => {
          if (item.state !== 'streaming') return;
          item.lastByteAt = Date.now(); clearTimeout(startup);
          if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'video/mp4',
            'Cache-Control': 'no-store', 'Accept-Ranges': 'none', 'X-Accel-Buffering': 'no' });
          if (!response.write(chunk)) child.stdout.pause();
        });
        response.on('drain', () => { if (item.state === 'streaming') child.stdout.resume(); });
      } catch { stop(item, 'bridge_error'); }
    },
    stop(cameraId, sessionId, ownerId, loginHash) {
      const item = own(cameraId, sessionId, ownerId, loginHash), completion = waitForBridge(item);
      stop(item);
      return completion;
    },
    stopLogin(loginHash) {
      for (const item of [...sessions.values()]) if (item.loginHash === loginHash) stop(item, 'logout');
    },
    close() {
      if (closed) return closePromise;
      closed = true;
      const active = [...sessions.values()];
      closePromise = Promise.all(active.map(waitForBridge)).then(() => undefined);
      for (const item of active) stop(item, 'server_closed');
      return closePromise;
    },
  };
}

/** Close media before draining HTTP, then await subprocess cleanup before the entry point exits. */
export async function closePilotServer(app, server) {
  const liveClosed = app.close();
  const httpClosed = new Promise(resolve => server.close(resolve));
  const deadline = setTimeout(() => server.closeAllConnections(), 6000);
  deadline.unref();
  try { await Promise.all([liveClosed, httpClosed]); }
  finally { clearTimeout(deadline); }
}
