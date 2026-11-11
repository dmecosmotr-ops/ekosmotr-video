import React, { useEffect, useRef } from 'react';
import {
  ArrowDownLeft, ArrowUpRight, Camera, CheckCircle2, ChevronRight,
  Clock3, DoorClosed, DoorOpen, Eye, Info, LoaderCircle, ShieldCheck,
  TriangleAlert, UserRound, X,
} from 'lucide-react';
import VideoPanel from './VideoPanel.jsx';
import EventGroups from './EventGroups.jsx';
import { clock, observedClock } from './playbackHelpers.js';
import { cameraInitialView, cameraViewLabel, selectDetailCamera, stationAddress, stationTitle } from './detailPresentation.js';
import './details.css';

export const roleNames = { admin: 'Администратор', director: 'Директор', regional: 'Региональный руководитель' };
export const number = value => value === null || value === undefined ? '—' : new Intl.NumberFormat('ru-RU').format(value);
export const time = (value, metadata) => observedClock(value, typeof metadata === 'string' ? metadata : metadata?.timing);
export const initials = value => (value || '').split(/\s+/).filter(Boolean).slice(0, 2).map(v => v[0]).join('').toUpperCase();
export const address = stationAddress;
export const matches = (values, term) => !term || values.join(' ').toLocaleLowerCase('ru').includes(term.trim().toLocaleLowerCase('ru'));
export const readableDate = value => {
  if (!value) return '';
  const parts = value.split('-').map(Number);
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(parts[0], parts[1] - 1, parts[2]));
};

export function Spinner({ label = 'Загрузка…' }) {
  return <div className="loading" role="status"><LoaderCircle className="spin" size={20} /><span>{label}</span></div>;
}

export function Empty({ title = 'Пока нет данных', description, icon: Icon = Camera, action }) {
  return <div className="empty-state"><div className="empty-symbol"><Icon size={26} strokeWidth={1.5} /></div><h3>{title}</h3>{description && <p>{description}</p>}{action}</div>;
}

export function ErrorNotice({ message, retry }) {
  if (!message) return null;
  return <div className="error-notice" role="alert"><TriangleAlert size={18} /><span>{message}</span>{retry && <button className="text-button" onClick={retry}>Повторить</button>}</div>;
}

export function Badge({ kind = 'neutral', children, dot = false }) {
  return <span className={`badge badge-${kind}`}>{dot && <span className="badge-dot" />}{children}</span>;
}

export function CameraStatus({ camera }) {
  if (camera.liveAvailable) return <Badge kind="teal">Просмотр настроен</Badge>;
  if (camera.archiveAvailable) return <Badge kind="teal"><CheckCircle2 size={12} />{camera.status === 'recorded_probe' ? 'Пробная запись' : 'Есть запись'}</Badge>;
  if (camera.status === 'demo') return <Badge kind="amber">Пример данных</Badge>;
  return <Badge>Видео не подключено</Badge>;
}

export function SourceLabel({ metrics }) {
  if (metrics?.source === 'demo') return <Badge kind="amber">Пример данных</Badge>;
  if (metrics?.source === 'analysis') return <Badge kind="amber">Обработан фрагмент</Badge>;
  return metrics?.source && metrics.source !== 'none' ? <Badge kind="teal">Результаты анализа</Badge> : <span className="muted">Видео ещё не анализировалось</span>;
}

export function Metric({ label, value, caption, icon: Icon, accent = false }) {
  return <div className={`metric ${accent ? 'metric-accent' : ''}`}><div className="metric-head"><span>{label}</span>{Icon && <Icon size={18} strokeWidth={1.6} />}</div><div className="metric-value">{value}</div>{caption && <div className="metric-caption">{caption}</div>}</div>;
}

export function EventIcon({ type }) {
  const Icon = ({ opened: DoorOpen, closed: DoorClosed, first_seen: UserRound, vehicle_entry: ArrowDownLeft, vehicle_exit: ArrowUpRight, gap: TriangleAlert })[type] || Clock3;
  return <Icon size={17} strokeWidth={1.7} />;
}

export function Timeline({ events, compact = false }) {
  if (!events.length) return <Empty title="Событий за этот день нет" description="Здесь появятся отметки анализа с привязкой ко времени." icon={Clock3} />;
  return <div className={`timeline ${compact ? 'timeline-compact' : ''}`}>{events.map(event => <div className="timeline-event" key={event.id}>
    <span className="timeline-time">{time(event.time, event)}</span><span className={`timeline-icon ${event.needsReview ? 'is-review' : ''}`}><EventIcon type={event.type} /></span>
    <div className="timeline-content"><div className="timeline-title">{event.label}{event.needsReview && <Badge kind="amber">Проверить</Badge>}</div><p>{event.description}</p></div>
  </div>)}</div>;
}

