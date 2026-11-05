import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ChevronDown, Clock3, DoorClosed, ListFilter, Search, TriangleAlert, UserRound } from 'lucide-react';
import { clock, observedClock } from './playbackHelpers.js';
import { buildStationEventRows, EVENT_METRICS, eventsForMetric, metricStationRows, orderedEvents, stationEventTitle, vehicleCounts } from './eventsPresentation.js';
import { EventMomentList, EventsPagination, VehicleVisits } from './EventGroups.jsx';
import RecordingAction from './RecordingAction.jsx';
import './events.css';

const metricIcons = { start: UserRound, vehicles: ArrowDownLeft, closed: DoorClosed, review: TriangleAlert };

function StationMetricSummary({ row, metric, date }) {
  if (row.analysis.kind === 'none') return <span className="station-metric-no-data">{row.analysis.label}</span>;
  const relevant = eventsForMetric(metric === 'vehicles' ? row.vehicleEvents : row.events, metric, date);
  if (metric === 'start') {
    const first = row.events.find(event => event.type === 'first_seen');
    const open = row.events.find(event => event.type === 'opened');
    return <span className="station-metric-values"><span>Человек в кадре <strong>{observedClock(first?.time, first?.timing)}</strong></span><span>{open?.source === 'analysis' ? 'Ворота: открытие, проверить' : 'Открытие'} <strong>{observedClock(open?.time, open?.timing)}</strong></span></span>;
  }
  if (metric === 'vehicles') {
    const counts = vehicleCounts(row.vehicleEvents, row.analysis, date);
    return <span className="station-metric-values"><span>Въезды <strong>{counts.entries ?? '—'}</strong></span><span>Выезды <strong>{counts.exits ?? '—'}</strong></span><span>Связано <strong>{counts.completed ?? '—'}</strong></span></span>;
  }
  if (metric === 'closed') return <span className="station-metric-values"><span>{relevant.at(-1)?.source === 'analysis' ? 'Ворота: закрытие, проверить' : 'Закрытие'} <strong>{observedClock(relevant.at(-1)?.time, relevant.at(-1)?.timing)}</strong></span></span>;
  return <span className="badge badge-amber">Наблюдений для проверки: {relevant.length}</span>;
}

function MetricStationRow({ row, metric, date, onRecord, onStation }) {
  const relevant = eventsForMetric(metric === 'vehicles' ? row.vehicleEvents : row.events, metric, date);
  const emptyLabel = row.analysis.kind === 'none' ? row.analysis.label : row.analysis.countable ? 'За обработанный период отметки не найдены' : 'Отметки не получены. Полнота анализа не подтверждена.';
  return <details className="station-metric-row"><summary><div className="station-metric-address"><strong>{row.title}</strong><span>{[row.station?.manager, row.station?.region].filter(Boolean).join(' · ') || row.cameras[0]?.name || 'Привязка к адресу требует проверки'}</span></div><StationMetricSummary row={row} metric={metric} date={date} /><ChevronDown size={16} className="events-disclosure-chevron" aria-hidden="true" /></summary><div className="station-metric-body">{row.analysis.kind === 'partial' && <p className="events-analysis-state is-partial">{row.analysis.label}</p>}{metric === 'vehicles' ? <VehicleVisits key={`${date}:${row.id}`} events={row.vehicleEvents} date={date} cameras={row.cameras} onRecord={onRecord} analysisSource={row.station?.metrics} /> : <EventMomentList events={relevant} cameras={row.cameras} onRecord={onRecord} emptyLabel={emptyLabel} review={metric === 'review'} />}{row.station && onStation && <button type="button" className="text-button events-open-station" onClick={() => onStation(row.station.id)}>Открыть ПТО</button>}</div></details>;
}

