import React, { useMemo, useState } from 'react';
import { ArrowDownLeft, ChevronLeft, ChevronRight, DoorClosed, TriangleAlert, UserRound } from 'lucide-react';
import { buildVisits, clock, durationLabel } from './playbackHelpers.js';
import { describeAnalysis, eventsForMetric, reviewEvents, reviewReason, vehicleCounts } from './eventsPresentation.js';
import RecordingAction from './RecordingAction.jsx';
import './events.css';

export function EventsPagination({ page, pages, total, pageSize, onPage, noun = 'наблюдений' }) {
  if (pages <= 1) return null;
  return <div className="events-pagination"><span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} из {total} {noun}</span><div><button type="button" className="icon-button" aria-label="Предыдущая страница" disabled={!page} onClick={() => onPage(page - 1)}><ChevronLeft size={16} /></button><span>{page + 1} / {pages}</span><button type="button" className="icon-button" aria-label="Следующая страница" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}><ChevronRight size={16} /></button></div></div>;
}

export function EventMomentList({ events, cameras = [], onRecord, emptyLabel = 'Отметки за обработанный период не найдены', review = false }) {
  const cameraById = new Map(cameras.map(camera => [camera.id, camera]));
  if (!events.length) return <p className="events-empty-note">{emptyLabel}</p>;
  return <div className="event-moments">{events.map((event, index) => <article className="event-moment" key={event.id || index}><time>{clock(event.time, true)}</time><div className="event-moment-body"><strong>{event.label || 'Наблюдение'}</strong><p>{review ? reviewReason(event) : event.description}</p>{cameras.length > 1 && <span className="event-camera-name">{cameraById.get(event.cameraId)?.name || 'Камера не определена'}</span>}{(event.needsReview || review) && <span className="badge badge-amber">Требует проверки</span>}</div><RecordingAction event={event} camera={cameraById.get(event.cameraId)} onRecord={onRecord} /></article>)}</div>;
}

export function VehicleVisits({ events, date, cameras = [], onRecord, analysisSource }) {
  const [page, setPage] = useState(0);
  const visits = useMemo(() => buildVisits(events, date), [events, date]);
  const analysis = describeAnalysis(events, analysisSource);
  const counts = vehicleCounts(events, analysis, date);
  const cameraById = new Map(cameras.map(camera => [camera.id, camera]));
  const pageSize = 8, pages = Math.max(1, Math.ceil(visits.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = visits.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  return <div className="vehicle-visits"><div className="events-vehicle-summary"><span>Наблюдаемые въезды <strong>{counts.entries ?? '—'}</strong></span><span>Наблюдаемые выезды <strong>{counts.exits ?? '—'}</strong></span><span>Связанные заезды <strong>{counts.completed ?? '—'}</strong></span></div>
    {!visits.length ? <p className="events-empty-note">{analysis.kind === 'none' ? analysis.label : analysis.countable ? 'За обработанный период въезды и выезды не найдены' : 'Отметки въездов и выездов не получены. Полнота анализа не подтверждена.'}</p> : <div className="event-visit-list">{visible.map((visit, index) => {
      const entry = visit.events.find(event => event.type === 'vehicle_entry');
      const exit = visit.events.find(event => event.type === 'vehicle_exit');
      return <article className="event-visit" key={visit.id}><div className="event-visit-heading"><strong>Заезд № {currentPage * pageSize + index + 1}</strong><span>{visit.status === 'paired' ? `Время в боксе: ${durationLabel(visit.durationSeconds)}` : visit.status === 'entry_only' ? 'Выезд не сопоставлен' : 'Въезд не сопоставлен'}</span>{visit.needsReview && <span className="badge badge-amber">Требует проверки</span>}</div><div className="event-visit-points"><div><span className="event-point-label">Въезд</span><time>{clock(visit.enteredAt, true)}</time>{entry ? <RecordingAction event={entry} camera={cameraById.get(entry.cameraId)} onRecord={onRecord} /> : <span className="recording-unavailable">Нет связанного наблюдения</span>}</div><div><span className="event-point-label">Выезд</span><time>{clock(visit.exitedAt, true)}</time>{exit ? <RecordingAction event={exit} camera={cameraById.get(exit.cameraId)} onRecord={onRecord} /> : <span className="recording-unavailable">Нет связанного наблюдения</span>}</div></div>{cameras.length > 1 && <span className="event-camera-name">{cameraById.get(visit.cameraId)?.name || 'Камера не определена'}</span>}</article>;
    })}</div>}
    <EventsPagination page={currentPage} pages={pages} total={visits.length} pageSize={pageSize} onPage={setPage} noun="заездов" />
    <p className="events-evidence-note">Пары связаны по идентификатору заезда в одной камере и за один день. Связанный заезд не подтверждает уникального клиента. Несопоставленные времена не восстанавливаются.</p>
  </div>;
}

function DetailEventSection({ title, icon: Icon, children }) {
  return <section className="events-detail-section"><h3><Icon size={17} aria-hidden="true" />{title}</h3>{children}</section>;
}

export default function EventGroups({ events = [], date, onRecord, cameras = [], analysisSource }) {
  const analysis = describeAnalysis(events, analysisSource);
  const review = reviewEvents(events, date);
  const missing = analysis.kind === 'none' ? analysis.label : analysis.countable ? 'За обработанный период отметки не найдены' : 'Отметки не получены. Полнота анализа не подтверждена.';
  return <div className="event-groups events-detail-groups"><p className={`events-analysis-state is-${analysis.kind}`}>{analysis.label}</p>
    <DetailEventSection title="Первое появление и открытие" icon={UserRound}><EventMomentList events={eventsForMetric(events, 'start', date)} cameras={cameras} onRecord={onRecord} emptyLabel={missing} /><p className="events-evidence-note">Первое появление человека в кадре не подтверждает его личность или начало работы.</p></DetailEventSection>
    <DetailEventSection title="Автомобили" icon={ArrowDownLeft}><VehicleVisits key={date} events={events} date={date} cameras={cameras} onRecord={onRecord} analysisSource={analysisSource} /></DetailEventSection>
    <DetailEventSection title="Закрытие" icon={DoorClosed}><EventMomentList events={eventsForMetric(events, 'closed', date)} cameras={cameras} onRecord={onRecord} emptyLabel={missing} /></DetailEventSection>
    <DetailEventSection title="Требует проверки" icon={TriangleAlert}><EventMomentList events={review} cameras={cameras} onRecord={onRecord} review emptyLabel={analysis.kind === 'none' ? 'Проверка станет доступна после анализа видео' : 'Среди полученных наблюдений нет отметок для проверки'} /></DetailEventSection>
  </div>;
}
