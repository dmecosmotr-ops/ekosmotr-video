import { readFileSync, statSync } from 'node:fs';
import { matchCameras } from './camera-matching.mjs';
import { noneMetrics } from './demo.mjs';

// Optional trusted local metadata export. Never load provider configuration, credentials or network URLs here.
export function importInventory(inventoryFile, stations, reservedIds = []) {
  if (!inventoryFile) return [];
  let raw;
  try {
    const info = statSync(inventoryFile);
    if (!info.isFile() || info.size > 1024 * 1024) return [];
    raw = JSON.parse(readFileSync(inventoryFile, 'utf8'));
  } catch { return []; }
  if (!Array.isArray(raw) || raw.length > 1000) return [];
  const used = new Set(reservedIds), safe = [];
  const safeText = (value, limit) => typeof value === 'string' && value.trim().length > 0
    && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
  for (const value of raw) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.id)
      || used.has(value.id) || !safeText(value.name, 160) || !safeText(value.model, 100)) continue;
    used.add(value.id);
    safe.push({ id: value.id, name: value.name.trim(), model: value.model.trim() });
  }
  return matchCameras(safe, stations).map(camera => ({
    id: camera.id, name: camera.name, model: camera.model, stationId: camera.stationId,
    mappingStatus: camera.mappingStatus, mappingReason: camera.mappingReason,
    candidateStationIds: camera.candidateStationIds, source: 'xiaomi_inventory',
    status: 'unconnected', view: 'unknown',
    metrics: noneMetrics('Импортировано только название камеры. Видеопоток, архив и анализ пока не подключены.'),
  }));
}
