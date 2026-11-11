import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock3, Download, ExternalLink, FileText, Mic, Package, RefreshCw, ShoppingBag } from 'lucide-react';
import { api, query } from './api.js';
import { Badge, Empty, ErrorNotice, Metric, Modal, number, readableDate, Spinner } from './components.jsx';
import { localDay } from './dataPresentation.js';
import { stationTitle } from './detailPresentation.js';
import { PdfReportPreview } from './PdfReportPreview.jsx';
import './microphones.css';

const products = [
  ['first_aid_kit', 'Аптечка'],
  ['fire_extinguisher', 'Огнетушитель'],
  ['warning_triangle', 'Знак аварийной остановки'],
  ['license_plate_frames', 'Рамки номеров'],
];
const statuses = {
  ready: { label: 'Готов', kind: 'green' },
  processing: { label: 'Обрабатывается', kind: 'amber' },
  missing: { label: 'Нет данных', kind: 'neutral' },
};
const emptyFilters = { from: '', to: '', region: '', stationId: '' };
const pageSize = 20;
const metricValue = value => value == null ? 'Нет данных' : number(value);
const coverageText = (known, ready) => known > 0 && known < ready ? `По ${known} из ${ready} готовых отчётов` : '';

function ShiftStatus({ status }) {
  const { label, kind } = statuses[status] || statuses.missing;
  return <Badge kind={kind} dot>{label}</Badge>;
}

function ProductMetric({ value, known, ready }) {
  const coverage = coverageText(known, ready);
  return <><strong className={value == null ? 'microphones-unknown' : undefined}>{metricValue(value)}</strong>{coverage && <small>{coverage}</small>}</>;
}

function Summary({ summary, configured, shiftCount }) {
  const { ready, processing, missing, offerEpisodes, sales, coverage } = summary;
  return <>
    <section className="data-section microphones-summary" aria-labelledby="microphones-summary-heading">
      <div className="section-heading"><div><h2 id="microphones-summary-heading">Состояние смен</h2><p>{configured ? 'Статусы по сменам, которые есть в реестре микрофонов' : 'Реестр смен микрофонов пока не подключён'}</p></div>{configured && <span className="count-label">Смен: {number(shiftCount)}</span>}</div>
      <div className="metrics-grid microphones-metrics microphones-status-metrics">
        <Metric label="Отчёты готовы" value={metricValue(configured ? ready : null)} icon={FileText} accent />
        <Metric label="В обработке" value={metricValue(configured ? processing : null)} icon={Clock3} />
        <Metric label="Смены без данных" value={metricValue(configured ? missing : null)} icon={Mic} />
      </div>
    </section>
    <section className="data-section microphones-commerce" aria-labelledby="microphones-commerce-heading">
      <div className="section-heading"><div><h2 id="microphones-commerce-heading">Доптовары</h2><p>Предложения — эпизоды с зафиксированным предложением. Продажи — только подтверждённые.</p></div></div>
      <div className="metrics-grid microphones-metrics microphones-commerce-metrics">
        <Metric label="Эпизоды с предложением" value={metricValue(offerEpisodes)} caption={coverageText(coverage?.offerEpisodes, ready)} icon={Package} accent />
        <Metric label="Подтверждённые продажи" value={metricValue(sales)} caption={coverageText(coverage?.sales, ready)} icon={ShoppingBag} />
      </div>
      <table className="microphones-products"><thead><tr><th scope="col">Товар</th><th scope="col">Предложения</th><th scope="col">Продажи</th></tr></thead>
        <tbody>{products.map(([id, name]) => <tr key={id}>
          <th scope="row">{name}</th>
          <td><ProductMetric value={summary.products?.[id]?.offerEpisodes} known={coverage?.products?.[id]?.offerEpisodes} ready={ready} /></td>
          <td><ProductMetric value={summary.products?.[id]?.sales} known={coverage?.products?.[id]?.sales} ready={ready} /></td>
        </tr>)}</tbody>
      </table>
      <p className="microphones-note">В одном эпизоде могут предложить несколько товаров, поэтому строки не складываются в итог.</p>
    </section>
  </>;
}

