import { statSync } from 'node:fs';

// This registration describes the single existing local probe, never a live stream or a full camera archive.
const PROBE = Object.freeze({ date: '2026-10-30', from: '12:21:28', to: '12:21:39',
  startAt: '2026-10-30T12:21:28', endAt: '2026-10-30T12:21:38.350',
  startSeconds: 12 * 3600 + 21 * 60 + 28, durationSeconds: 10.35 });

export function hasProbeMedia(mediaFile) {
  try { const info = mediaFile && statSync(mediaFile); return Boolean(info?.isFile() && info.size > 0); }
  catch { return false; }
}

export function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date;
}

export function timeSeconds(time) {
  if (typeof time !== 'string') return null;
  const parts = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!parts || Number(parts[1]) > 23 || Number(parts[2]) > 59 || Number(parts[3] || 0) > 59) return null;
  return Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3] || 0);
}

export function playbackState(camera, available, liveAvailable = false) {
  const registered = camera.id === 'probe-c300' && available;
  return { cameraId: camera.id,
    live: { status: liveAvailable ? 'available' : 'not_connected',
      url: liveAvailable ? `/api/cameras/${encodeURIComponent(camera.id)}/live` : null,
      message: liveAvailable ? 'Можно начать пробный онлайн-просмотр. В пилоте доступен один сеанс до 10 минут; подключение камеры проверяется при запуске.' : 'Прямой эфир пока не подключён.' },
    archive: { status: registered ? 'available' : 'not_connected',
      days: registered ? [PROBE.date] : [],
      sampleRange: registered ? { date: PROBE.date, from: PROBE.from, to: PROBE.to } : null,
      timeBasis: camera.status === 'demo' ? 'station_local' : 'camera_local_unverified',
      message: registered ? 'Доступен только пробный клип C300: 30.10.2026, 10,35 секунды. Время с камеры, часовой пояс не подтверждён.'
        : 'Архив этой камеры к сервису пока не подключён. Наличие записей на самой камере не проверялось.' } };
}

const localIso = seconds => {
  const milliseconds = Math.round(seconds * 1000), whole = Math.floor(milliseconds / 1000);
  const time = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
  const fraction = milliseconds % 1000;
  return `${PROBE.date}T${time}${fraction ? `.${String(fraction).padStart(3, '0')}` : ''}`;
};

export function archiveSearch(camera, { date, from, to }, available) {
  const state = playbackState(camera, available).archive;
  const result = { cameraId: camera.id, date, from, to, status: 'not_connected', timeBasis: state.timeBasis,
    records: [], message: state.message };
  if (state.status !== 'available') return result;
  result.status = 'empty';
  result.message = 'В выбранном интервале нет доступного в этом пилоте клипа. Полный архив камеры не подключён.';
  if (date !== PROBE.date) return result;
  const startOffsetSeconds = Math.max(0, timeSeconds(from) - PROBE.startSeconds);
  const endOffsetSeconds = Math.min(PROBE.durationSeconds, timeSeconds(to) - PROBE.startSeconds);
  if (startOffsetSeconds >= endOffsetSeconds) return result;
  result.status = 'available';
  result.message = state.message;
  result.records = [{ id: 'probe-c300-20261030-122128', cameraId: camera.id,
    startAt: startOffsetSeconds === 0 ? PROBE.startAt : localIso(PROBE.startSeconds + startOffsetSeconds),
    endAt: endOffsetSeconds === PROBE.durationSeconds ? PROBE.endAt : localIso(PROBE.startSeconds + endOffsetSeconds),
    source: 'recorded_probe', mediaUrl: '/api/cameras/probe-c300/media',
    startOffsetSeconds, endOffsetSeconds,
    durationSeconds: Math.round((endOffsetSeconds - startOffsetSeconds) * 1000) / 1000 }];
  return result;
}