export function Modal({ title, subtitle, onClose, children, wide = false, className = '' }) {
  const ref = useRef(null);
  const focusEdge = last => {
    const controls = [...(ref.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], textarea:not([disabled]), video[controls], summary, [tabindex]:not([tabindex="-1"])') || [])]
      .filter(element => !element.hasAttribute('data-focus-guard') && element.getClientRects().length && !element.closest('[inert]') && element.getAttribute('aria-hidden') !== 'true');
    (last ? controls.at(-1) : controls[0])?.focus();
  };
  useEffect(() => {
    const previous = document.activeElement;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const close = event => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', close);
    ref.current?.querySelector('button')?.focus();
    return () => { document.body.style.overflow = bodyOverflow; document.removeEventListener('keydown', close); previous?.focus?.(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className={`modal ${wide ? 'modal-wide' : ''} ${className}`} ref={ref} role="dialog" aria-modal="true" aria-label={title}>
    <span className="sr-only" tabIndex={0} data-focus-guard="true" onFocus={() => focusEdge(true)} />
    <header className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={20} /></button></header>{children}
    <span className="sr-only" tabIndex={0} data-focus-guard="true" onFocus={() => focusEdge(false)} />
  </section></div>;
}

function DetailTabs({ section, mode, onEvents, onVideo }) {
  return <div className="detail-navigation" role="tablist" aria-label="Раздел карточки"><button type="button" role="tab" aria-selected={section === 'events'} className={section === 'events' ? 'selected' : ''} onClick={onEvents}><Clock3 size={15} />Сводка дня</button><button type="button" role="tab" aria-selected={section === 'video' && mode === 'online'} className={section === 'video' && mode === 'online' ? 'selected' : ''} onClick={() => onVideo('online')}><Eye size={15} />Онлайн</button><button type="button" role="tab" aria-selected={section === 'video' && mode === 'archive'} className={section === 'video' && mode === 'archive' ? 'selected' : ''} onClick={() => onVideo('archive')}><Camera size={15} />Архив</button></div>;
}

function DetailMetrics({ metrics }) {
  if (!metrics?.source || metrics.source === 'none') return null;
  return <div className="metrics-grid detail-metrics detail-metrics-five"><Metric label="Первое появление" value={time(metrics.firstSeenAt, metrics)} icon={UserRound} /><Metric label="Открытие" value={time(metrics.openedAt, metrics)} icon={DoorOpen} /><Metric label="Закрытие" value={time(metrics.closedAt, metrics)} icon={DoorClosed} /><Metric label="Въезды в бокс" value={number(metrics.entries)} icon={ArrowDownLeft} /><Metric label="Выезды из бокса" value={number(metrics.exits)} icon={ArrowUpRight} /></div>;
}

export function StationDetail({ station, cameras, events, date, initialMode, onClose, maxStreams = 1 }) {
  const related = cameras.filter(camera => camera.stationId === station.id);
  const stationEvents = events.filter(event => event.stationId === station.id);
  const metrics = station.metrics || {};
  const [section, setSection] = React.useState(initialMode ? 'video' : 'events');
  const [mode, setMode] = React.useState(initialMode || 'online');
  const [selection, setSelection] = React.useState({ id: '', explicit: false });
  const [eventRequest, setEventRequest] = React.useState(null);
  const cameraId = selectDetailCamera(related, { mode, currentId: selection.id, preserveSelection: selection.explicit });
  const chooseCamera = id => { setSelection({ id, explicit: true }); setEventRequest(null); };
  const video = (nextMode, id) => { setSection('video'); setMode(nextMode); if (id) setSelection({ id, explicit: true }); setEventRequest(null); };
  const record = event => { setSelection({ id: event.cameraId, explicit: true }); setMode('archive'); setSection('video'); setEventRequest({ ...event, date, key: `${event.id}-${Date.now()}` }); };
  return <Modal title={stationTitle(station)} subtitle="Пункт технического осмотра" onClose={onClose} wide className="detail-modal">
    <div className="station-detail-body">
      <DetailTabs section={section} mode={mode} onEvents={() => setSection('events')} onVideo={next => video(next)} />
      {section === 'video' ? <VideoPanel cameras={related} cameraId={cameraId} onCameraChange={chooseCamera} mode={mode} onModeChange={next => video(next)} date={date} eventRequest={eventRequest} showModeTabs={false} maxStreams={maxStreams} /> : <div className="detail-summary">
      <div className="detail-meta"><span>{station.region}</span><span>Региональный руководитель: {station.manager || 'Не указан'}</span><SourceLabel metrics={metrics} /></div>
      <div className="detail-date">{readableDate(date)}</div>
      <DetailMetrics metrics={metrics} />
      {metrics.source === 'analysis' && <p className="events-analysis-state is-partial">{metrics.note || 'Обработан фрагмент, итог дня неизвестен.'}{metrics.timing === 'estimated' && ' ≈ — приблизительное время; часы камеры не подтверждены.'}</p>}
      {metrics.source && metrics.source !== 'none' && <div className="context-note"><Info size={16} /><span>Первое появление человека не подтверждает личность эксперта или начало работы.</span></div>}
      <EventGroups stationScope events={stationEvents} cameras={related} analysisSource={metrics} date={date} onRecord={record} />
      <section className="detail-section"><div className="section-heading"><h3>Камеры станции</h3><span className="count-label">{related.length}</span></div>
        {!related.length ? <Empty title="Камеры ещё не привязаны" description="Наличие камеры и её привязку к станции нужно подтвердить." /> : related.map(camera => <div className="camera-row" key={camera.id}><div className="camera-row-icon"><Camera size={20} /></div><div><strong>{camera.name}</strong><span>{cameraViewLabel(camera)}{camera.model && ` · ${camera.model}`}</span>{camera.mappingStatus && camera.mappingStatus !== 'confirmed' && <span>Привязка по названию требует проверки</span>}</div><div className="camera-row-actions"><CameraStatus camera={camera} /><button className="text-button" disabled={!camera.liveAvailable} onClick={() => video('online', camera.id)}>Онлайн</button><button className="text-button" disabled={!camera.archiveAvailable} title={camera.archiveAvailable ? 'Открыть архив' : 'Архив не подключён'} onClick={() => video('archive', camera.id)}>Архив</button></div></div>)}
      </section>
      </div>}
    </div>
  </Modal>;
}

export function CameraDetail({ camera, station, events, date = '2026-10-30', initialMode, initialEventRequest = null, onClose, maxStreams = 1 }) {
  const metrics = camera.metrics || {};
  const initial = cameraInitialView(camera, initialMode);
  const [section, setSection] = React.useState(initial.section);
  const [mode, setMode] = React.useState(initial.mode);
  const [eventRequest, setEventRequest] = React.useState(initialEventRequest);
  const video = nextMode => { setSection('video'); setMode(nextMode); setEventRequest(null); };
  const record = event => { setSection('video'); setMode('archive'); setEventRequest({ ...event, date, key: `${event.id}-${Date.now()}` }); };
  const cameraEvents = events.filter(event => event.cameraId === camera.id);
  const subtitle = [camera.name, cameraViewLabel(camera)].filter((item, index, values) => item && values.indexOf(item) === index).join(' · ');
  return <Modal title={stationTitle(station)} subtitle={subtitle} onClose={onClose} wide className="detail-modal">
    <div className="station-detail-body">
      <DetailTabs section={section} mode={mode} onEvents={() => setSection('events')} onVideo={video} />
      {section === 'video' ? <VideoPanel cameras={[camera]} cameraId={camera.id} onCameraChange={() => {}} mode={mode} onModeChange={video} date={date} eventRequest={eventRequest} showModeTabs={false} maxStreams={maxStreams} /> : <div className="detail-summary">
        <div className="detail-meta"><span>{camera.model}</span><CameraStatus camera={camera} /><SourceLabel metrics={metrics} /></div>
        <div className="detail-date">{readableDate(date)}</div>
        {camera.view === 'gate_line' && <DetailMetrics metrics={metrics} />}
        {metrics.source === 'analysis' && <p className="events-analysis-state is-partial">{metrics.note || 'Обработан фрагмент, итог дня неизвестен.'}{metrics.timing === 'estimated' && ' ≈ — приблизительное время; часы камеры не подтверждены.'}</p>}
        {camera.view === 'client_area' ? <div className="context-note camera-view-note"><Info size={16} /><span>Клиентская зона: въезды и открытие ворот по этому ракурсу не считаются.</span></div> : metrics.source && metrics.source !== 'none' && <div className="context-note camera-view-note"><Info size={16} /><span>Первое появление человека не подтверждает личность эксперта или начало работы.</span></div>}
        <EventGroups events={cameraEvents} cameras={[camera]} analysisSource={metrics} date={date} onRecord={record} />
      </div>}
    </div>
  </Modal>;
}
