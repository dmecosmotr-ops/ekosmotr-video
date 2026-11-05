export function secondsOf(value) {
  const match = String(value || '').match(/(?:^|T)(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/);
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]), seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds + Number(match[4] || 0);
}

export function clock(value, precise = false) {
  if (!value) return '—';
  const match = String(value).match(/(?:^|T)(\d{2}:\d{2})(?::(\d{2})(\.\d{1,3})?)?$/);
  if (!match) return '—';
  return precise ? `${match[1]}:${match[2] || '00'}${match[3] || ''}` : match[1];
}

export function durationLabel(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} с`;
  const minutes = Math.floor(whole / 60), tail = whole % 60;
  return `${minutes} мин${tail ? ` ${tail} с` : ''}`;
}

export function buildVisits(events, day = '') {
  const vehicles = events.filter(event => ['vehicle_entry', 'vehicle_exit'].includes(event.type));
  const groups = new Map();
  vehicles.forEach((event, index) => {
    const eventDay = event.date || String(event.time).match(/^(\d{4}-\d{2}-\d{2})T/)?.[1] || day;
    // Events without a visit ID are separate observations, never nearest-time pairs.
    const key = event.visitId && event.cameraId ? `${eventDay}\0${event.cameraId}\0${event.visitId}` : `unpaired:${event.id || index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  });
  const rows = [];
  for (const [key, group] of groups) {
    const entries = group.filter(event => event.type === 'vehicle_entry');
    const exits = group.filter(event => event.type === 'vehicle_exit');
    const entered = entries[0] && secondsOf(entries[0].time), exited = exits[0] && secondsOf(exits[0].time);
    if (entries.length === 1 && exits.length === 1 && entered !== null && exited !== null && exited > entered) {
      rows.push({ id: key, cameraId: group[0].cameraId, stationId: group[0].stationId, enteredAt: entries[0].time, exitedAt: exits[0].time,
        durationSeconds: exited - entered, status: 'paired', events: group, needsReview: group.some(event => event.needsReview) });
    } else {
      group.forEach((event, index) => rows.push({ id: `${key}:${event.id || index}`, cameraId: event.cameraId, stationId: event.stationId,
        enteredAt: event.type === 'vehicle_entry' ? event.time : null, exitedAt: event.type === 'vehicle_exit' ? event.time : null,
        durationSeconds: null, status: event.type === 'vehicle_entry' ? 'entry_only' : 'exit_only', events: [event],
        needsReview: true }));
    }
  }
  return rows.sort((a, b) => (secondsOf(a.enteredAt || a.exitedAt) ?? Infinity) - (secondsOf(b.enteredAt || b.exitedAt) ?? Infinity));
}

const clockAt = seconds => {
  const value = Math.max(0, Math.min(86399, Math.floor(seconds)));
  return `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor(value % 3600 / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
};

export function eventArchiveRange(eventTime, day) {
  const seconds = secondsOf(eventTime);
  if (seconds === null) return null;
  return { date: String(eventTime).match(/^(\d{4}-\d{2}-\d{2})T/)?.[1] || day,
    from: clockAt(Math.min(seconds, 86398)), to: clockAt(Math.min(86399, seconds + 30)) };
}

export function playbackBounds(record, mediaDuration = Infinity) {
  const start = Number(record?.startOffsetSeconds), end = Number(record?.endOffsetSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  const limit = Number.isFinite(mediaDuration) ? Math.max(0, mediaDuration) : Infinity;
  const clamped = { start: Math.min(start, limit), end: Math.min(end, limit) };
  return clamped.end > clamped.start ? clamped : null;
}

export function archiveDateLabel(playback, records = []) {
  const date = playback?.archive?.sampleRange?.date || records[0]?.startAt?.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date.split('-').reverse().join('.') : null;
}
