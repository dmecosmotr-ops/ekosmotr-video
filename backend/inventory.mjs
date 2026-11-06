import { fstatSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { matchCameras } from './camera-matching.mjs';
import { noneMetrics } from './demo.mjs';
import { openSafeFile } from './analysis.mjs';
import { parseLiveRoutes } from './live.mjs';

export const validSyncGeneration = generation => typeof generation === 'string' && /^gen-[0-9a-f]{32}$/.test(generation);

export function normalizeXiaomiSyncDir(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !isAbsolute(value) || !resolve(value).split(sep).some(part => part.toLowerCase() === 'private'))
    throw new Error('PILOT_XIAOMI_SYNC_DIR must be an absolute path under a private directory');
  return resolve(value);
}

export function readSyncFile(root, file, maxBytes) {
  const opened = openSafeFile(root, file, maxBytes);
  if (!opened) return null;
  try {
    const bytes = Buffer.alloc(opened.size + 1);
    let size = 0, read;
    while (size < bytes.length && (read = readSync(opened.fd, bytes, size, bytes.length - size, null)) > 0) size += read;
    const after = fstatSync(opened.fd);
    return size === opened.size && after.size === opened.size && after.mtimeMs === opened.info.mtimeMs
      ? JSON.parse(bytes.subarray(0, size).toString('utf8')) : null;
  } catch { return null; }
  finally { opened.close(); }
}

export function readSyncPointer(root) {
  const value = readSyncFile(root, 'current.json', 256);
  return value?.version === 1 && Object.keys(value).length === 2 && validSyncGeneration(value.generation) ? value.generation : null;
}

// The manifest and inventory are validated before the catalog or permissions change.
export function startXiaomiRefresh({ root, db, stations, reservedIds, previousInventory, analysisCameras, replace }) {
  if (!root) return undefined;
  db.exec(`CREATE TABLE IF NOT EXISTS xiaomi_sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL, scopes TEXT NOT NULL
  )`);
  const stored = db.prepare('SELECT generation, scopes FROM xiaomi_sync_state WHERE id = 1').get();
  const analysisStations = new Map(analysisCameras.map(camera => [camera.id, camera.stationId]));
  const initialScopes = previousInventory.map(camera => [camera.id, camera.stationId]);
  let previousScopes = new Map(stored ? JSON.parse(stored.scopes) : initialScopes);
  let applied, rejected, retryAt = 0;

  function applyGeneration(generation) {
    if (!validSyncGeneration(generation)) return false;
    if (generation === applied) return true;
    if (generation === rejected && Date.now() < retryAt) return false;
    const rawInventory = readSyncFile(root, `${generation}/camera-inventory.json`, 1024 * 1024);
    const inventory = projectInventory(rawInventory, stations, reservedIds, true);
    const nextScopes = new Map(inventory?.map(camera => [camera.id, camera.stationId]));
    const rawRoutes = readSyncFile(root, `${generation}/live-config.json`, 512 * 1024);
    const configuration = parseLiveRoutes(rawRoutes, new Set(nextScopes.keys()), { allowEmpty: true });
    if (!inventory || !configuration) {
      rejected = generation; retryAt = Date.now() + 1000;
      return false;
    }
    const routes = configuration.cameras.filter(({ cameraId }) => {
      const station = nextScopes.get(cameraId);
      return station === null || !analysisStations.has(cameraId) || analysisStations.get(cameraId) === station;
    });
    const revoked = new Set([...previousScopes].filter(([id, station]) => !nextScopes.has(id)
      || station !== nextScopes.get(id)).map(([id]) => id));
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (revoked.size) {
          const update = db.prepare('UPDATE users SET camera_ids=? WHERE id=?');
          for (const row of db.prepare('SELECT id, camera_ids FROM users').all()) {
            const ids = JSON.parse(row.camera_ids);
            const retained = ids.filter(id => !revoked.has(id));
            if (ids.length !== retained.length) update.run(JSON.stringify(retained), row.id);
          }
        }
        db.prepare(`INSERT INTO xiaomi_sync_state (id, generation, scopes) VALUES (1, ?, ?)
          ON CONFLICT (id) DO UPDATE SET generation = excluded.generation, scopes = excluded.scopes`)
          .run(generation, JSON.stringify([...nextScopes]));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } catch {
      rejected = generation; retryAt = Date.now() + 1000;
      return false;
    }
    replace(inventory, routes, revoked);
    previousScopes = nextScopes;
    applied = generation;
    return true;
  }

  const refresh = () => applyGeneration(readSyncPointer(root));
  if (!refresh() && stored && !applyGeneration(stored.generation)) replace([], [], new Set(previousScopes.keys()));
  const timer = setInterval(refresh, 1000);
  timer.unref();
  return { refresh, close: () => clearInterval(timer) };
}

