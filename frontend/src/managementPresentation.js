const unique = values => [...new Set(values || [])];
const compare = (left, right) => String(left || '').localeCompare(String(right || ''), 'ru');
const matches = (values, term) => !term || values.filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(term);

export const roleDescriptions = {
  admin: 'Видит всю сеть, управляет пользователями и назначает роли и доступы.',
  director: 'Видит назначенные ПТО и камеры. Создаёт региональных руководителей и выдаёт им доступ в пределах своих полномочий.',
  regional: 'Просматривает назначенные ПТО, камеры и события. Не создаёт пользователей и не меняет чужие доступы.',
};

export function managementStationLabel(station) {
  if (!station) return 'Адрес ПТО недоступен';
  const city = String(station.city || '').trim();
  let address = String(station.address || '').trim();
  if (city && address.startsWith(`${city},`)) address = address.slice(city.length + 1).trim();
  return [city, address].filter(Boolean).join(' · ') || 'Адрес ПТО не указан';
}

// Copy only fields the access UI needs; cameraCount may include hidden cameras.
const stationView = station => ({
  id: station.id, city: station.city, address: station.address,
  manager: station.manager, region: station.region,
});

export function buildAccessTree(stations = [], cameras = [], search = '') {
  const term = String(search).trim().toLocaleLowerCase('ru');
  const nodes = new Map(stations.map(station => [station.id, {
    key: station.id, station: stationView(station), label: managementStationLabel(station), cameras: [],
  }]));
  for (const camera of cameras) {
    const key = camera.stationId || '__unassigned__';
    if (!nodes.has(key)) nodes.set(key, {
      key, station: null,
      label: camera.stationId ? 'Адрес ПТО недоступен' : 'Камеры без привязки к ПТО', cameras: [],
    });
    nodes.get(key).cameras.push(camera);
  }
  const groups = new Map();
  for (const node of nodes.values()) {
    const manager = node.station?.manager || 'Руководитель не указан';
    const region = node.station?.region || 'Регион не указан';
    const parentMatches = matches([node.label, manager, region], term);
    const visibleCameras = node.cameras.filter(camera => parentMatches || matches([camera.name, camera.model], term));
    if (!parentMatches && !visibleCameras.length) continue;
    const key = JSON.stringify([manager, region]);
    if (!groups.has(key)) groups.set(key, { key, manager, region, nodes: [] });
    groups.get(key).nodes.push({ ...node, cameras: [...visibleCameras].sort((a, b) => compare(a.name, b.name)) });
  }
  return [...groups.values()].sort((a, b) => compare(a.manager, b.manager) || compare(a.region, b.region))
    .map(group => ({ ...group, nodes: group.nodes.sort((a, b) => compare(a.label, b.label)) }));
}

export function canGrantStation(currentUser, stationId) {
  return currentUser?.role === 'admin' || currentUser?.role === 'director' && (currentUser.stationIds || []).includes(stationId);
}

export function canGrantCamera(currentUser, camera) {
  // Unmapped cameras cannot be delegated to the regional/director roles.
  if (!camera?.stationId) return false;
  return currentUser?.role === 'admin' || currentUser?.role === 'director'
    && ((currentUser.stationIds || []).includes(camera.stationId) || (currentUser.cameraIds || []).includes(camera.id));
}

export function describeAccess(user, stations = [], cameras = []) {
  if (user.role === 'admin') return { all: true, fullStations: [], cameraGroups: [], individualCameraCount: 0, hasUnavailable: false };
  const stationIds = new Set(user.stationIds || []);
  const stationMap = new Map(stations.map(station => [station.id, station]));
  const cameraMap = new Map(cameras.map(camera => [camera.id, camera]));
  const fullStations = unique(user.stationIds).flatMap(id => {
    const station = stationMap.get(id);
    return station ? [{ label: managementStationLabel(station) }] : [];
  }).sort((a, b) => compare(a.label, b.label));
  let hasUnavailable = fullStations.length !== stationIds.size;
  const groups = new Map();
  let individualCameraCount = 0;
  for (const id of unique(user.cameraIds)) {
    const camera = cameraMap.get(id);
    if (!camera) { hasUnavailable = true; continue; }
    if (stationIds.has(camera.stationId)) continue;
    const station = stationMap.get(camera.stationId);
    const label = station ? managementStationLabel(station) : camera.stationId ? 'Адрес ПТО недоступен' : 'Без привязки к ПТО';
    if (!station) hasUnavailable = true;
    const key = camera.stationId || '__unassigned__';
    if (!groups.has(key)) groups.set(key, { label, cameras: [] });
    groups.get(key).cameras.push({ name: camera.name || 'Название камеры не указано' });
    individualCameraCount += 1;
  }
  return {
    all: false, fullStations, individualCameraCount, hasUnavailable,
    cameraGroups: [...groups.values()].sort((a, b) => compare(a.label, b.label))
      .map(group => ({ ...group, cameras: group.cameras.sort((a, b) => compare(a.name, b.name)) })),
  };
}

export const actionNames = {
  login: 'Вход в сервис', 'auth.login': 'Вход в сервис', login_success: 'Вход в сервис', 'login.success': 'Вход в сервис',
  logout: 'Выход из сервиса', 'auth.logout': 'Выход из сервиса',
  login_failed: 'Неудачный вход', 'login.failure': 'Неудачный вход',
  'user.create': 'Создан пользователь', user_created: 'Создан пользователь', create_user: 'Создан пользователь',
  'user.update': 'Изменён доступ', user_updated: 'Изменён доступ', update_user: 'Изменён доступ',
  media_view: 'Открыта пробная запись', 'media.view': 'Открыта пробная запись',
  'live.start': 'Запрошен онлайн-просмотр', 'live.stop': 'Остановлен онлайн-просмотр',
};

export function auditCategory(action) {
  const label = actionNames[action] || action;
  if (['Вход в сервис', 'Выход из сервиса', 'Неудачный вход'].includes(label)) return 'auth';
  if (['Создан пользователь', 'Изменён доступ', 'Изменены права пользователя', 'Изменён пользователь'].includes(label)) return 'access';
  if (['Открыта пробная запись', 'Запрошен онлайн-просмотр', 'Остановлен онлайн-просмотр'].includes(label)) return 'view';
  return 'other';
}

export function auditActorKey(actor) {
  return typeof actor === 'object' ? actor?.email || actor?.name || '' : String(actor || '');
}

export function auditPersonLabel(person) {
  if (!person) return 'Не указан';
  if (typeof person !== 'object') return String(person);
  return [person.name, person.email].filter(Boolean).join(' · ') || 'Не указан';
}

export function auditDateKey(value, timeZone) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return '';
  const parts = new Intl.DateTimeFormat('en', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}) }).formatToParts(parsed);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function filterAuditItems(items, { from = '', to = '', actor = '', category = '' } = {}, timeZone) {
  if (from && to && from > to) return [];
  return items.filter(item => {
    if (actor && auditActorKey(item.actor) !== actor || category && auditCategory(item.action) !== category) return false;
    if (!from && !to) return true;
    const day = auditDateKey(item.at, timeZone);
    return Boolean(day && (!from || day >= from) && (!to || day <= to));
  });
}