function StationSummary({ stations, shifts, onChoose }) {
  const counts = new Map();
  for (const { stationId, status } of shifts) {
    if (!counts.has(stationId)) counts.set(stationId, { ready: 0, processing: 0, missing: 0 });
    counts.get(stationId)[status] += 1;
  }
  if (!counts.size) return null;
  return <section className="data-section" aria-labelledby="microphones-station-heading">
    <div className="section-heading"><div><h2 id="microphones-station-heading">Сводка по ПТО</h2><p>Выберите ПТО, чтобы открыть его смены за этот период</p></div><span className="count-label">ПТО: {number(counts.size)}</span></div>
    <ul className="microphones-stations">{stations.filter(station => counts.has(station.id)).map(station => {
      const { ready, processing, missing } = counts.get(station.id);
      return <li key={station.id}><button type="button" className="microphones-station" onClick={() => onChoose(station)}>
        <span><strong>{stationTitle(station)}</strong><small>{station.region}</small></span>
        <span className="microphones-station-status">Готово: {ready} · В обработке: {processing} · Нет данных: {missing}</span><ChevronRight size={17} aria-hidden="true" />
      </button></li>;
    })}</ul>
  </section>;
}

function ReportViewer({ shift, station, onClose }) {
  const url = `/api/microphones/reports/${encodeURIComponent(shift.id)}/pdf`;
  const title = `Отчёт за ${readableDate(shift.date)}`;
  return <Modal title={title} subtitle={station ? stationTitle(station) : undefined} onClose={onClose} wide className="microphones-report">
    <div className="microphones-report-toolbar">
      {shift.demo && <Badge kind="amber">Демонстрационный отчёт</Badge>}
      <a className="button button-small" href={url} target="_blank" rel="noopener noreferrer">Открыть в новой вкладке <ExternalLink size={15} /></a>
      <a className="button button-small" href={url} download={`report-${shift.date}.pdf`}>Скачать PDF <Download size={15} /></a>
    </div>
    <PdfReportPreview url={url} />
  </Modal>;
}

