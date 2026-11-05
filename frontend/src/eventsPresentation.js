import { buildVisits, secondsOf } from './playbackHelpers.js';

export const EVENT_METRICS = [
  { id: 'start', title: 'Первое появление и открытие' },
  { id: 'vehicles', title: 'Автомобили' },
  { id: 'closed', title: 'Закрытие' },
  { id: 'review', title: 'Требует проверки' },
];

export function recordingAction(camera) {
  if (camera?.archiveAvailable === false) return { label: 'Запись пока недоступна', actionable: false };
  if (camera?.archiveAvailable === true) return { label: 'Посмотреть момент', actionable: true };
  return { label: 'Проверить наличие записи', actionable: Boolean(camera) };
}

// The current API confirms a processed interval only for the explicit demo.
// A real observation, a live connection or a non-empty source never proves full coverage.
export function describeAnalysis(events = [], analysisSource) {
  const source = typeof analysisSource === 'object' ? analysisSource?.source : analysisSource;
  if (events.some(event => event.type === 'gap') || source === 'partial') {
    return { kind: 'partial', label: 'Данные неполные', countable: false };
  }
  if (source === 'demo') return { kind: 'analyzed', label: 'Пример анализа за день', countable: true };
  if (events.length || source && source !== 'none') {
    return { kind: 'partial', label: 'Полнота анализа не подтверждена', countable: false };
  }
  return { kind: 'none', label: 'Видео ещё не анализировалось', countable: false };
}

export function vehicleCounts(events = [], analysis = describeAnalysis(events), date = '') {
  const entries = events.filter(event => event.type === 'vehicle_entry').length;
  const exits = events.filter(event => event.type === 'vehicle_exit').length;
  const completed = buildVisits(events, date).filter(visit => visit.status === 'paired').length;
  const count = value => value || analysis.countable ? value : null;
  return { entries: count(entries), exits: count(exits), completed: count(completed) };
}

export function reviewEvents(events = [], date = '') {
  const incomplete = new Set(buildVisits(events, date).filter(visit => visit.status !== 'paired').flatMap(visit => visit.events));
  return events.filter(event => event.needsReview || event.type === 'gap' || incomplete.has(event));
}

export function reviewReason(event) {
  if (event.type === 'gap') return event.description || 'В обработанном интервале есть пропуск данных.';
  if (event.type === 'vehicle_entry' || event.type === 'vehicle_exit') return event.description || 'Нужно проверить наблюдение и сопоставление въезда с выездом.';
  return event.description || 'Наблюдение отмечено для проверки.';
}

export function stationEventTitle(station) {
  if (!station) return 'ПТО не определён';
  const city = station.city || '';
  const prefix = `${city},`;
  const fullAddress = station.address || '';
  const address = city && fullAddress.startsWith(prefix) ? fullAddress.slice(prefix.length).trim() : fullAddress;
  return [city, address].filter(Boolean).join(' · ') || 'Адрес ПТО не указан';
}

export function orderedEvents(events = []) {
  return [...events].sort((a, b) => (secondsOf(a.time) ?? Infinity) - (secondsOf(b.time) ?? Infinity));
}

export function eventsForMetric(events, metric, date = '') {
  if (metric === 'start') return events.filter(event => ['first_seen', 'opened'].includes(event.type));
  if (metric === 'vehicles') return events.filter(event => ['vehicle_entry', 'vehicle_exit'].includes(event.type));
  if (metric === 'closed') return events.filter(event => event.type === 'closed');
  return reviewEvents(events, date);
}

export function metricStationRows(rows, metric, date = '') {
  const relevant = metric === 'review' ? rows.filter(row => eventsForMetric(row.events, metric, date).length) : [...rows];
  return relevant.sort((a, b) => Number(Boolean(eventsForMetric(b.events, metric, date).length)) - Number(Boolean(eventsForMetric(a.events, metric, date).length)) || a.title.localeCompare(b.title, 'ru'));
}

export function buildStationEventRows({ stations = [], cameras = [], events = [], date = '', search = '', manager = '', region = '' } = {}) {
  const rows = new Map(stations.map(station => [station.id, { id: station.id, station, title: stationEventTitle(station), cameras: [], events: [] }]));
  const cameraById = new Map(cameras.map(camera => [camera.id, camera]));
  for (const camera of cameras) rows.get(camera.stationId)?.cameras.push(camera);
  for (const event of events) {
    let row = rows.get(event.stationId);
    if (!row) {
      const key = `unassigned:${event.cameraId || 'unknown'}`;
      if (!rows.has(key)) rows.set(key, { id: key, station: null, title: 'ПТО не определён', cameras: cameraById.has(event.cameraId) ? [cameraById.get(event.cameraId)] : [], events: [] });
      row = rows.get(key);
    }
    row.events.push(event);
  }
  const term = search.trim().toLocaleLowerCase('ru');
  return [...rows.values()].filter(row => {
    if (manager && row.station?.manager !== manager || region && row.station?.region !== region) return false;
    return !term || [row.title, row.station?.manager, row.station?.region, ...row.cameras.map(camera => camera.name)].filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(term);
  }).map(row => ({ ...row, events: orderedEvents(row.events), visits: buildVisits(row.events, date), analysis: describeAnalysis(row.events, row.station?.metrics?.source || row.cameras.find(camera => camera.metrics?.source === 'demo')?.metrics?.source) }))
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
}
