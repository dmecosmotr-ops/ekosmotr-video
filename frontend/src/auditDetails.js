const roles = { admin: 'администратор', director: 'директор', regional: 'региональный руководитель' };
const liveReasons = {
  stopped: 'Просмотр остановлен', startup_timeout: 'Не дождались видео от камеры',
  ticket_expired: 'Подключение не началось вовремя', duration_limit: 'Завершён лимит времени просмотра',
  access_revoked: 'Доступ к камере отозван', stalled: 'Камера перестала передавать видео',
  disconnected: 'Окно просмотра закрыто или соединение прервалось', bridge_error: 'Ошибка подключения к источнику видео',
  bridge_closed: 'Источник завершил передачу', logout: 'Пользователь вышел из сервиса', server_closed: 'Сервис остановлен',
};
const text = value => String(value).replace(/\s+/g, ' ').trim().slice(0, 220);
const count = value => Array.isArray(value) ? value.length : value;

export function formatAuditDetails(raw) {
  let details = raw;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { return text(details); }
  }
  if (details === null || details === undefined) return '';
  if (typeof details !== 'object') return text(details);
  if (Array.isArray(details)) return details.map(value => typeof value === 'object' ? 'Дополнительные сведения' : text(value)).join(' · ');
  return Object.entries(details).flatMap(([key, value]) => {
    if (value === null || value === undefined || /password|token|secret|cookie|authorization/i.test(key)) return [];
    if (key === 'role') return [`Роль: ${roles[value] || text(value)}`];
    if (key === 'active') return [value ? 'Учётная запись активна' : 'Учётная запись отключена'];
    if (key === 'stations' || key === 'stationIds') return [`Станций целиком: ${text(count(value))}`];
    if (key === 'cameras' || key === 'cameraIds') return [`Отдельных камер: ${text(count(value))}`];
    if (key === 'reason' && typeof value === 'string') return [`Причина: ${liveReasons[value] || text(value)}`];
    const label = ({ name: 'Имя', email: 'Почта', reason: 'Причина', message: 'Описание' })[key] || text(key);
    const rendered = typeof value === 'object' ? Array.isArray(value) ? `${value.length} записей` : 'дополнительные сведения' : typeof value === 'boolean' ? value ? 'да' : 'нет' : text(value);
    return [`${label}: ${rendered}`];
  }).join(' · ');
}
