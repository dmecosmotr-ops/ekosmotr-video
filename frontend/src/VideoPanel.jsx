import React, { useEffect, useRef, useState } from 'react';
import { Camera, Clock3, Film, Info, LoaderCircle, Play, Search, Video } from 'lucide-react';
import { api, query } from './api.js';
import { archiveDateLabel, clock, durationLabel, eventArchiveRange, eventRecordSelection, evidenceRecordingPath, observedClock, playbackBounds } from './playbackHelpers.js';
import LivePlayer from './LivePlayer.jsx';
import { archiveSearchAllowed, cameraAvailabilityLabel } from './detailPresentation.js';

function PlaybackEmpty({ title, message, icon: Icon = Video }) {
  return <div className="playback-empty"><Icon size={31} strokeWidth={1.3} /><strong>{title}</strong>{message && <p>{message}</p>}</div>;
}

function ArchivePlayer({ record }) {
  const ref = useRef(null);
  const bounds = useRef(null);
  const [error, setError] = useState('');
  const loaded = () => {
    const range = playbackBounds(record, ref.current.duration);
    if (!range) { setError('Найденный диапазон не совпадает с длительностью файла.'); return; }
    bounds.current = range;
    ref.current.currentTime = range.start;
  };
  const enforceRange = () => {
    const video = ref.current, range = bounds.current;
    if (!video || !range) return;
    if (video.currentTime < range.start - .02) video.currentTime = range.start;
    if (video.currentTime >= range.end) { video.pause(); if (video.currentTime > range.end + .02) video.currentTime = range.end; }
  };
  return <div className="archive-player">
    {error ? <div className="error-notice" role="alert">{error}</div> : <div className="video-wrap"><video ref={ref} src={record.mediaUrl} controls preload="metadata" aria-label="Найденная архивная запись" onLoadedMetadata={loaded} onTimeUpdate={enforceRange} onSeeked={enforceRange} onPlay={() => { const range = bounds.current; if (range && ref.current.currentTime >= range.end - .02) ref.current.currentTime = range.start; }} onError={() => setError('Не удалось открыть архивный файл. Проверьте доступность записи и повторите поиск.')} /><div className="video-caption">Архив · {observedClock(record.startAt, record.timing, true)}–{observedClock(record.endAt, record.timing, true)} · выбранный диапазон {durationLabel(record.endOffsetSeconds - record.startOffsetSeconds)}</div></div>}
  </div>;
}

