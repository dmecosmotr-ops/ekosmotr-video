import { closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { noneMetrics } from './demo.mjs';

// No filesystem location supplied over HTTP participates in this trust boundary.
export const ANALYSIS_LIMITS = Object.freeze({ files: 128, jsonBytes: 256 * 1024, events: 2000,
  duration: 900, mediaBytes: 256 * 1024 * 1024, rangeBytes: 8 * 1024 * 1024 });
export const opaqueId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit
  && !/[\x00-\x1f\x7f]/.test(value) && !/https?:\/\/|(?:token|password|secret)\s*[:=]/i.test(value);
const utc = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const formatters = new Map();
export function localParts(value, timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hourCycle: 'h23', year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timezone, formatter);
  }
  const p = Object.fromEntries(formatter.formatToParts(new Date(value)).map(item => [item.type, item.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
export function localIso(value, timezone) {
  const p = localParts(value, timezone), ms = new Date(value).getUTCMilliseconds();
  return `${p.date}T${p.time}${ms ? `.${String(ms).padStart(3, '0')}` : ''}`;
}

// Reject symlinks/junctions in every component beneath a configured root, including
// the root itself. Open descriptors are rechecked to avoid a file replacement race.
export function safeFile(root, file) {
  if (!isAbsolute(root) || typeof file !== 'string' || !file || file.includes('\\') || file.includes('\0')
    || file.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(file)) return null;
  const target = resolve(root, file), rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  try {
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) return null;
    let current = root;
    const parts = rel.split(sep);
    for (let index = 0; index < parts.length; index++) {
      current = resolve(current, parts[index]); const info = lstatSync(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return null;
    }
    return target;
  } catch { return null; }
}
export function openSafeFile(root, file, maxBytes) {
  const target = safeFile(root, file); if (!target) return null;
  let fd;
  try {
    const before = lstatSync(target);
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = fstatSync(fd), after = lstatSync(target);
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes || before.ino !== info.ino
      || after.ino !== info.ino || before.dev !== info.dev || before.size !== info.size
      || before.mtimeMs !== info.mtimeMs || !safeFile(root, file)) throw new Error();
    let closed = false;
    return { fd, size: info.size, info, close() { if (!closed) { closed = true; closeSync(fd); } } };
  } catch { if (fd !== undefined) closeSync(fd); return null; }
}
function readJSON(root, file) {
  const opened = openSafeFile(root, file, ANALYSIS_LIMITS.jsonBytes);
  if (!opened) return null;
  try {
    // readFileSync(fd) would allocate without a bound if a producer grew the file
    // between stat and read. Keep both the allocation and every read bounded.
    const bytes = Buffer.alloc(opened.size + 1); let size = 0, read;
    while (size < bytes.length && (read = readSync(opened.fd, bytes, size, bytes.length - size, null)) > 0) size += read;
    const after = fstatSync(opened.fd);
    if (size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.info.mtimeMs) return null;
    return JSON.parse(bytes.subarray(0, size).toString('utf8'));
  } catch { return null; } finally { opened.close(); }
}
export function loadAnalysisConfig(file, stations, existingCameras = []) {
  if (file === undefined) return Object.freeze({ cameras: Object.freeze([]) });
  const invalid = () => { throw new Error('Invalid analysis configuration (PILOT_ANALYSIS_CONFIG)'); };
  if (typeof file !== 'string' || !isAbsolute(file)) return invalid();
  let raw;
  try { const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.size > ANALYSIS_LIMITS.jsonBytes) return invalid();
    const path = resolve(file); raw = readJSON(resolve(path, '..'), relative(resolve(path, '..'), path)); } catch { return invalid(); }
  if (!keys(raw, ['resultsDir', 'archiveRoot', 'cameras']) || !Array.isArray(raw.cameras) || !raw.cameras.length
    || raw.cameras.length > 150 || ![raw.resultsDir, raw.archiveRoot].every(value => typeof value === 'string' && isAbsolute(value))) return invalid();
  try { for (const root of [raw.resultsDir, raw.archiveRoot]) { const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return invalid(); } } catch { return invalid(); }
  const resultRoot = resolve(raw.resultsDir), archiveRoot = resolve(raw.archiveRoot);
  if (resultRoot === archiveRoot || resultRoot.startsWith(archiveRoot + sep) || archiveRoot.startsWith(resultRoot + sep)) return invalid();
  const ids = new Set(), primary = new Set(), stationIds = new Set(stations.map(station => station.id));
  const cameras = raw.cameras.map(camera => {
    if (!keys(camera, ['cameraId', 'stationId', 'mappingVersion', 'timezone', 'name', 'model', 'primary'])
      || !opaqueId(camera.cameraId) || ids.has(camera.cameraId) || !stationIds.has(camera.stationId)
      || !opaqueId(camera.mappingVersion) || !text(camera.timezone, 80) || !text(camera.name, 160)
      || !text(camera.model, 100) || typeof camera.primary !== 'boolean'
      || existingCameras.some(c => c.id === camera.cameraId && ['demo', 'recorded_probe'].includes(c.status))) return invalid();
    try { localParts(0, camera.timezone); } catch { return invalid(); }
    if (camera.primary && primary.has(camera.stationId)) return invalid();
    ids.add(camera.cameraId); if (camera.primary) primary.add(camera.stationId);
    return Object.freeze({ ...camera });
  });
  return Object.freeze({ resultsDir: resultRoot, archiveRoot, cameras: Object.freeze(cameras) });
}
export function confirmedCameras(config) {
  return config.cameras.map(c => ({ id: c.cameraId, stationId: c.stationId, name: c.name, model: c.model,
    mappingVersion: c.mappingVersion, timezone: c.timezone, primary: c.primary, mappingStatus: 'confirmed',
    mappingReason: 'Явная подтверждённая привязка в настройках анализа', source: 'analysis_config',
    status: 'unconnected', view: 'unknown', metrics: noneMetrics() }));
}
function validateRun(raw, config) {
  if (!keys(raw, ['schemaVersion', 'runId', 'pipelineVersion', 'cameraId', 'stationId', 'mappingVersion', 'timezone',
    'generatedAt', 'recording', 'coverage', 'events']) || raw.schemaVersion !== 1 || !opaqueId(raw.runId)
    || !opaqueId(raw.pipelineVersion) || !utc(raw.generatedAt)) return null;
  const camera = config.cameras.find(c => c.cameraId === raw.cameraId);
  if (!camera || ['stationId', 'mappingVersion', 'timezone'].some(key => raw[key] !== camera[key])) return null;
  const r = raw.recording;
  if (!keys(r, ['id', 'file', 'sha256', 'startedAt', 'durationSeconds', 'timing']) || r.id !== raw.runId
    || r.file !== `${raw.runId}/video.mp4` || !/^[0-9a-f]{64}$/.test(r.sha256 || '') || !utc(r.startedAt)
    || !Number.isFinite(r.durationSeconds) || r.durationSeconds <= 0 || r.durationSeconds > ANALYSIS_LIMITS.duration
    || !['estimated', 'verified'].includes(r.timing) || Date.parse(raw.generatedAt) < Date.parse(r.startedAt)) return null;
  if (!keys(raw.coverage, ['status', 'sampleIntervalSeconds']) || raw.coverage.status !== 'partial'
    || !Number.isFinite(raw.coverage.sampleIntervalSeconds) || raw.coverage.sampleIntervalSeconds <= 0
    || raw.coverage.sampleIntervalSeconds > 60 || !Array.isArray(raw.events) || raw.events.length > ANALYSIS_LIMITS.events) return null;
  const startMs = Date.parse(r.startedAt), endMs = startMs + r.durationSeconds * 1000;
  // Offset changes during a clip are deliberately unavailable until DST ambiguity has a product rule.
  const localOffset = ms => Date.parse(localIso(ms, camera.timezone) + 'Z') - ms;
  if (localOffset(startMs) !== localOffset(endMs)) return null;
  const ids = new Set();
  for (const e of raw.events) {
    if (!keys(e, ['id', 'type', 'occurredAtUtc', 'confidence', 'visitId', 'needsReview', 'evidence'])
      || !opaqueId(e.id) || ids.has(e.id) || !['vehicle_entry', 'vehicle_exit', 'first_seen', 'opened', 'closed'].includes(e.type)
      || !utc(e.occurredAtUtc) || !Number.isFinite(e.confidence) || e.confidence < 0 || e.confidence > 1
      || !(e.visitId === null || opaqueId(e.visitId)) || e.needsReview !== true
      || !keys(e.evidence, ['recordingId', 'offsetSeconds']) || e.evidence.recordingId !== r.id
      || !Number.isFinite(e.evidence.offsetSeconds) || e.evidence.offsetSeconds < 0 || e.evidence.offsetSeconds >= r.durationSeconds
      || Math.abs(Date.parse(e.occurredAtUtc) - startMs - e.evidence.offsetSeconds * 1000) > 10) return null;
    ids.add(e.id);
  }
  const opened = openSafeFile(config.archiveRoot, r.file, ANALYSIS_LIMITS.mediaBytes);
  if (!opened) return null; opened.close();
  return { ...raw, startMs, endMs, archiveRoot: config.archiveRoot, primary: camera.primary };
}
export function readAnalysis(config) {
  if (!config.resultsDir) return [];
  const files = []; let dir;
  try {
    if (lstatSync(config.resultsDir).isSymbolicLink()) return [];
    dir = opendirSync(config.resultsDir); let entry, seen = 0;
    while ((entry = dir.readSync()) !== null) {
      // Bound all entries too, so an attacker cannot hide a huge enumeration behind ignored extensions.
      if (++seen > ANALYSIS_LIMITS.files * 4) return [];
      if (!entry.name.endsWith('.json')) continue;
      if (files.length >= ANALYSIS_LIMITS.files) return [];
      if (entry.isFile() && !entry.isSymbolicLink()) files.push(entry.name);
    }
  } catch { return []; } finally { dir?.closeSync(); }
  const valid = files.sort().map(file => validateRun(readJSON(config.resultsDir, file), config)).filter(Boolean);
  const groups = new Map();
  for (const run of valid) {
    const group = groups.get(run.runId) || []; group.push(run); groups.set(run.runId, group);
  }
  const unique = [...groups.values()].filter(group => group.every(run => JSON.stringify(run) === JSON.stringify(group[0]))).map(group => group[0]);
  const clips = new Map();
  const observationSignature = run => {
    const visits = new Map();
    return JSON.stringify([run.startMs, run.endMs, run.pipelineVersion, run.recording.timing, run.events.slice()
      .sort((a, b) => a.occurredAtUtc.localeCompare(b.occurredAtUtc) || a.type.localeCompare(b.type))
      .map(event => {
        if (event.visitId && !visits.has(event.visitId)) visits.set(event.visitId, visits.size + 1);
        return [event.type, event.occurredAtUtc, event.confidence, event.evidence.offsetSeconds,
          event.visitId ? visits.get(event.visitId) : null];
      })]);
  };
  for (const run of unique.sort((a, b) => a.runId.localeCompare(b.runId))) {
    const key = JSON.stringify([run.cameraId, run.recording.sha256]);
    const group = clips.get(key) || []; group.push(run); clips.set(key, group);
  }
  // Identical footage can be processed twice, but contradictory timestamps or
  // detections are unknown rather than whichever result sorted first.
  const runs = [...clips.values()].filter(group => group.every(run => observationSignature(run) === observationSignature(group[0])))
    .map(group => group[0]), conflicts = new Set(), eventOwners = new Map();
  for (const run of runs) for (const event of run.events) {
    const previous = eventOwners.get(event.id);
    if (previous) { conflicts.add(run); conflicts.add(previous); }
    else eventOwners.set(event.id, run);
  }
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    if (a.cameraId === b.cameraId && a.startMs < b.endMs && b.startMs < a.endMs) { conflicts.add(a); conflicts.add(b); }
  }
  return runs.filter(run => !conflicts.has(run));
}
const labels = { first_seen: 'Первое появление человека во фрагменте', vehicle_entry: 'Предварительный въезд автомобиля',
  vehicle_exit: 'Предварительный выезд автомобиля', opened: 'Предполагаемое открытие ворот', closed: 'Предполагаемое закрытие ворот' };
