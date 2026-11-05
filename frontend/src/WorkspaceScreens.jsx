import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Building2, Camera, ChevronLeft, ChevronRight, Clock3, Eye, Film, Search, SlidersHorizontal } from 'lucide-react';
import { address, CameraStatus, Empty, matches, Metric, number, SourceLabel, Spinner, time } from './components.jsx';
import { Filters } from './screens.jsx';
import { groupCameras, sumMeasured } from './dataPresentation.js';
import './workspace.css';

export function Overview({ stations, cameras, loading, onStation, onNavigate, region, setRegion, search, setSearch, date, dataMode = 'real', currentUser }) {
  const [page, setPage] = useState(0);
  const regions = [...new Set(stations.map(station => station.region))].sort((a, b) => a.localeCompare(b, 'ru'));
  const filtered = useMemo(() => stations.filter(station => (!region || station.region === region)
    && matches([station.city, station.address, station.region, station.manager], search))
    .sort((a, b) => Number(b.metrics?.source === 'demo') - Number(a.metrics?.source === 'demo')
      || (b.cameraCount || 0) - (a.cameraCount || 0) || a.address.localeCompare(b.address, 'ru')), [stations, region, search]);
  useEffect(() => setPage(0), [region, search, date, dataMode]);
  const pages = Math.max(1, Math.ceil(filtered.length / 15));
  const currentPage = Math.min(page, pages - 1);
  const pageRows = filtered.slice(currentPage * 15, currentPage * 15 + 15);
  const visibleIds = new Set(filtered.map(station => station.id));
  const filteredCameras = cameras.filter(camera => visibleIds.has(camera.stationId));
  const hasFilter = Boolean(region || search.trim());
  const countedCameras = hasFilter ? filteredCameras : cameras;
  const withData = filtered.filter(station => station.metrics?.source && station.metrics.source !== 'none');
  const entries = sumMeasured(withData, 'entries'), exits = sumMeasured(withData, 'exits');
  return <>
    <div className="metrics-grid overview-metrics">
      <Metric label={hasFilter ? 'ПТО по фильтру' : 'ПТО в вашем доступе'} value={number(filtered.length)} caption={hasFilter ? `Из ${stations.length} доступных ПТО` : 'Адреса из реестра компании'} icon={Building2} />
      <Metric label={hasFilter ? 'Камеры этих ПТО' : 'Камеры в вашем доступе'} value={number(countedCameras.length)} caption={hasFilter ? 'Только выбранные адреса' : `Без адреса: ${cameras.filter(camera => !camera.stationId).length}`} icon={Camera} />
      <Metric label="Просмотр настроен" value={number(countedCameras.filter(camera => camera.liveAvailable).length)} caption="Связь проверяется при запуске" icon={Eye} accent />
      <Metric label="ПТО с результатами за день" value={number(withData.length)} caption={dataMode === 'demo' ? 'Демонстрационные результаты' : 'Результаты видеоанализа'} icon={Clock3} />
    </div>
    {dataMode === 'demo' && <div className="example-summary"><strong>Пример показателей за выбранный день</strong><span><ArrowDownLeft size={15} />Въезды: {number(entries)}</span><span><ArrowUpRight size={15} />Выезды: {number(exits)}</span><span>Результаты по {withData.length} из {filtered.length} ПТО в выборке</span></div>}
    <section className="data-section"><div className="section-heading overview-section-heading"><div><h2>{currentUser?.role === 'regional' ? 'Мои ПТО' : 'Станции в вашем доступе'}</h2><p>Найдите адрес, затем откройте сводку или видео</p></div><span className="count-label">{filtered.length}</span></div>
      <Filters {...{ region, setRegion, regions, search, setSearch }} />
      {loading ? <Spinner /> : !filtered.length ? <Empty title="Станции не найдены" description="Измените регион или поисковый запрос." icon={Search} /> : <>
        <div className="table-scroll"><table className="station-table workspace-station-table"><thead><tr><th>Адрес ПТО</th><th>Первый человек</th><th>Открытие</th><th>Закрытие</th><th className="numeric">Въезды</th><th className="numeric">Выезды</th><th>Данные и камеры</th><th aria-label="Подробности" /></tr></thead><tbody>{pageRows.map(station => <tr key={station.id}>
          <td><button className="station-link" onClick={() => onStation(station.id)}><span className="station-main">{station.city} · {address(station)}</span></button><span className="station-manager">{station.manager} · {station.region}</span></td>
          <td className="time-cell">{time(station.metrics?.firstSeenAt)}</td><td className="time-cell">{time(station.metrics?.openedAt)}</td><td className="time-cell">{time(station.metrics?.closedAt)}</td><td className="numeric entries-cell">{number(station.metrics?.entries)}</td><td className="numeric entries-cell">{number(station.metrics?.exits)}</td>
          <td><div className="station-state"><span className="camera-count"><Camera size={14} />{station.cameraCount ?? 0}</span><SourceLabel metrics={station.metrics} /></div></td><td><button className="icon-button" aria-label={`Открыть станцию ${station.address}`} onClick={() => onStation(station.id)}><ChevronRight size={18} /></button></td>
        </tr>)}</tbody></table></div>
        <div className="station-mobile-list">{pageRows.map(station => <button key={station.id} className="station-mobile-card" onClick={() => onStation(station.id)}><strong>{station.city} · {address(station)}</strong><span>{station.manager} · Камер: {station.cameraCount ?? 0}</span>{station.metrics?.source !== 'none' ? <div><span>Первый человек: {time(station.metrics?.firstSeenAt)}</span><span>Открытие: {time(station.metrics?.openedAt)}</span><span>Въезды / выезды: {number(station.metrics?.entries)} / {number(station.metrics?.exits)}</span></div> : <span className="mobile-analysis-empty">Видео ещё не анализировалось</span>}<span className="mobile-open">Открыть ПТО <ChevronRight size={15} /></span></button>)}</div>
        <div className="pagination"><span>{currentPage * 15 + 1}–{Math.min((currentPage + 1) * 15, filtered.length)} из {filtered.length} ПТО</span><div><button className="icon-button" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0} aria-label="Предыдущая страница"><ChevronLeft size={17} /></button><span>{currentPage + 1} / {pages}</span><button className="icon-button" onClick={() => setPage(currentPage + 1)} disabled={currentPage === pages - 1} aria-label="Следующая страница"><ChevronRight size={17} /></button></div></div>
      </>}
    </section><div className="overview-bottom"><span><Clock3 size={15} />Время событий — местное время ПТО по данным источника. Прочерк — нет результата.</span><button className="text-button" onClick={() => onNavigate('events')}>События ПТО<ArrowRight size={15} /></button></div>
  </>;
}

