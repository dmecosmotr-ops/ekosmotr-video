export function monitorLimit(value, protocol = '') {
  const serverLimit = Number.isInteger(value) && value >= 1 && value <= 150 ? value : 1;
  return protocol === 'h2' || protocol === 'h3' ? serverLimit : Math.min(serverLimit, 5);
}
const idAllowed = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id);

// Input is already scoped by the API; storage never supplies camera metadata or rights.
export function monitorCandidates(cameras, stations, search = '', region = '') {
  const byStation = new Map(stations.map(station => [station.id, station]));
  const term = search.trim().toLocaleLowerCase('ru');
  return cameras.filter(camera => camera.liveAvailable === true && camera.status !== 'demo' && camera.status !== 'recorded_probe')
    .map(camera => ({ ...camera, station: byStation.get(camera.stationId) || null }))
    .filter(camera => (!region || camera.station?.region === region) && (!term ||
      [camera.name, camera.station?.city, camera.station?.address, camera.station?.region]
        .filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(term)));
}

export function sanitizeMonitorSelection(value, allowedIds) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(allowedIds);
  return [...new Set(value.filter(id => idAllowed(id) && allowed.has(id)))];
}

export function monitorGridLayout(count, width, height) {
  if (!count || width <= 0 || height <= 0) return null;
  const gap = Math.min(8, Math.floor(Math.min(width, height) / (Math.ceil(Math.sqrt(count)) * 8)));
  let best;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const tileWidth = (width - (columns - 1) * gap) / columns;
    const tileHeight = (height - (rows - 1) * gap) / rows;
    if (tileWidth <= 0 || tileHeight <= 0) continue;
    const mediaWidth = Math.min(tileWidth, tileHeight * 16 / 9);
    const empty = rows * columns - count;
    if (!best || mediaWidth > best.mediaWidth || (mediaWidth === best.mediaWidth && empty < best.empty)) {
      best = { columns, rows, tileWidth, tileHeight, mediaWidth, empty, gap };
    }
  }
  return best;
}
