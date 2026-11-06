import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openStore, publicUser } from './store.mjs';
import { normalizeDeploymentConfig } from './config.mjs';
import { makeDemo, DEMO_DATE, aggregateMetrics, noneMetrics, buildVisits } from './demo.mjs';
import { hasProbeMedia, validDate, timeSeconds, playbackState, archiveSearch } from './playback.mjs';
import { importInventory, normalizeXiaomiSyncDir, startXiaomiRefresh } from './inventory.mjs';
import { createLiveManager, LiveError } from './live.mjs';
import { loadAnalysisConfig, confirmedCameras, readAnalysis, analysisEvents, analysisMetrics } from './analysis.mjs';
import { analysisPlayback, searchAnalysisArchive, exactAnalysisRecording, openAnalysisMedia, mediaRange } from './analysisArchive.mjs';
import { microphoneSummary, openMicrophoneReport, readMicrophoneCatalog, validateMicrophoneDirectory } from './microphones.mjs';
import { randomToken, tokenHash, hashPassword, verifyPassword, equalTokens,
  SESSION_SECONDS, cookieToken, sessionCookie, validOrigin } from './security.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
class HTTPError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new HTTPError(status, message, code); };
const requireCondition = (value, status, message, code) => { if (!value) fail(status, message, code); };
const modes = { demoDate: DEMO_DATE, mode: 'pilot' };
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8' };

function respond(response, status, body, headers = {}) {
  if (response.writableEnded) return;
  const buffer = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buffer.length, 'Cache-Control': 'no-store', ...headers });
  response.end(buffer);
}

async function bodyJSON(request) {
  requireCondition(String(request.headers['content-type'] || '').split(';')[0] === 'application/json',
    415, 'Отправьте данные в формате JSON', 'JSON_REQUIRED');
  requireCondition(Number(request.headers['content-length'] || 0) <= 65536,
    413, 'Слишком большой запрос', 'BODY_TOO_LARGE');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) fail(413, 'Слишком большой запрос', 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { fail(400, 'Не удалось прочитать данные запроса', 'INVALID_JSON'); }
}