export default function Microphones() {
  const [initialFilters] = useState(() => {
    const today = localDay();
    return { ...emptyFilters, from: today, to: today };
  });
  const [draft, setDraft] = useState(initialFilters);
  const [filters, setFilters] = useState(null);
  const [stations, setStations] = useState([]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [report, setReport] = useState(null);
  const [page, setPage] = useState(0);
  const shiftsHeading = useRef(null);
  const jumpToShifts = useRef(false);
  const closeReport = useCallback(() => setReport(null), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    api(`/microphones${query(filters || initialFilters)}`, { signal: controller.signal }).then(data => {
      if (!active) return;
      setStations(data.stations || []);
      if (!filters && data.latestDate && data.latestDate !== initialFilters.from) {
        const initial = { ...emptyFilters, from: data.latestDate, to: data.latestDate };
        setDraft(initial);
        setFilters(initial);
        return;
      }
      setResult({ filters, data });
      setLoading(false);
    }).catch(failure => {
      if (!active) return;
      setError(failure.status === 403 ? 'У вашей учётной записи нет доступа к микрофонам.' : failure.message);
      setResult(null);
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [filters, initialFilters, version]);

  useEffect(() => {
    if (loading || !result || !jumpToShifts.current) return;
    jumpToShifts.current = false;
    shiftsHeading.current?.focus();
    shiftsHeading.current?.scrollIntoView({ block: 'start' });
  }, [loading, result]);

  const visible = result?.filters === filters ? result.data : null;
  const stationById = new Map(stations.map(station => [station.id, station]));
  const regions = [...new Set(stations.map(station => station.region))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru'));
  const stationsInRegion = stations.filter(station => !draft.region || station.region === draft.region);
  const shifts = visible?.shifts || [];
  const invalidRange = draft.from && draft.to && draft.from > draft.to;
  const pages = Math.max(1, Math.ceil(shifts.length / pageSize));
  const apply = next => {
    setDraft(next);
    setFilters(next);
    setPage(0);
    closeReport();
  };
  const chooseStation = station => {
    jumpToShifts.current = true;
    apply({ ...(filters || initialFilters), region: station.region, stationId: station.id });
  };
  const refresh = () => { setVersion(value => value + 1); setPage(0); closeReport(); };
  const submit = event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const next = { ...draft, from: String(values.get('from') || ''), to: String(values.get('to') || '') };
    if (next.from && next.to && next.from > next.to) setDraft(next);
    else apply(next);
  };

  return <div className="microphones-workspace">
    <section className="data-section microphones-filters" aria-labelledby="microphones-filters-heading">
      <div className="section-heading"><div><h2 id="microphones-filters-heading">Период и ПТО</h2><p>Даты смен указаны по местному календарю станции</p></div><button type="button" className="icon-button" onClick={refresh} disabled={loading} aria-label="Обновить данные микрофонов"><RefreshCw size={18} className={loading ? 'spin' : ''} /></button></div>
      <form className="microphones-filter-form" onSubmit={submit}>
        <label>С даты<input type="date" name="from" value={draft.from} onInput={event => setDraft({ ...draft, from: event.currentTarget.value })} disabled={loading && !result} /></label>
        <label>По дату<input type="date" name="to" value={draft.to} onInput={event => setDraft({ ...draft, to: event.currentTarget.value })} disabled={loading && !result} /></label>
        <label>Регион<select value={draft.region} onChange={event => setDraft({ ...draft, region: event.target.value, stationId: '' })} disabled={!stations.length}><option value="">Все регионы</option>{regions.map(region => <option key={region} value={region}>{region}</option>)}</select></label>
        <label>ПТО<select value={draft.stationId} onChange={event => setDraft({ ...draft, stationId: event.target.value })} disabled={!stations.length}><option value="">Все доступные ПТО</option>{stationsInRegion.map(station => <option key={station.id} value={station.id}>{stationTitle(station)}</option>)}</select></label>
        <button type="submit" className="button button-primary" disabled={loading || Boolean(invalidRange)}>Показать</button>
      </form>
      {invalidRange && <p className="microphones-range-error" role="alert">Дата окончания должна быть не раньше даты начала.</p>}
    </section>
    <ErrorNotice message={error} retry={refresh} />
    {loading ? <Spinner label="Загружаем сводку по микрофонам…" /> : visible && <>
      {visible.demo && <div className="microphones-demo"><Badge kind="amber">Демонстрационные данные</Badge><span>Смены, показатели и PDF ниже подготовлены для проверки кабинета.</span></div>}
      <Summary summary={visible.summary} configured={visible.configured} shiftCount={shifts.length} />
      {!filters?.stationId && <StationSummary stations={stations} shifts={shifts} onChoose={chooseStation} />}
      <section className="data-section microphones-shifts" aria-labelledby="microphones-shifts-heading">
        <div className="section-heading"><div><h2 ref={shiftsHeading} tabIndex={-1} id="microphones-shifts-heading">Смены и отчёты</h2><p>{filters?.stationId && stationById.has(filters.stationId) ? stationTitle(stationById.get(filters.stationId)) : 'Смены доступных ПТО за выбранный период'}</p></div>{visible.configured && <span className="count-label">{number(shifts.length)}</span>}</div>
        {shifts.length ? <>
          <div className="microphones-shift-row microphones-shift-header" aria-hidden="true"><span>Дата смены</span><span>Адрес ПТО</span><span>Статус</span><span>Отчёт</span></div>
          <ul className="microphones-shift-list">{shifts.slice(page * pageSize, (page + 1) * pageSize).map(shift => {
            const station = stationById.get(shift.stationId);
            return <li className="microphones-shift-row" key={shift.id}>
              <time dateTime={shift.date}>{readableDate(shift.date)}</time>
              <span className="microphones-shift-address">{station ? stationTitle(station) : 'Адрес не указан'}{station?.region && <small>{station.region}</small>}</span>
              <span className="microphones-shift-badges"><ShiftStatus status={shift.status} />{shift.demo && <Badge kind="amber">Пример</Badge>}</span>
              {shift.status === 'ready' ? <button type="button" className="button button-small" onClick={() => setReport(shift)}><FileText size={15} />Открыть отчёт</button> : <span className="microphones-unavailable" aria-label="Отчёт недоступен">—</span>}
            </li>;
          })}</ul>
          {pages > 1 && <div className="pagination"><span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, shifts.length)} из {number(shifts.length)} смен</span><div><button type="button" className="icon-button" onClick={() => setPage(page - 1)} disabled={page === 0} aria-label="Предыдущая страница"><ChevronLeft size={17} /></button><span>{page + 1} / {pages}</span><button type="button" className="icon-button" onClick={() => setPage(page + 1)} disabled={page + 1 === pages} aria-label="Следующая страница"><ChevronRight size={17} /></button></div></div>}
        </> : <Empty title={visible.configured ? 'Смены не найдены' : 'Нет данных по сменам'} description={visible.configured ? 'За выбранный период в реестре нет смен по этим ПТО.' : 'Отчёты появятся после подключения реестра смен микрофонов.'} icon={FileText} action={visible.latestDate && <button className="button button-small" onClick={() => apply({ ...(filters || initialFilters), from: visible.latestDate, to: visible.latestDate })}>К последней смене</button>} />}
      </section>
    </>}
    {report && <ReportViewer shift={report} station={stationById.get(report.stationId)} onClose={closeReport} />}
  </div>;
}