function MetricStationBlock({ metric, rows, date, onRecord, onStation, defaultOpen, contextKey }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [contextKey]);
  const Icon = metricIcons[metric.id];
  const relevantRows = metricStationRows(rows, metric.id, date);
  const withResults = relevantRows.filter(row => eventsForMetric(metric.id === 'vehicles' ? row.vehicleEvents : row.events, metric.id, date).length).length;
  const pageSize = 10, pages = Math.max(1, Math.ceil(relevantRows.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  return <details className={`events-metric-block events-metric-${metric.id}`} open={defaultOpen || undefined}><summary><Icon size={19} aria-hidden="true" /><div><h3>{metric.title}</h3><p>{metric.id === 'review' ? `${withResults} ПТО с наблюдениями для проверки` : `С отметками: ${withResults} из ${rows.length} ПТО`}</p></div><ChevronDown size={18} className="events-disclosure-chevron" aria-hidden="true" /></summary><div className="events-metric-content">{!relevantRows.length ? <p className="events-empty-note">{metric.id === 'review' ? rows.some(row => row.analysis.kind !== 'none') ? 'Среди полученных наблюдений нет отметок для проверки' : 'Проверка станет доступна после анализа видео' : 'ПТО с такими условиями не найдены'}</p> : relevantRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(row => <MetricStationRow key={row.id} row={row} metric={metric.id} date={date} onRecord={onRecord} onStation={onStation} />)}<EventsPagination page={currentPage} pages={pages} total={relevantRows.length} pageSize={pageSize} onPage={setPage} noun="ПТО" /></div></details>;
}

function EventChronology({ rows, cameras, onRecord }) {
  const [page, setPage] = useState(0);
  const events = orderedEvents(rows.flatMap(row => row.events));
  const rowByEvent = new Map(rows.flatMap(row => row.events.map(event => [event, row])));
  const cameraById = new Map(cameras.map(camera => [camera.id, camera]));
  const pageSize = 20, pages = Math.max(1, Math.ceil(events.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  if (!events.length) return <div className="events-empty-panel"><Clock3 size={24} aria-hidden="true" /><strong>Наблюдений за выбранный день не получено</strong><p>ПТО без анализа доступны в виде «По показателям». Отсутствие наблюдений не подтверждает отсутствие работы или автомобилей.</p></div>;
  return <div className="events-chronology"><div className="events-chronology-list">{events.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((event, index) => <article className="events-chronology-row" key={event.id || index}><time>{observedClock(event.time, event.timing, true)}</time><div><strong className="events-chronology-address">{rowByEvent.get(event)?.title || stationEventTitle(null)}</strong><span className="events-chronology-label">{event.label || 'Наблюдение'}</span><p>{event.description}</p>{event.needsReview && <span className="badge badge-amber">Требует проверки</span>}</div><RecordingAction event={event} camera={cameraById.get(event.cameraId)} onRecord={onRecord} /></article>)}</div><EventsPagination page={currentPage} pages={pages} total={events.length} pageSize={pageSize} onPage={setPage} /></div>;
}

export default function Events({ events = [], stations = [], cameras = [], loading, onRecord, date, dataMode = 'real', onStation }) {
  const [search, setSearch] = useState('');
  const [manager, setManager] = useState('');
  const [region, setRegion] = useState('');
  const [view, setView] = useState('metrics');
  const managers = [...new Set(stations.map(station => station.manager).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const regions = [...new Set(stations.map(station => station.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const activeManager = managers.includes(manager) ? manager : '';
  const activeRegion = regions.includes(region) ? region : '';
  const rows = useMemo(() => buildStationEventRows({ stations, cameras, events, date, search, manager: activeManager, region: activeRegion }), [stations, cameras, events, date, search, activeManager, activeRegion]);
  const analyzed = rows.filter(row => row.analysis.kind !== 'none').length;
  const contextKey = `${date}:${dataMode}:${search}:${manager}:${region}`;
  const demo = dataMode === 'demo';
  return <section className="data-section events-screen"><div className="section-heading"><div><h2>Показатели дня</h2><p>Раскройте показатель и выберите нужный адрес</p></div>{demo && <span className="badge badge-amber">Пример данных</span>}</div><p className="events-date-note">Время указано по местному времени ПТО. {demo ? 'Учебные отметки не являются измерениями на станциях.' : 'Появление человека в кадре не подтверждает его личность или начало работы.'}</p><div className="events-screen-toolbar"><label className="search-field events-station-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Поиск ПТО по городу, адресу или руководителю</span><input type="search" placeholder="Город, адрес или руководитель" value={search} onChange={event => setSearch(event.target.value)} /></label>{managers.length > 1 && <label className="plain-select"><ListFilter size={16} aria-hidden="true" /><span className="sr-only">Руководитель ПТО</span><select aria-label="Руководитель ПТО" value={activeManager} onChange={event => setManager(event.target.value)}><option value="">Все руководители</option>{managers.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}{regions.length > 1 && <label className="plain-select"><span className="sr-only">Географический регион</span><select aria-label="Географический регион" value={activeRegion} onChange={event => setRegion(event.target.value)}><option value="">Все географические регионы</option>{regions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}</div><div className="events-view-bar"><p aria-live="polite">Найдено ПТО: <strong>{rows.filter(row => row.station).length}</strong> · С результатами: <strong>{analyzed}</strong></p><div className="segmented" role="group" aria-label="Представление событий"><button type="button" aria-pressed={view === 'metrics'} className={view === 'metrics' ? 'selected' : ''} onClick={() => setView('metrics')}>По показателям</button><button type="button" aria-pressed={view === 'chronology'} className={view === 'chronology' ? 'selected' : ''} onClick={() => setView('chronology')}>Хронология</button></div></div>
    {loading ? <div className="events-empty-panel" role="status">Загружаем события ПТО…</div> : !rows.length ? <div className="events-empty-panel"><Search size={24} aria-hidden="true" /><strong>ПТО с такими условиями не найдены</strong><p>Измените поиск или фильтры руководителя и региона.</p></div> : view === 'metrics' ? <div className="events-metric-blocks">{EVENT_METRICS.map(metric => <MetricStationBlock key={metric.id} metric={metric} rows={rows} date={date} onRecord={onRecord} onStation={onStation} contextKey={contextKey} />)}</div> : <EventChronology key={contextKey} rows={rows} cameras={cameras} onRecord={onRecord} />}
  </section>;
}