export default function VideoPanel({ cameras, cameraId, onCameraChange, mode, onModeChange, date, eventRequest = null, showModeTabs = true, maxStreams = 1 }) {
  const [loadedPlayback, setLoadedPlayback] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ date, from: '08:00:00', to: '20:00:00' });
  const [result, setResult] = useState(null);
  const [recordId, setRecordId] = useState(null);
  const [searching, setSearching] = useState(false);
  const [eventMoment, setEventMoment] = useState(null);
  const requestVersion = useRef(0);
  const camera = cameras.find(item => item.id === cameraId);
  const playback = loadedPlayback?.cameraId === cameraId && loadedPlayback.date === date ? loadedPlayback.data : null;
  const canSearchArchive = archiveSearchAllowed(playback, cameraId, loading) && result?.status !== 'not_connected';

  useEffect(() => {
    let alive = true;
    requestVersion.current++;
    setLoadedPlayback(null); setError(''); setResult(null); setRecordId(null); setSearching(false); setEventMoment(null);
    setForm({ date, from: '08:00:00', to: '20:00:00' });
    if (!cameraId) { setLoading(false); return; }
    setLoading(true);
    api(`/cameras/${encodeURIComponent(cameraId)}/playback`).then(data => { if (alive) setLoadedPlayback({ cameraId, date, data }); })
      .catch(failure => { if (alive) setError(failure.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; requestVersion.current++; };
  }, [cameraId, date]);

  const searchArchive = async (values, evidenceEvent = null) => {
    if (!canSearchArchive) return;
    const current = ++requestVersion.current;
    setSearching(true); setError(''); setResult(null); setRecordId(null); setEventMoment(null);
    try {
      const data = await api(`/archive${query({ cameraId, ...values })}`);
      if (current !== requestVersion.current) return;
      const selection = eventRecordSelection(data.records || [], evidenceEvent);
      setResult({ ...data, ...(data.records ? { records: selection.records } : {}) }); setRecordId(selection.recordId);
    } catch (failure) { if (current === requestVersion.current) setError(failure.message); }
    finally { if (current === requestVersion.current) setSearching(false); }
  };

  const openEvidence = async event => {
    const path = evidenceRecordingPath(event, cameraId);
    if (!path) { setError('Для события не получена точная привязка к записи.'); return; }
    const current = ++requestVersion.current;
    setSearching(true); setError(''); setResult(null); setRecordId(null); setEventMoment(null);
    try {
      const { record: found } = await api(path);
      if (current !== requestVersion.current) return;
      if (found?.id !== event.evidence.recordingId || found.cameraId !== cameraId || !playbackBounds(found)
        || found.startOffsetSeconds !== event.evidence.offsetSeconds) throw new Error('Точный момент события сейчас недоступен.');
      setResult({ status: 'available', records: [found] }); setRecordId(found.id); setEventMoment(event);
    } catch (failure) { if (current === requestVersion.current) setError(failure.message); }
    finally { if (current === requestVersion.current) setSearching(false); }
  };

  useEffect(() => {
    if (mode !== 'archive' || !canSearchArchive || !eventRequest || eventRequest.cameraId !== cameraId) return;
    if (eventRequest.source === 'analysis' || eventRequest.evidence?.recordingId) { openEvidence(eventRequest); return; }
    const range = eventArchiveRange(eventRequest.time, eventRequest.date || date);
    if (!range) return;
    setForm(range);
    searchArchive(range, eventRequest);
  }, [cameraId, date, eventRequest?.key, mode, canSearchArchive]);

  const useSample = () => {
    const range = playback?.archive?.sampleRange;
    if (!range) return;
    const values = { date: range.date, from: range.from, to: range.to };
    setForm(values); searchArchive(values);
  };
  const editForm = (field, value) => {
    requestVersion.current++;
    setForm(previous => ({ ...previous, [field]: value }));
    setResult(null); setRecordId(null); setError(''); setSearching(false); setEventMoment(null);
  };
  const record = result?.records?.find(item => item.id === recordId) || null;
  const recordedDate = archiveDateLabel(playback, result?.records || []);
  const unverifiedClock = recordedDate && ((['camera_local_unverified', 'estimated'].includes(playback?.archive?.timeBasis) || playback?.archive?.timing === 'estimated' || record?.timing === 'estimated') || camera?.status === 'recorded_probe');

  return <section className="video-panel">
    <div className="video-panel-toolbar">{showModeTabs ? <div className="segmented" role="tablist" aria-label="Режим просмотра видео"><button type="button" role="tab" aria-selected={mode === 'online'} className={mode === 'online' ? 'selected' : ''} onClick={() => onModeChange('online')}><Video size={14} />Онлайн</button><button type="button" role="tab" aria-selected={mode === 'archive'} className={mode === 'archive' ? 'selected' : ''} onClick={() => onModeChange('archive')}><Film size={14} />Архив</button></div> : <span className="video-camera-label">{mode === 'online' ? 'Сейчас' : 'Архив записи'}</span>}<label className="plain-select video-camera-select"><Camera size={16} /><span className="sr-only">Камера для просмотра</span><select aria-label="Камера для просмотра" value={cameraId || ''} onChange={event => onCameraChange(event.target.value)} disabled={cameras.length < 2}>{!cameras.length && <option value="">Камеры не привязаны</option>}{cameras.map(item => <option key={item.id} value={item.id}>{item.name} · {cameraAvailabilityLabel(item)}</option>)}</select></label></div>
    {!camera ? <PlaybackEmpty title="Камеры ещё не привязаны к станции" message="После подтверждения привязки здесь можно будет выбрать камеру для просмотра." icon={Camera} /> : <>
      {loading && <div className="playback-loading" role="status"><LoaderCircle size={18} className="spin" />Проверяем доступные источники…</div>}
      {error && <div className="error-notice" role="alert">{error}</div>}
      {mode === 'online' ? !loading && (playback?.live?.status === 'available'
        ? <LivePlayer key={cameraId} cameraId={cameraId} cameraName={camera.name} maxStreams={maxStreams} message="Подключение камеры проверится после нажатия «Начать просмотр»." />
        : playback && <PlaybackEmpty title="Онлайн-видео пока не подключено" message="Для этой камеры просмотр ещё не настроен." />) : <>
        {eventMoment && <div className="archive-clock-note"><Info size={14} />Открыт момент события: {observedClock(eventMoment.time, eventMoment.timing, true)}. Поля ниже — для нового поиска.</div>}
        {canSearchArchive && <form className="archive-search" onSubmit={event => { event.preventDefault(); searchArchive(form); }}>
          <label>Дата<input type="date" aria-label="Дата архивной записи" required value={form.date} onChange={event => editForm('date', event.target.value)} /></label>
          <label>С<input type="time" aria-label="Начало интервала" step="1" required value={form.from} onChange={event => editForm('from', event.target.value)} /></label>
          <label>До<input type="time" aria-label="Конец интервала" step="1" required value={form.to} onChange={event => editForm('to', event.target.value)} /></label>
          <button className="button button-primary" disabled={searching || !canSearchArchive}><Search size={15} />{searching ? 'Ищем…' : 'Найти запись'}</button>
        </form>}
        {canSearchArchive && playback?.archive?.sampleRange && <div className="archive-sample"><span><Film size={14} />Доступна запись за {playback.archive.sampleRange.date.split('-').reverse().join('.')}</span><button className="text-button" onClick={useSample} disabled={searching}>Доступный фрагмент<Play size={13} /></button></div>}
        {unverifiedClock && <div className="archive-clock-note"><Info size={14} />Запись {recordedDate}; время приблизительное, точность часов камеры не подтверждена.</div>}
        {searching && <div className="playback-loading" role="status"><LoaderCircle size={18} className="spin" />Ищем запись в выбранном интервале…</div>}
        {!searching && result?.status === 'available' && <>
          <div className="archive-result-title"><strong>Найдено фрагментов: {result.records.length}</strong><span>Доступен только фактически сохранённый диапазон</span></div>
          {result.records.length > 1 && <div className="archive-record-list">{result.records.map(item => <button className={`button button-small ${recordId === item.id ? 'button-primary' : ''}`} key={item.id} onClick={() => setRecordId(item.id)}>{observedClock(item.startAt, item.timing, true)}–{observedClock(item.endAt, item.timing, true)}</button>)}</div>}
          {record && <ArchivePlayer key={`${record.id}:${record.startOffsetSeconds}:${record.endOffsetSeconds}`} record={record} />}
        </>}
        {!searching && result?.status === 'empty' && <PlaybackEmpty title="В этом интервале доступных записей нет" message={result.message || 'Измените дату или время. Это результат поиска в доступном архиве сервиса.'} icon={Film} />}
        {!loading && !searching && (result?.status === 'not_connected' || !result && playback?.archive?.status === 'not_connected') && <PlaybackEmpty title="Архив этой камеры ещё не подключён" message={result?.message || playback?.archive?.message || 'Наличие записей на самой камере пока не проверено. Здесь появится поиск после подключения архива.'} icon={Film} />}
        {!loading && !searching && !result && playback?.archive?.status === 'available' && <PlaybackEmpty title="Выберите дату и интервал" message="Нажмите «Найти запись» или откройте доступный фрагмент." icon={Clock3} />}
      </>}
    </>}
  </section>;
}
