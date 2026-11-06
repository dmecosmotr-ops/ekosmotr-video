import { ANALYSIS_LIMITS, opaqueId, openSafeFile, localParts, localIso, recordingMediaUrl } from './analysis.mjs';

export function mediaRange(header, size) {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (header === undefined) return { start: 0, end: size - 1, status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const left = match[1] ? Number(match[1]) : null, right = match[2] ? Number(match[2]) : null;
  if (left !== null && !Number.isSafeInteger(left) || right !== null && !Number.isSafeInteger(right)) return null;
  let start, end;
  if (left === null) { if (right <= 0) return null; start = Math.max(0, size - Math.min(right, ANALYSIS_LIMITS.rangeBytes)); end = size - 1; }
  else { start = left; end = Math.min(right ?? size - 1, size - 1, start + ANALYSIS_LIMITS.rangeBytes - 1); }
  if (start >= size || start > end) return null;
  return { start, end, status: 206 };
}
export function openAnalysisMedia(runs, cameraId, recordingId) {
  if (!opaqueId(cameraId) || !opaqueId(recordingId)) return null;
  const run = runs.find(run => run.cameraId === cameraId && run.recording.id === recordingId);
  return run ? openSafeFile(run.archiveRoot, run.recording.file, ANALYSIS_LIMITS.mediaBytes) : null;
}
function available(runs, cameraId) {
  return runs.filter(run => {
    if (run.cameraId !== cameraId) return false;
    const opened = openAnalysisMedia([run], cameraId, run.recording.id); if (!opened) return false;
    opened.close(); return true;
  });
}
const message = 'Доступны только зарегистрированные обработанные фрагменты. Это не полный архив камеры; время estimated рассчитано приблизительно.';
export function analysisPlayback(runs, cameraId) {
  const own = available(runs, cameraId), days = [...new Set(own.flatMap(run =>
    [localParts(run.startMs, run.timezone).date, localParts(run.endMs - 1, run.timezone).date]))].sort();
  const recent = own.sort((a, b) => b.startMs - a.startMs)[0];
  let sampleRange = null;
  if (recent) {
    const start = localParts(recent.startMs, recent.timezone);
    const endSecond = Math.ceil(recent.endMs / 1000) * 1000;
    const rounded = localParts(endSecond, recent.timezone);
    sampleRange = { date: start.date, from: start.time, to: start.date === rounded.date ? rounded.time : '23:59:59' };
    if (sampleRange.from >= sampleRange.to) sampleRange = null;
  }
  return { status: own.length ? 'available' : 'not_connected', days, sampleRange, timeBasis: 'station_local',
    coverage: 'partial', timing: own.some(run => run.recording.timing === 'estimated') ? 'estimated' : own.length ? 'verified' : null,
    message: own.length ? message : 'Зарегистрированные видеофрагменты пока недоступны. Отсутствие материала не означает отсутствие событий.' };
}
function localInstant(date, time, run) {
  const local = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  // Accepted clips have a constant timezone offset, so the actual clip establishes
  // which UTC occurrence a repeated wall-clock hour refers to.
  const offset = Date.parse(localIso(run.startMs, run.timezone) + 'Z') - run.startMs;
  return local - offset;
}
function archiveRecord(run, startOffsetSeconds, endOffsetSeconds) {
  const startMs = run.startMs + startOffsetSeconds * 1000, endMs = run.startMs + endOffsetSeconds * 1000;
  const round = value => Math.round(value * 1000) / 1000;
  return { id: run.recording.id, cameraId: run.cameraId, startAt: localIso(startMs, run.timezone), endAt: localIso(endMs, run.timezone),
    source: 'recorded_analysis', mediaUrl: recordingMediaUrl(run.cameraId, run.recording.id),
    startOffsetSeconds: round(startOffsetSeconds), endOffsetSeconds: round(endOffsetSeconds),
    durationSeconds: round(endOffsetSeconds - startOffsetSeconds), timing: run.recording.timing,
    coverage: 'partial', needsReview: true, timezone: run.timezone };
}
export function exactAnalysisRecording(runs, cameraId, recordingId, offsetSeconds) {
  if (!opaqueId(cameraId) || !opaqueId(recordingId) || !Number.isFinite(offsetSeconds) || offsetSeconds < 0) return null;
  const run = available(runs, cameraId).find(item => item.recording.id === recordingId);
  if (!run || offsetSeconds >= run.recording.durationSeconds) return null;
  const endOffsetSeconds = Math.min(run.recording.durationSeconds, offsetSeconds + 30);
  return { ...archiveRecord(run, offsetSeconds, endOffsetSeconds), startOffsetSeconds: offsetSeconds,
    endOffsetSeconds, durationSeconds: endOffsetSeconds - offsetSeconds };
}
export function searchAnalysisArchive(runs, cameraId, { date, from, to }) {
  const own = available(runs, cameraId), state = analysisPlayback(own, cameraId);
  const records = own.flatMap(run => {
    const startMs = Math.max(run.startMs, localInstant(date, from, run));
    const endMs = Math.min(run.endMs, localInstant(date, to, run));
    if (startMs >= endMs) return [];
    return [archiveRecord(run, (startMs - run.startMs) / 1000, (endMs - run.startMs) / 1000)];
  }).sort((a, b) => a.startAt.localeCompare(b.startAt));
  return { cameraId, date, from, to, status: !own.length ? 'not_connected' : records.length ? 'available' : 'empty',
    timeBasis: state.timeBasis, coverage: 'partial', timing: state.timing, records,
    message: records.length ? message : !own.length ? state.message : 'В выбранном интервале зарегистрированных фрагментов нет. Полнота архива не подтверждена.' };
}