export function createApp({ dbPath = resolve(appRoot, 'private/pilot.sqlite'),
  stationFile = resolve(appRoot, 'data/stations.json'), mediaFile, inventoryFile, liveConfigFile, analysisConfigFile,
  microphoneDir, xiaomiSyncDir, staticDir = resolve(appRoot, 'frontend/dist'), deploymentConfig } = {}) {
  deploymentConfig = normalizeDeploymentConfig(deploymentConfig);
  microphoneDir = validateMicrophoneDirectory(microphoneDir, staticDir);
  xiaomiSyncDir = normalizeXiaomiSyncDir(xiaomiSyncDir);
  const source = JSON.parse(readFileSync(stationFile, 'utf8'));
  const stations = Array.isArray(source) ? source : source.stations;
  if (!Array.isArray(stations) || !stations.length || new Set(stations.map(s => s.id)).size !== stations.length)
    throw new Error('Station source is missing or invalid');
  const stationMap = new Map(stations.map(s => [s.id, s]));
  const { cameras: builtInCameras, events } = makeDemo(stations);
  const reservedIds = builtInCameras.map(camera => camera.id);
  const previousInventory = importInventory(inventoryFile, stations, reservedIds);
  const analysisConfig = loadAnalysisConfig(analysisConfigFile, stations, [...builtInCameras, ...previousInventory]);
  const analysisCameras = confirmedCameras(analysisConfig);
  const catalogMap = inventory => new Map([...builtInCameras, ...inventory, ...analysisCameras].map(camera => [camera.id, camera]));
  let cameraMap = catalogMap(previousInventory);
  let cameras = [...cameraMap.values()];
  const { db, audit, insert } = openStore(dbPath, stations, cameras.filter(c => c.status === 'demo').map(c => c.stationId), deploymentConfig);
  const getUserRow = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const dummyPassword = hashPassword(randomToken());
  const loginAttempts = new Map();
  // One bounded in-memory budget for peer IPs and failed IP/email pairs.
  // A reverse proxy's users share its 120/min peer-IP budget; XFF is untrusted.
  function loginBucket(key, limit, now) {
    for (const [storedKey, value] of loginAttempts) {
      if (value.until <= now) loginAttempts.delete(storedKey);
    }
    let bucket = loginAttempts.get(key);
    requireCondition(!bucket || bucket.count < limit,
      429, 'Слишком много попыток. Повторите вход через минуту', 'LOGIN_RATE_LIMIT');
    if (!bucket) {
      requireCondition(loginAttempts.size < 1000,
        429, 'Слишком много попыток. Повторите вход через минуту', 'LOGIN_RATE_LIMIT');
      bucket = { count: 0, until: now + 60000 };
      loginAttempts.set(key, bucket);
    }
    return bucket;
  }
  let closed = false, closePromise = null;
  const archiveStreams = new Set();
  const live = createLiveManager({ configFile: liveConfigFile, cameraIds: cameraMap.keys(),
    onEvent: (action, ownerId, cameraId, reason) => {
      const row = getUserRow(ownerId);
      audit(row && publicUser(row), action === 'start' ? 'Запрошен онлайн-просмотр' : 'Остановлен онлайн-просмотр',
        cameraMap.get(cameraId)?.name || 'Камера', action === 'stop' ? JSON.stringify({ reason }) : '');
    } });
  const xiaomiRefresh = startXiaomiRefresh({ root: xiaomiSyncDir, db, stations, reservedIds, previousInventory, analysisCameras,
    replace(inventory, routes, revoked) {
      cameraMap = catalogMap(inventory);
      cameras = [...cameraMap.values()];
      live.replaceRoutes(routes, revoked);
    } });

  const canCamera = (user, camera) => Boolean(camera && (user.role === 'admin'
    || (camera.stationId !== null && (user.stationIds.includes(camera.stationId) || user.cameraIds.includes(camera.id)))));
  const visibleCameras = user => cameras.filter(c => canCamera(user, c));
  const visibleStations = user => user.role === 'admin' ? stations : stations.filter(s =>
    user.stationIds.includes(s.id) || visibleCameras(user).some(c => c.stationId === s.id));
  const grantWithin = (actor, target) => target.stationIds.every(id => actor.stationIds.includes(id))
    && target.cameraIds.every(id => canCamera(actor, cameraMap.get(id)));
  const canManage = (actor, row) => actor.role === 'admin' || (actor.role === 'director'
    && row.role === 'regional' && row.created_by === actor.id && row.delegated_by === actor.id);
  const state = session => ({ user: session?.user || null, csrfToken: session?.csrf || null, ...modes,
    demoLoginAvailable: deploymentConfig.demoLoginAvailable, ...(xiaomiRefresh && { xiaomiSyncEnabled: true }) });

  function effectiveUser(row) {
    const user = publicUser(row);
    if (!user) return null;
    let { stationIds, cameraIds } = user;
    if (user.role === 'regional' && row.delegated_by) {
      const parentRow = getUserRow(row.delegated_by);
      if (!parentRow?.active || parentRow.role !== 'director') {
        stationIds = [];
        cameraIds = [];
      } else {
        const parent = publicUser(parentRow);
        stationIds = stationIds.filter(id => parent.stationIds.includes(id));
        cameraIds = cameras.filter(camera => canCamera(user, camera) && canCamera(parent, camera)
          && !stationIds.includes(camera.stationId)).map(camera => camera.id);
      }
    }
    const microphoneStationIds = user.microphoneStationIds.filter(id => stationMap.has(id)
      && (user.role === 'admin' || stationIds.includes(id)));
    return { ...user, stationIds, cameraIds, microphoneStationIds };
  }

  const managedUser = (actor, row) => ({ ...effectiveUser(row), ...(actor.role === 'admin' && {
    assignedMicrophoneStationIds: publicUser(row).microphoneStationIds,
  }) });

  function currentSession(request) {
    const token = cookieToken(request);
    if (!token || !/^[A-Za-z0-9_-]{30,100}$/.test(token)) return null;
    const hash = tokenHash(token);
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hash);
    if (!row) return null;
    const userRow = getUserRow(row.user_id);
    if (row.expires <= Date.now() || !userRow?.active) {
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
      return null;
    }
    return { user: effectiveUser(userRow), csrf: row.csrf, hash };
  }

  function currentManager(request, session) {
    // A request body may still be arriving when synchronization revokes a grant.
    xiaomiRefresh?.refresh();
    const current = currentSession(request);
    requireCondition(current?.hash === session.hash, 401, 'Войдите в сервис', 'AUTH_REQUIRED');
    requireCondition(current.user.role !== 'regional', 403, 'Нет прав управления пользователями', 'USERS_FORBIDDEN');
    return current.user;
  }

  function checkDate(url) {
    const date = url.searchParams.get('date') || DEMO_DATE;
    requireCondition(validDate(date), 400, 'Укажите корректную дату', 'INVALID_DATE');
    return date;
  }

  function validateUserInput(body, actor, existing) {
    const base = existing ? effectiveUser(existing) : {};
    const name = body.name ?? base.name;
    const emailValue = body.email ?? base.email;
    const email = typeof emailValue === 'string' ? emailValue.trim().toLowerCase() : emailValue;
    const role = body.role ?? base.role;
    const active = body.active ?? base.active ?? true;
    const stationIds = body.stationIds ?? base.stationIds ?? [];
    const cameraIds = body.cameraIds ?? base.cameraIds ?? [];
    const storedMicrophoneIds = publicUser(existing)?.microphoneStationIds ?? [];
    const setsMicrophoneIds = Object.hasOwn(body, 'microphoneStationIds');
    const microphoneStationIds = setsMicrophoneIds ? body.microphoneStationIds : storedMicrophoneIds;
    requireCondition(!setsMicrophoneIds || actor.role === 'admin', 403,
      'Доступ к микрофонам назначает администратор', 'MICROPHONES_GRANT_FORBIDDEN');
    requireCondition(typeof name === 'string' && name.trim().length >= 2 && name.length <= 120
      && !/[\x00-\x1f]/.test(name), 400, 'Укажите имя от 2 до 120 символов', 'INVALID_NAME');
    requireCondition(typeof email === 'string' && email.length <= 254
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 400, 'Укажите корректный email', 'INVALID_EMAIL');
    requireCondition(['admin', 'director', 'regional'].includes(role), 400, 'Выберите роль пользователя', 'INVALID_ROLE');
    requireCondition(typeof active === 'boolean', 400, 'Некорректное состояние пользователя', 'INVALID_ACTIVE');
    requireCondition(Array.isArray(stationIds) && stationIds.length <= 1000
      && stationIds.every(id => typeof id === 'string' && stationMap.has(id)),
      400, 'В доступах указана неизвестная станция', 'INVALID_STATIONS');
    requireCondition(Array.isArray(cameraIds) && cameraIds.length <= 1000
      && cameraIds.every(id => typeof id === 'string' && cameraMap.has(id)),
      400, 'В доступах указана неизвестная камера', 'INVALID_CAMERAS');
    requireCondition(role === 'admin' || cameraIds.every(id => cameraMap.get(id).stationId !== null),
      403, 'Непривязанные камеры доступны только администратору', 'UNMAPPED_ADMIN_ONLY');
    if (setsMicrophoneIds) {
      requireCondition(Array.isArray(microphoneStationIds) && microphoneStationIds.length <= 1000
        && microphoneStationIds.every(id => typeof id === 'string' && (stationMap.has(id) || storedMicrophoneIds.includes(id))),
      400, 'В доступах к микрофонам указана неизвестная станция', 'INVALID_MICROPHONE_STATIONS');
      requireCondition(role === 'admin' || microphoneStationIds.every(id => stationIds.includes(id) || storedMicrophoneIds.includes(id)),
        400, 'Доступ к микрофонам назначается только для доступных ПТО', 'INVALID_MICROPHONE_SCOPE');
    }
    if (actor.role === 'director') {
      requireCondition(role === 'regional', 403, 'Директор может создавать только региональные доступы', 'ROLE_ESCALATION');
      requireCondition(grantWithin(actor, { stationIds, cameraIds }),
        403, 'Нельзя выдать доступ за пределами ваших станций и камер', 'SCOPE_ESCALATION');
    }
    if (body.password !== undefined || !existing) {
      requireCondition(typeof body.password === 'string' && body.password.length >= 10 && body.password.length <= 200,
        400, 'Пароль должен содержать от 10 до 200 символов', 'INVALID_PASSWORD');
    }
    return { name: name.trim(), email, role, active,
      stationIds: [...new Set(stationIds)], cameraIds: [...new Set(cameraIds)],
      microphoneStationIds: [...new Set(microphoneStationIds)] };
  }

  function serveMedia(request, response, user, id) {
    const camera = cameraMap.get(id);
    requireCondition(canCamera(user, camera), 403, 'Нет доступа к этой камере', 'CAMERA_FORBIDDEN');
    requireCondition(id === 'probe-c300' && hasProbeMedia(mediaFile),
      404, 'Запись проверки не подключена', 'MEDIA_UNAVAILABLE');
    const info = statSync(mediaFile);
    requireCondition(info.isFile(), 404, 'Запись недоступна', 'MEDIA_UNAVAILABLE');
    let start = 0, end = info.size - 1, code = 200;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return;
      }
      if (!match[1]) { start = Math.max(0, info.size - Number(match[2])); }
      else { start = Number(match[1]); if (match[2]) end = Number(match[2]); }
      end = Math.min(end, info.size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return;
      }
      code = 206;
    }
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1, 'Cache-Control': 'no-store' };
    if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    response.writeHead(code, headers);
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(mediaFile, { start, end });
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }

  function serveRecording(request, response, session, cameraId, recordingId) {
    const camera = cameraMap.get(cameraId);
    requireCondition(canCamera(session.user, camera), 403, 'Нет доступа к этой камере', 'CAMERA_FORBIDDEN');
    const runs = readAnalysis(analysisConfig).filter(run => run.cameraId === cameraId);
    const opened = openAnalysisMedia(runs, cameraId, recordingId);
    requireCondition(opened, 404, 'Запись недоступна', 'MEDIA_UNAVAILABLE');
    return streamProtectedFile(request, response, session, opened, { 'Content-Type': 'video/mp4' },
      current => canCamera(current, cameraMap.get(cameraId)));
  }

  function microphoneCatalogFor(user) {
    requireCondition(user.microphoneStationIds.length, 403, 'Нет доступа к разделу «Микрофоны»', 'MICROPHONES_FORBIDDEN');
    const catalog = readMicrophoneCatalog(microphoneDir, stationMap, deploymentConfig.mode === 'local');
    requireCondition(catalog, 503, 'Каталог отчётов по микрофонам недоступен', 'MICROPHONES_CATALOG_UNAVAILABLE');
    return catalog;
  }

  function serveMicrophonePdf(request, response, session, reportId) {
    const catalog = microphoneCatalogFor(session.user);
    const shift = catalog.shifts.find(row => row.id === reportId && session.user.microphoneStationIds.includes(row.stationId));
    const opened = openMicrophoneReport(microphoneDir, shift);
    requireCondition(opened, 404, 'Отчёт недоступен', 'MICROPHONE_REPORT_UNAVAILABLE');
    return streamProtectedFile(request, response, session, opened, {
      'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="shift-report.pdf"',
      'Cross-Origin-Resource-Policy': 'same-origin',
    }, current => current.microphoneStationIds.includes(shift.stationId));
  }

  function streamProtectedFile(request, response, session, opened, fileHeaders, stillAllowed) {
    const range = mediaRange(request.headers.range, opened.size);
    if (!range) { opened.close(); response.writeHead(416, { 'Content-Range': `bytes */${opened.size}`, 'Cache-Control': 'no-store' }); response.end(); return; }
    const headers = { ...fileHeaders, 'Accept-Ranges': 'bytes',
      'Content-Length': range.end - range.start + 1, 'Cache-Control': 'no-store' };
    if (range.status === 206) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${opened.size}`;
    response.writeHead(range.status, headers);
    if (request.method === 'HEAD') { opened.close(); response.end(); return; }
    // Ownership transfers to the stream, which closes only after pending I/O has
    // finished. Never close an fd synchronously while a cancelled read is pending.
    const stream = createReadStream('', { fd: opened.fd, autoClose: true, start: range.start, end: range.end });
    let timer;
    const cleanup = () => { clearInterval(timer); stream.destroy(); };
    const active = { stop() { cleanup(); response.destroy(); } };
    active.done = new Promise(resolve => stream.once('close', () => {
      clearInterval(timer); archiveStreams.delete(active); resolve();
    }));
    archiveStreams.add(active);
    timer = setInterval(() => {
      if (closed) { active.stop(); return; }
      const current = currentSession(request);
      if (!current || current.hash !== session.hash || !stillAllowed(current.user)) response.destroy();
    }, 1000);
    timer.unref();
    stream.on('error', () => response.destroy());
    response.once('close', cleanup);
    stream.pipe(response);
  }

  function serveStatic(request, response, pathname) {
    requireCondition(['GET', 'HEAD'].includes(request.method), 405, 'Метод не поддерживается', 'METHOD_NOT_ALLOWED');
    const root = resolve(staticDir);
    let file = resolve(root, `.${pathname}`);
    requireCondition(file === root || file.startsWith(root + sep), 404, 'Страница не найдена', 'NOT_FOUND');
    if (!existsSync(file) || !statSync(file).isFile()) {
      requireCondition(!extname(pathname), 404, 'Файл не найден', 'NOT_FOUND');
      file = resolve(root, 'index.html');
    }
    if (!existsSync(file)) return respond(response, 503, { error: 'Интерфейс ещё не собран', code: 'FRONTEND_NOT_BUILT' });
    const info = statSync(file);
    response.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Content-Length': info.size, 'Cache-Control': extname(file) === '.html' ? 'no-store' : 'public,max-age=3600' });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(file);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }

  async function dispatch(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    requireCondition(!closed, 503, 'Сервис перезапускается', 'CLOSED');
    requireCondition(validOrigin(request, deploymentConfig), 403, 'Источник запроса не разрешён', 'ORIGIN_FORBIDDEN');
    const rawPath = String(request.url || '/').split('?')[0];
    let decoded;
    try { decoded = decodeURIComponent(rawPath); } catch { fail(400, 'Некорректный адрес', 'INVALID_PATH'); }
    requireCondition(!decoded.includes('\\') && !decoded.includes('\0') && !decoded.split('/').includes('..'),
      404, 'Страница не найдена', 'NOT_FOUND');
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return serveStatic(request, response, decodeURIComponent(pathname));
    response.setHeader('Cache-Control', 'no-store');
    if (pathname === '/api/health' && request.method === 'GET') return respond(response, 200, { ok: true, mode: 'pilot' });
    xiaomiRefresh?.refresh();
    const session = currentSession(request);
    if (pathname === '/api/session' && request.method === 'GET') return respond(response, 200, state(session));
    if (pathname === '/api/login' && request.method === 'POST') {
      const peerAddress = request.socket.remoteAddress || 'unknown';
      loginBucket(`ip:${peerAddress}`, 120, Date.now()).count++;
      const body = await bodyJSON(request);
      requireCondition(typeof body.email === 'string' && typeof body.password === 'string'
        && body.email.length <= 254 && body.password.length <= 200, 400, 'Укажите email и пароль', 'INVALID_LOGIN');
      const email = body.email.trim().toLowerCase();
      const key = `pair:${JSON.stringify([peerAddress, email])}`;
      const now = Date.now();
      const attempts = loginBucket(key, 10, now);
      const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      const correct = verifyPassword(body.password, row?.password_salt || dummyPassword.salt,
        row?.password_hash || dummyPassword.hash);
      if (!row?.active || !correct) {
        attempts.count++;
        audit(null, 'Неудачный вход', 'Вход в сервис');
        fail(401, 'Неверный email или пароль', 'INVALID_CREDENTIALS');
      }
      loginAttempts.delete(key);
      if (session) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.hash);
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
      const token = randomToken(), csrf = randomToken();
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(tokenHash(token), row.id, csrf, now + SESSION_SECONDS * 1000);
      const user = effectiveUser(row);
      audit(user, 'Вход в сервис', user.name);
      return respond(response, 200, state({ user, csrf }), { 'Set-Cookie': sessionCookie(token, false, deploymentConfig.secureCookies) });
    }
    requireCondition(session, 401, 'Войдите в сервис', 'AUTH_REQUIRED');
    const user = session.user;
    if (!['GET', 'HEAD'].includes(request.method)) {
      requireCondition(equalTokens(request.headers['x-csrf-token'], session.csrf),
        403, 'Обновите страницу и повторите действие', 'CSRF_REQUIRED');
    }
    if (pathname === '/api/logout' && request.method === 'POST') {
      live.stopLogin(session.hash);
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.hash);
      audit(user, 'Выход из сервиса', user.name);
      return respond(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', true, deploymentConfig.secureCookies) });
    }
    if (pathname === '/api/microphones' && request.method === 'GET') {
      const catalog = microphoneCatalogFor(user);
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      requireCondition((from === null || validDate(from)) && (to === null || validDate(to)) && (!from || !to || from <= to),
        400, 'Укажите корректный период', 'INVALID_DATE_RANGE');
      const permittedStations = stations.filter(station => user.microphoneStationIds.includes(station.id));
      return respond(response, 200, microphoneSummary(microphoneDir, catalog, permittedStations,
        { from, to, region: url.searchParams.get('region'), stationId: url.searchParams.get('stationId') }));
    }
    const microphonePdfMatch = /^\/api\/microphones\/reports\/([^/]+)\/pdf$/.exec(pathname);
    if (microphonePdfMatch && ['GET', 'HEAD'].includes(request.method))
      return serveMicrophonePdf(request, response, session, microphonePdfMatch[1]);
    if (pathname === '/api/stations' && request.method === 'GET') {
      const date = checkDate(url), allowedCameras = visibleCameras(user);
      const runs = readAnalysis(analysisConfig).filter(run => allowedCameras.some(c => c.id === run.cameraId));
      const stationMetrics = stationId => {
        const own = allowedCameras.filter(c => c.stationId === stationId);
        const primary = own.find(c => c.source === 'analysis_config' && c.primary);
        const measured = primary && analysisMetrics(runs, primary.id, date);
        if (measured?.source === 'analysis') return measured;
        return aggregateMetrics(own, date);
      };
      return respond(response, 200, { stations: visibleStations(user).map(s => ({ ...s,
        cameraCount: allowedCameras.filter(c => c.stationId === s.id).length,
        metrics: stationMetrics(s.id),
        demoMetrics: aggregateMetrics(allowedCameras.filter(c => c.stationId === s.id && c.status === 'demo'), date) })),
        demoDate: DEMO_DATE, demo: date === DEMO_DATE });
    }
    if (pathname === '/api/cameras' && request.method === 'GET') {
      const date = checkDate(url), stationId = url.searchParams.get('stationId');
      const runs = readAnalysis(analysisConfig).filter(run => canCamera(user, cameraMap.get(run.cameraId)));
      return respond(response, 200, { cameras: visibleCameras(user).filter(c => !stationId || c.stationId === stationId)
        .map(c => {
          const { candidateStationIds, ...safeCamera } = c;
          return { ...safeCamera, ...(user.role === 'admin' && candidateStationIds ? { candidateStationIds } : {}),
            liveAvailable: live.available(c.id),
            archiveAvailable: c.source === 'analysis_config' ? analysisPlayback(runs, c.id).status === 'available'
              : c.id === 'probe-c300' && hasProbeMedia(mediaFile),
            metrics: c.source === 'analysis_config' ? analysisMetrics(runs, c.id, date)
              : c.status === 'demo' && date === DEMO_DATE ? c.metrics : noneMetrics(c.metrics.note),
            mediaUrl: c.id === 'probe-c300' && hasProbeMedia(mediaFile) ? '/api/cameras/probe-c300/media' : null };
        }) });
    }
    if (['/api/events', '/api/visits'].includes(pathname) && request.method === 'GET') {
      const date = checkDate(url), stationId = url.searchParams.get('stationId'), cameraId = url.searchParams.get('cameraId');
      const scopedEvents = date === DEMO_DATE ? events.filter(e =>
        canCamera(user, cameraMap.get(e.cameraId)) && (!stationId || e.stationId === stationId)
        && (!cameraId || e.cameraId === cameraId)) : [];
      const runs = readAnalysis(analysisConfig).filter(run => canCamera(user, cameraMap.get(run.cameraId))
        && (!stationId || run.stationId === stationId) && (!cameraId || run.cameraId === cameraId));
      scopedEvents.push(...analysisEvents(runs, date));
      return respond(response, 200, pathname === '/api/visits' ? { visits: buildVisits(scopedEvents) } : { events: scopedEvents });
    }
    const playbackMatch = /^\/api\/cameras\/([^/]+)\/playback$/.exec(pathname);
    if (playbackMatch && request.method === 'GET') {
      const camera = cameraMap.get(playbackMatch[1]);
      requireCondition(canCamera(user, camera), 403, 'Нет доступа к этой камере', 'CAMERA_FORBIDDEN');
      const playback = playbackState(camera, hasProbeMedia(mediaFile), live.available(camera.id));
      if (camera.source === 'analysis_config') playback.archive = analysisPlayback(
        readAnalysis(analysisConfig).filter(run => run.cameraId === camera.id), camera.id);
      return respond(response, 200, playback);
    }
    const liveStart = /^\/api\/cameras\/([^/]+)\/live$/.exec(pathname);
    if (liveStart && request.method === 'POST') {
      const camera = cameraMap.get(liveStart[1]);
      requireCondition(canCamera(user, camera), 403, 'Нет доступа к этой камере', 'CAMERA_FORBIDDEN');
      return respond(response, 201, live.create(camera.id, user.id, session.hash));
    }
    const liveSession = /^\/api\/cameras\/([^/]+)\/live\/([^/]+)(\/stream)?$/.exec(pathname);
    if (liveSession && (request.method === 'DELETE' && !liveSession[3] || request.method === 'GET' && liveSession[3])) {
      const camera = cameraMap.get(liveSession[1]);
      requireCondition(canCamera(user, camera), 403, 'Нет доступа к этой камере', 'CAMERA_FORBIDDEN');
      if (request.method === 'DELETE') {
        await live.stop(camera.id, liveSession[2], user.id, session.hash);
        return respond(response, 200, { ok: true });
      }
      return live.stream(request, response, { cameraId: camera.id, sessionId: liveSession[2],
        ownerId: user.id, loginHash: session.hash, isAuthorized: () => {
          const now = currentSession(request);
          return Boolean(now && now.hash === session.hash && now.user.id === user.id && canCamera(now.user, cameraMap.get(camera.id)));
        } });
    }
    if (pathname === '/api/archive' && request.method === 'GET') {
      const cameraId = url.searchParams.get('cameraId');
      requireCondition(cameraId, 400, 'Выберите камеру', 'CAMERA_REQUIRED');
      const camera = cameraMap.get(cameraId);
      requireCondition(canCamera(user, camera), 403, 'Нет доступа к этой камере', 'CAMERA_FORBIDDEN');
      const interval = Object.fromEntries(['date', 'from', 'to'].map(key => [key, url.searchParams.get(key)]));
      requireCondition(['date', 'from', 'to', 'cameraId'].every(key => url.searchParams.getAll(key).length === 1)
        && validDate(interval.date), 400, 'Укажите корректную дату и интервал поиска', 'INVALID_ARCHIVE_INTERVAL');
      const start = timeSeconds(interval.from), end = timeSeconds(interval.to);
      requireCondition(start !== null && end !== null && start < end,
        400, 'Укажите время в формате ЧЧ:ММ или ЧЧ:ММ:СС. Конец должен быть позже начала в тот же день.', 'INVALID_ARCHIVE_INTERVAL');
      return respond(response, 200, camera.source === 'analysis_config'
        ? searchAnalysisArchive(readAnalysis(analysisConfig).filter(run => run.cameraId === camera.id), camera.id, interval)
        : archiveSearch(camera, interval, hasProbeMedia(mediaFile)));
    }
    const exactRecordingMatch = /^\/api\/cameras\/([^/]+)\/recordings\/([^/]+)$/.exec(pathname);
    if (exactRecordingMatch && request.method === 'GET') {
      const camera = cameraMap.get(exactRecordingMatch[1]);
      requireCondition(canCamera(user, camera), 403, 'Нет доступа к этой камере', 'CAMERA_FORBIDDEN');
      const value = url.searchParams.get('offsetSeconds'), offset = Number(value);
      requireCondition(url.searchParams.getAll('offsetSeconds').length === 1 && value !== null
        && value.length <= 32 && /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
        && Number.isFinite(offset) && offset >= 0,
      400, 'Укажите корректное смещение записи в секундах', 'INVALID_RECORDING_OFFSET');
      const runs = readAnalysis(analysisConfig).filter(run => run.cameraId === camera.id);
      const run = runs.find(run => run.recording.id === exactRecordingMatch[2]);
      requireCondition(run, 404, 'Запись недоступна', 'MEDIA_UNAVAILABLE');
      requireCondition(offset < run.recording.durationSeconds, 400, 'Смещение выходит за границы записи', 'INVALID_RECORDING_OFFSET');
      const record = exactAnalysisRecording(runs, camera.id, exactRecordingMatch[2], offset);
      requireCondition(record, 404, 'Запись недоступна', 'MEDIA_UNAVAILABLE');
      return respond(response, 200, { record });
    }
    const recordingMatch = /^\/api\/cameras\/([^/]+)\/recordings\/([^/]+)\/media$/.exec(pathname);
    if (recordingMatch && ['GET', 'HEAD'].includes(request.method))
      return serveRecording(request, response, session, recordingMatch[1], recordingMatch[2]);
    const mediaMatch = /^\/api\/cameras\/([^/]+)\/media$/.exec(pathname);
    if (mediaMatch && ['GET', 'HEAD'].includes(request.method)) return serveMedia(request, response, user, mediaMatch[1]);
    if (pathname === '/api/users' && request.method === 'GET') {
      requireCondition(user.role !== 'regional', 403, 'Нет прав управления пользователями', 'USERS_FORBIDDEN');
      const rows = db.prepare('SELECT * FROM users ORDER BY created_at,name').all();
      return respond(response, 200, { users: rows.filter(row => canManage(user, row)).map(row => managedUser(user, row)) });
    }
    if (pathname === '/api/users' && request.method === 'POST') {
      requireCondition(user.role !== 'regional', 403, 'Нет прав управления пользователями', 'USERS_FORBIDDEN');
      const body = await bodyJSON(request), actor = currentManager(request, session), data = validateUserInput(body, actor);
      requireCondition(!db.prepare('SELECT id FROM users WHERE email=?').get(data.email),
        409, 'Пользователь с таким email уже существует', 'EMAIL_EXISTS');
      const id = randomUUID(), { salt, hash } = hashPassword(body.password);
      insert.run(id, data.name, data.email, salt, hash, data.role,
        JSON.stringify(data.stationIds), JSON.stringify(data.cameraIds), actor.id, new Date().toISOString(),
        JSON.stringify(data.microphoneStationIds));
      if (actor.role === 'director') db.prepare('UPDATE users SET delegated_by=? WHERE id=?').run(actor.id, id);
      if (!data.active) db.prepare('UPDATE users SET active=0 WHERE id=?').run(id);
      audit(actor, 'Создан пользователь', data.name, JSON.stringify({ role: data.role,
        stations: data.stationIds.length, cameras: data.cameraIds.length, microphones: data.microphoneStationIds.length }));
      return respond(response, 201, { user: managedUser(actor, getUserRow(id)) });
    }
    const userMatch = /^\/api\/users\/([^/]+)$/.exec(pathname);
    if (userMatch && request.method === 'PATCH') {
      requireCondition(user.role !== 'regional', 403, 'Нет прав управления пользователями', 'USERS_FORBIDDEN');
      const allowed = actor => {
        const row = getUserRow(userMatch[1]);
        requireCondition(row && canManage(actor, row), 403, 'Нет прав изменения этого пользователя', 'USER_FORBIDDEN');
        return row;
      };
      allowed(user);
      const body = await bodyJSON(request), actor = currentManager(request, session), row = allowed(actor);
      const data = validateUserInput(body, actor, row);
      const before = effectiveUser(row);
      const sameSet = (left, right) => left.length === right.length
        && [...left].sort().every((value, index) => value === [...right].sort()[index]);
      const grantsChanged = data.role !== row.role || !sameSet(data.stationIds, before.stationIds)
        || !sameSet(data.cameraIds, before.cameraIds);
      const microphoneGrantsChanged = !sameSet(data.microphoneStationIds, publicUser(row).microphoneStationIds);
      const duplicate = db.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(data.email, row.id);
      requireCondition(!duplicate, 409, 'Пользователь с таким email уже существует', 'EMAIL_EXISTS');
      if (row.role === 'admin' && row.active && (data.role !== 'admin' || !data.active)) {
        requireCondition(db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").get().n > 1,
          409, 'Нельзя отключить последнего администратора', 'LAST_ADMIN');
      }
      let salt = row.password_salt, hash = row.password_hash;
      if (body.password !== undefined) ({ salt, hash } = hashPassword(body.password));
      db.prepare(`UPDATE users SET name=?,email=?,role=?,active=?,station_ids=?,camera_ids=?,microphone_station_ids=?,password_salt=?,password_hash=? WHERE id=?`)
        .run(data.name, data.email, data.role, data.active ? 1 : 0,
          grantsChanged ? JSON.stringify(data.stationIds) : row.station_ids,
          grantsChanged ? JSON.stringify(data.cameraIds) : row.camera_ids,
          microphoneGrantsChanged ? JSON.stringify(data.microphoneStationIds) : row.microphone_station_ids, salt, hash, row.id);
      if (actor.role === 'admin' && grantsChanged)
        db.prepare('UPDATE users SET delegated_by=NULL WHERE id=?').run(row.id);
      if (!data.active || body.password !== undefined || row.role !== data.role)
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.id);
      audit(actor, grantsChanged || microphoneGrantsChanged ? 'Изменены права пользователя' : 'Изменён пользователь', data.name,
        JSON.stringify({ role: data.role, active: data.active, stations: data.stationIds.length, cameras: data.cameraIds.length,
          ...(actor.role === 'admin' && { microphones: data.microphoneStationIds.length }) }));
      return respond(response, 200, { user: managedUser(actor, getUserRow(row.id)) });
    }
    if (pathname === '/api/audit' && request.method === 'GET') {
      requireCondition(user.role !== 'regional', 403, 'Нет доступа к журналу управления', 'AUDIT_FORBIDDEN');
      const rows = user.role === 'admin' ? db.prepare('SELECT * FROM audit ORDER BY at DESC LIMIT 300').all()
        : db.prepare('SELECT * FROM audit WHERE actor_id=? ORDER BY at DESC LIMIT 300').all(user.id);
      return respond(response, 200, { events: rows.map(({ actor_id, ...event }) => event) });
    }
    fail(404, 'Раздел не найден', 'NOT_FOUND');
  }

  const handler = (request, response) => dispatch(request, response).catch(error => {
    if (response.headersSent) { response.destroy(); return; }
    if (error instanceof HTTPError || error instanceof LiveError) respond(response, error.status, { error: error.message, code: error.code });
    else respond(response, 500, { error: 'Не удалось выполнить действие. Повторите попытку', code: 'INTERNAL_ERROR' });
  });
  handler.close = () => {
    if (!closed) {
      closed = true;
      xiaomiRefresh?.close();
      const active = [...archiveStreams];
      for (const stream of active) stream.stop();
      closePromise = Promise.all([live.close(), ...active.map(stream => stream.done)]).then(() => undefined);
      db.close();
    }
    return closePromise;
  };
  return handler;
}
