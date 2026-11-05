export const DEMO_DATE = '2026-10-30';
export const noneMetrics = (note = 'Нет результатов анализа за выбранный день') => ({
  source: 'none', openedAt: null, closedAt: null, firstSeenAt: null,
  entries: null, exits: null, completedVisits: null, coverage: null, note,
});

export function makeDemo(stations) {
  const selected = [];
  for (const city of ['Екатеринбург', 'Новосибирск', 'Краснодар', 'Москва', 'Тула']) {
    const station = stations.find(s => s.city === city && !selected.some(v => v.id === s.id));
    if (station) selected.push(station);
  }
  for (const station of stations) {
    if (selected.length === 5) break;
    if (!selected.some(s => s.id === station.id)) selected.push(station);
  }
  const entries = [38, 24, 31, 19, 42];
  const opened = ['08:02', '07:58', '08:14', '08:00', '08:07'];
  const closed = ['19:56', '20:01', '19:49', '20:00', '19:58'];
  const seen = ['07:48', '07:43', '08:06', '07:46', '07:51'];
  const cameras = selected.map((station, index) => ({
    id: `demo-${index + 1}`, stationId: station.id,
    name: 'Ворота и диагностическая линия', model: 'Демонстрационная камера',
    view: 'gate_line', status: 'demo',
    metrics: { source: 'demo', openedAt: opened[index], closedAt: closed[index],
      firstSeenAt: seen[index], entries: entries[index], exits: entries[index], completedVisits: entries[index],
      coverage: 'Демонстрационный день',
      note: 'Учебный сценарий, не измерение на этой станции. Первое появление человека не подтверждает его личность или начало работы.' },
  }));
  cameras.push({ id: 'probe-c300', stationId: null, name: 'Проверка подключения C300',
    model: 'Xiaomi C300', view: 'client_area', status: 'recorded_probe',
    metrics: noneMetrics('Клип проверки связи 30.10.2026: клиентская зона, 10,35 секунды. Адрес ПТО не установлен. Живой поток не подключён.'),
  });
  const events = [];
  for (const camera of cameras.filter(c => c.status === 'demo')) {
    const add = (suffix, time, type, label, description, needsReview = false, visitId = null) => events.push({
      id: `${camera.id}-${suffix}`, stationId: camera.stationId, cameraId: camera.id,
      time, type, visitId, label, description, source: 'demo', needsReview,
    });
    add('first', camera.metrics.firstSeenAt, 'first_seen', 'Первое появление человека',
      'Демонстрационное событие. Нужно подтвердить, что в кадре сотрудник.', true);
    add('open', camera.metrics.openedAt, 'opened', 'Открытие станции',
      'Демонстрационное событие по открытию ворот; соответствие началу обслуживания проверяется отдельно.');
    const [hour, minute] = camera.metrics.openedAt.split(':').map(Number);
    const start = hour * 60 + minute + 5;
    for (let i = 0; i < camera.metrics.entries; i++) {
      const at = start + Math.floor(i * ((19 * 60 + 35 - start) / camera.metrics.entries));
      const time = formatMinutes(at), visitId = `${camera.id}-visit-${i + 1}`;
      add(`entry-${i + 1}`, time, 'vehicle_entry', 'Въезд автомобиля',
        'Демонстрационное пересечение линии въезда. Повторный въезд не равен новому клиенту.', false, visitId);
      add(`exit-${i + 1}`, formatMinutes(at + 8 + (i % 5) * 3), 'vehicle_exit', 'Выезд автомобиля',
        'Выезд связан с учебным въездом. В реальном видео такая связь требует отдельной проверки.', false, visitId);
    }
    add('close', camera.metrics.closedAt, 'closed', 'Закрытие станции',
      'Демонстрационное событие по закрытию ворот.');
  }
  events.sort((a, b) => a.time.localeCompare(b.time));
  return { cameras, events };
}

export function aggregateMetrics(cameras, date) {
  const demo = cameras.filter(c => c.status === 'demo' && date === DEMO_DATE);
  if (!demo.length) return noneMetrics();
  const times = field => demo.map(c => c.metrics[field]).filter(Boolean).sort();
  return { source: 'demo', openedAt: times('openedAt')[0] || null,
    closedAt: times('closedAt').at(-1) || null, firstSeenAt: times('firstSeenAt')[0] || null,
    entries: demo.reduce((sum, c) => sum + c.metrics.entries, 0),
    exits: demo.reduce((sum, c) => sum + c.metrics.exits, 0),
    completedVisits: demo.reduce((sum, c) => sum + c.metrics.completedVisits, 0), coverage: 'Демонстрационный день',
    note: 'Демонстрационные показатели по доступным камерам; не результат ИИ на этой станции.' };
}

const formatMinutes = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const seconds = time => {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time || '');
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] || 0) > 59) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
};

// Call only after date, station and camera scope filtering. A visitId never proves a plate or person identity.
export function buildVisits(visibleEvents) {
  const groups = new Map(), visits = [];
  const unpaired = event => ({ id: `${event.id}-unpaired`, stationId: event.stationId, cameraId: event.cameraId,
    enteredAt: event.type === 'vehicle_entry' ? event.time : null,
    exitedAt: event.type === 'vehicle_exit' ? event.time : null, durationMinutes: null,
    status: event.type === 'vehicle_entry' ? 'entry_only' : 'exit_only', source: event.source, needsReview: true });
  for (const event of visibleEvents.filter(e => ['vehicle_entry', 'vehicle_exit'].includes(e.type))) {
    if (!event.visitId) { visits.push(unpaired(event)); continue; }
    const key = JSON.stringify([event.date || DEMO_DATE, event.stationId, event.cameraId, event.visitId]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  for (const observations of groups.values()) {
    const entries = observations.filter(e => e.type === 'vehicle_entry');
    const exits = observations.filter(e => e.type === 'vehicle_exit');
    const entry = entries[0], exit = exits[0];
    const start = seconds(entry?.time), end = seconds(exit?.time);
    if (entries.length === 1 && exits.length === 1 && start !== null && end !== null && end > start) {
      visits.push({ id: entry.visitId, stationId: entry.stationId, cameraId: entry.cameraId,
        enteredAt: entry.time, exitedAt: exit.time, durationMinutes: (end - start) / 60,
        status: 'paired', source: entry.source, needsReview: Boolean(entry.needsReview || exit.needsReview) });
    } else visits.push(...observations.map(unpaired));
  }
  return visits.sort((a, b) => (a.enteredAt || a.exitedAt).localeCompare(b.enteredAt || b.exitedAt));
}