const viewLabel = camera => ({ gate_line: 'Ворота и диагностическая линия', client_area: 'Клиентская зона' })[camera.view] || 'Ракурс не проверен';

export function Cameras({ cameras, stations, onCamera, loading, dataMode = 'real' }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const filtered = cameras.filter(camera => {
    const station = stations.find(item => item.id === camera.stationId);
    return matches([camera.name, camera.model, station?.city || '', station?.address || '', station?.manager || '', station?.region || ''], search)
      && (!status || status === 'live' && camera.liveAvailable || status === 'archive' && camera.archiveAvailable
        || status === 'unassigned' && !station || status === 'unconnected' && !camera.liveAvailable && !camera.archiveAvailable);
  });
  const groups = groupCameras(filtered, stations);
  return <section className="data-section cameras-workspace"><div className="section-heading"><div><h2>Выберите адрес ПТО</h2><p>{dataMode === 'demo' ? 'Камеры учебного примера. Реальные записи в нём отсутствуют.' : 'Камеры сгруппированы по станции. Просмотр запускается вручную.'}</p></div><span className="count-label">{filtered.length} / {cameras.length}</span></div>
    <div className="filter-bar"><label className="search-field"><Search size={18} /><span className="sr-only">Поиск камер по адресу</span><input type="search" aria-label="Поиск камер по адресу" placeholder="Город, адрес, руководитель или камера…" value={search} onChange={event => setSearch(event.target.value)} /></label><label className="plain-select"><SlidersHorizontal size={16} /><select aria-label="Доступность видео" value={status} onChange={event => setStatus(event.target.value)}><option value="">Все камеры</option><option value="live">Просмотр настроен</option><option value="archive">Есть запись в сервисе</option><option value="unassigned">Без адреса ПТО</option><option value="unconnected">Видео не подключено</option></select></label></div>
    {loading ? <Spinner /> : !filtered.length ? <Empty title="Камеры не найдены" description="Измените адрес или фильтр доступности видео." /> : <div className="camera-station-groups">{groups.map(group => <section className="camera-station-group" key={group.station?.id || 'unassigned'}><div className="camera-station-heading"><div><h3>{group.station ? `${group.station.city} · ${address(group.station)}` : 'Адрес ПТО не указан'}</h3><p>{group.station ? `${group.station.manager} · ${group.station.region}` : 'Названия этих камер ещё нужно сопоставить с реестром станций'}</p></div><span className="count-label">{group.cameras.length}</span></div>
      {group.cameras.map(camera => <article className="compact-camera-card" key={camera.id}><div className="compact-camera-symbol"><Camera size={22} strokeWidth={1.5} /></div><div className="compact-camera-info"><strong>{camera.name}</strong><span>{viewLabel(camera)} · {camera.model}</span>{camera.mappingStatus && <small>{camera.mappingStatus === 'matched' ? 'Адрес найден по названию — требуется проверка' : 'Привязка к адресу не подтверждена'}</small>}<CameraStatus camera={camera} /></div><div className="compact-camera-actions"><button className="button button-small" disabled={!camera.liveAvailable} onClick={() => onCamera(camera, 'online')} aria-label={`Онлайн: ${group.station?.address || camera.name}`}><Eye size={15} />Онлайн</button><button className="button button-small" disabled={!camera.archiveAvailable} onClick={() => onCamera(camera, 'archive')} aria-label={`Архив: ${group.station?.address || camera.name}`}><Film size={15} />Архив</button><button className="text-button" onClick={() => onCamera(camera)} aria-label={`Открыть камеру ${camera.name}`}>О камере<ChevronRight size={15} /></button></div></article>)}
    </section>)}</div>}
  </section>;
}
