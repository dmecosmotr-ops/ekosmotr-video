const emptyMetrics = () => ({ source: 'none', firstSeenAt: null, openedAt: null, closedAt: null,
  entries: null, exits: null, completedVisits: null, coverage: null, note: 'Видео ещё не анализировалось' });

export function anonymousSession(previous) {
  return { user: null, csrfToken: null, demoLoginAvailable: previous?.demoLoginAvailable === true,
    ...(previous?.demoDate ? { demoDate: previous.demoDate } : {}),
    ...(previous?.mode ? { mode: previous.mode } : {}) };
}

// This is a display mode, never an access boundary: every input must already be scoped by the API.
export function presentWorkspace(stations, cameras, events, mode = 'real') {
  const demo = mode === 'demo';
  const selectedCameras = cameras.filter(camera => (camera.status === 'demo') === demo);
  const cameraIds = new Set(selectedCameras.map(camera => camera.id));
  return {
    cameras: selectedCameras,
    stations: stations.map(station => {
      const metrics = demo && station.demoMetrics ? station.demoMetrics : station.metrics;
      return { ...station,
      cameraCount: selectedCameras.filter(camera => camera.stationId === station.id).length,
      metrics: metrics?.source && metrics.source !== 'none'
        && (metrics.source === 'demo') === demo ? metrics : emptyMetrics(),
    }; }),
    events: events.filter(event => cameraIds.has(event.cameraId) && (event.source === 'demo') === demo),
  };
}

export function sumMeasured(stations, field) {
  if (!stations.length || stations.some(station => !Number.isFinite(station.metrics?.[field]))) return null;
  return stations.reduce((sum, station) => sum + station.metrics[field], 0);
}

export function groupCameras(cameras, stations) {
  const stationsById = new Map(stations.map(station => [station.id, station]));
  const groups = new Map();
  for (const camera of cameras) {
    const station = stationsById.get(camera.stationId);
    const key = station?.id || 'unassigned';
    if (!groups.has(key)) groups.set(key, { station: station || null, cameras: [] });
    groups.get(key).cameras.push(camera);
  }
  return [...groups.values()].sort((a, b) => Number(!a.station) - Number(!b.station)
    || (a.station?.address || '').localeCompare(b.station?.address || '', 'ru'));
}

export function localDay(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
