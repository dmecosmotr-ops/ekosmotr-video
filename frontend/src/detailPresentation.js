const text = value => String(value || '').trim();
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function stationAddress(station) {
  const city = text(station?.city), full = text(station?.address);
  if (!city || !full) return full;
  return full.replace(new RegExp(`^(?:г\\.?\\s*)?${escapePattern(city)}(?:\\s*[,·]\\s*|$)`, 'iu'), '').trim();
}

export function stationTitle(station) {
  const city = text(station?.city), location = stationAddress(station);
  if (city && location) return `${city} · ${location}`;
  if (city) return `${city} · адрес ПТО не указан`;
  return location || 'Адрес ПТО не установлен';
}

export function cameraViewLabel(camera) {
  return ({ gate_line: 'Ворота и диагностическая линия', client_area: 'Клиентская зона' })[camera?.view] || 'Ракурс не проверен';
}

export function cameraAvailabilityLabel(camera) {
  const labels = [];
  if (camera?.liveAvailable === true) labels.push('Просмотр настроен');
  if (camera?.archiveAvailable === true) labels.push('Архив');
  return labels.join(' · ') || 'Видео не подключено';
}

export function selectDetailCamera(cameras, { mode = 'online', currentId = '', preserveSelection = false } = {}) {
  const current = cameras.find(camera => camera.id === currentId);
  if (current && preserveSelection) return current.id;
  const preferred = cameras.find(camera => mode === 'archive' ? camera.archiveAvailable === true : camera.liveAvailable === true);
  return preferred?.id || current?.id || cameras[0]?.id || '';
}

export function archiveSearchAllowed(playback, cameraId, loading = false) {
  return Boolean(!loading && cameraId && playback?.cameraId === cameraId && playback.archive?.status === 'available');
}

export function cameraInitialView(camera, initialMode) {
  const explicit = initialMode === 'online' || initialMode === 'archive';
  const mode = explicit ? initialMode : camera?.liveAvailable ? 'online' : camera?.archiveAvailable ? 'archive' : 'online';
  return { section: explicit || camera?.liveAvailable || camera?.archiveAvailable ? 'video' : 'events', mode };
}