// Optional trusted local metadata export. Never load provider configuration, credentials or network URLs here.
export function importInventory(inventoryFile, stations, reservedIds = []) {
  if (!inventoryFile) return [];
  let raw;
  try {
    const info = statSync(inventoryFile);
    if (!info.isFile() || info.size > 1024 * 1024) return [];
    raw = JSON.parse(readFileSync(inventoryFile, 'utf8'));
  } catch { return []; }
  return projectInventory(raw, stations, reservedIds) ?? [];
}

export function projectInventory(raw, stations, reservedIds = [], strict = false) {
  const legacy = Array.isArray(raw);
  if (strict && (raw?.version !== 1 || Object.keys(raw).length !== 2)) return null;
  const entries = legacy ? raw : raw?.version === 1 ? raw.cameras : null;
  if (!Array.isArray(entries) || entries.length > 1000) return null;
  const stationIds = new Set(stations.map(station => station?.id).filter(id => typeof id === 'string' && id));
  const used = new Set(reservedIds), safe = [];
  const safeText = (value, limit) => typeof value === 'string' && value.trim().length > 0
    && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
  for (const value of entries) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.id)
      || used.has(value.id) || !safeText(value.name, 160) || !safeText(value.model, 100)) {
      if (strict) return null;
      continue;
    }
    if (strict && (value.mapping !== 'confirm' || Object.keys(value).some(key => !['id', 'name', 'model', 'mapping', 'stationId'].includes(key))
      || (Object.hasOwn(value, 'stationId') && !stationIds.has(value.stationId))
      || /https?:\/\/|(?:token|password|secret)\s*[:=]/i.test(`${value.name} ${value.model}`))) return null;
    used.add(value.id);
    safe.push({ id: value.id, name: value.name.trim(), model: value.model.trim(),
      autoMatch: legacy || value.mapping === 'legacy',
      confirmedStationId: !legacy && value.mapping === 'confirm' && stationIds.has(value.stationId)
        ? value.stationId : null });
  }
  return matchCameras(safe, stations).map(camera => {
    const { autoMatch, confirmedStationId } = camera;
    const needsConfirmation = !autoMatch && !confirmedStationId && camera.mappingStatus === 'matched';
    return {
      id: camera.id, name: camera.name, model: camera.model,
      stationId: autoMatch ? camera.stationId : confirmedStationId,
      mappingStatus: confirmedStationId ? 'confirmed' : needsConfirmation ? 'needs_mapping' : camera.mappingStatus,
      mappingReason: confirmedStationId ? 'Привязка к станции подтверждена.'
        : needsConfirmation ? 'Адрес найден по названию. Привязку нужно подтвердить.' : camera.mappingReason,
      candidateStationIds: confirmedStationId ? [confirmedStationId] : camera.candidateStationIds,
      source: 'xiaomi_inventory', status: 'unconnected', view: 'unknown',
      metrics: noneMetrics(legacy
        ? 'Импортировано только название камеры. Видеопоток, архив и анализ пока не подключены.'
        : 'Данные анализа для этой камеры ещё не поступили.'),
    };
  });
}