export const recordingMediaUrl = (cameraId, recordingId) => `/api/cameras/${encodeURIComponent(cameraId)}/recordings/${encodeURIComponent(recordingId)}/media`;
export function analysisEvents(runs, date) {
  return runs.flatMap(run => run.events.map(e => ({ ...e, ...localParts(e.occurredAtUtc, run.timezone),
    stationId: run.stationId, cameraId: run.cameraId, source: 'analysis', needsReview: true,
    runId: run.runId, pipelineVersion: run.pipelineVersion, timing: run.recording.timing, coverage: 'partial',
    visitId: e.visitId ? `${run.runId}:${e.visitId}` : null, label: labels[e.type],
    description: 'Предварительное наблюдение в обработанном фрагменте. Требуется проверка; результат не является итогом дня.',
    evidence: { ...e.evidence, mediaUrl: recordingMediaUrl(run.cameraId, run.recording.id) } })))
    .filter(e => e.date === date).sort((a, b) => a.occurredAtUtc.localeCompare(b.occurredAtUtc));
}
export function runHasDay(run, date) {
  return localParts(run.startMs, run.timezone).date === date || localParts(run.endMs - 1, run.timezone).date === date;
}
export function analysisMetrics(runs, cameraId, date) {
  const own = runs.filter(run => run.cameraId === cameraId && runHasDay(run, date));
  if (!own.length) return noneMetrics();
  const events = analysisEvents(own, date), count = type => events.filter(e => e.type === type).length || null;
  const pairs = new Map();
  for (const e of events.filter(e => e.visitId && ['vehicle_entry', 'vehicle_exit'].includes(e.type))) {
    const group = pairs.get(e.visitId) || []; group.push(e); pairs.set(e.visitId, group);
  }
  const complete = [...pairs.values()].filter(group => group.length === 2 && group[0].type === 'vehicle_entry'
    && group[1].type === 'vehicle_exit' && group[1].occurredAtUtc > group[0].occurredAtUtc).length;
  return { source: 'analysis', openedAt: null, closedAt: null,
    firstSeenAt: events.find(e => e.type === 'first_seen')?.time || null,
    entries: count('vehicle_entry'), exits: count('vehicle_exit'), completedVisits: complete || null,
    coverage: 'partial', timing: own.some(run => run.recording.timing === 'estimated') ? 'estimated' : 'verified',
    needsReview: true, note: 'Предварительные наблюдения только в обработанных фрагментах. Отсутствие событий не означает ноль за день. Часы открытия и закрытия станции не подтверждены.' };
}
