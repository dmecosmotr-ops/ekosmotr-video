import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Camera, Check, ChevronDown, Eye, EyeOff, LayoutGrid, Maximize, Minimize, Pencil, Play, Plus, Search, SlidersHorizontal, Square, Trash2, X } from 'lucide-react';
import LivePlayer from './LivePlayer.jsx';
import { Empty, Spinner } from './components.jsx';
import { stationTitle } from './detailPresentation.js';
import { monitorCandidates, monitorGridLayout, monitorLimit, sanitizeMonitorSelection } from './monitoringSelection.js';
import { addMonitorDesk, loadMonitorDesks, removeMonitorDesk, renameMonitorDesk, sanitizeMonitorDesks, saveMonitorDesks, selectMonitorDesk, setMonitorDeskCameras } from './monitoringDesks.js';
import './monitoring.css';

const browserStorage = () => { try { return globalThis.localStorage; } catch { return null; } };
const activePhases = new Set(['starting', 'connecting', 'playing']);
const occupiedPhases = new Set([...activePhases, 'stopping']);
const cameraIdsFor = desks => desks.desks.find(desk => desk.id === desks.activeId)?.cameraIds ?? desks.draftCameraIds;

function useFittedGrid(workspaceRef, gridRef, count, pickerOpen, expanded) {
  const [bounds, setBounds] = useState(null);
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const grid = gridRef.current;
    if (!grid || !count) return;
    const toolbar = workspace.querySelector('.monitoring-toolbar');
    const measure = () => {
      const { width, top } = grid.getBoundingClientRect();
      const viewport = window.visualViewport?.height ?? document.documentElement.clientHeight;
      const available = expanded
        ? workspace.clientHeight - (top - workspace.getBoundingClientRect().top + workspace.scrollTop) - 12
        : viewport - (top + window.scrollY) - 20;
      const height = Math.max(pickerOpen ? Math.round(viewport * 0.55) : 72, Math.floor(available));
      const pixelWidth = Math.floor(width);
      setBounds(previous => previous?.width === pixelWidth && previous.height === height ? previous : { width: pixelWidth, height });
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(grid);
    observer?.observe(workspace);
    if (toolbar) observer?.observe(toolbar);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [workspaceRef, gridRef, count, pickerOpen, expanded]);
  return bounds && { ...monitorGridLayout(count, bounds.width, bounds.height), height: bounds.height };
}

export default function Monitoring({ cameras, stations, user, loading = false, catalogReady = false, maxStreams = 1 }) {
  const protocol = globalThis.performance?.getEntriesByType?.('navigation')[0]?.nextHopProtocol;
  const limit = monitorLimit(maxStreams, protocol);
  const [deskState, setDeskState] = useState(() => loadMonitorDesks(browserStorage(), user.id));
  const [pickerOpen, setPickerOpen] = useState(() => cameraIdsFor(deskState).length === 0);
  const [deskEditor, setDeskEditor] = useState(null);
  const [deskName, setDeskName] = useState('');
  const [switching, setSwitching] = useState(false);
  const [search, setSearch] = useState('');
  const [region, setRegion] = useState('');
  const [phases, setPhases] = useState({});
  const [fullscreen, setFullscreen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [videoOnly, setVideoOnly] = useState(false);
  const [enlargedId, setEnlargedId] = useState(null);
  const workspaceRef = useRef(null);
  const gridRef = useRef(null);
  const controllers = useRef(new Map());
  const currentPhases = useRef(new Map());
  const changingDesk = useRef(false);
  const candidates = useMemo(() => monitorCandidates(cameras, stations), [cameras, stations]);
  const byId = useMemo(() => new Map(candidates.map(camera => [camera.id, camera])), [candidates]);
  const allowedIds = useMemo(() => [...byId.keys()], [byId]);
  const selectedIds = sanitizeMonitorSelection(cameraIdsFor(deskState), allowedIds);
  const selected = selectedIds.map(id => byId.get(id));
  const selectedSet = new Set(selectedIds);
  const enlargedCameraId = selectedSet.has(enlargedId) ? enlargedId : null;
  const activeDesk = deskState.desks.find(desk => desk.id === deskState.activeId);
  const found = useMemo(() => monitorCandidates(cameras, stations, search, region), [cameras, stations, search, region]);
  const regions = [...new Set(candidates.map(camera => camera.station?.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const full = fullscreen || expanded;
  const fit = useFittedGrid(workspaceRef, gridRef, !catalogReady && loading ? 0 : selected.length, pickerOpen, full);
  const gridStyle = fit?.columns ? { '--monitoring-columns': fit.columns, '--monitoring-rows': fit.rows, '--monitoring-height': `${fit.height}px`, '--monitoring-grid-gap': `${fit.gap}px` } : undefined;
  const gridDensity = fit?.tileWidth < 86 || fit?.tileHeight < 90 ? 'is-tiny' : fit?.tileWidth < 175 || fit?.tileHeight < 126 ? 'is-dense' : '';

  useEffect(() => {
    const workspace = workspaceRef.current;
    const changed = () => setFullscreen(document.fullscreenElement === workspace);
    document.addEventListener('fullscreenchange', changed);
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      if (document.fullscreenElement === workspace) void document.exitFullscreen?.().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!expanded && !enlargedCameraId) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = event => {
      if (event.key !== 'Escape') return;
      if (enlargedCameraId) {
        workspaceRef.current?.querySelector('.monitoring-tile.is-enlarged .monitoring-tile-title')?.focus({ preventScroll: true });
        setEnlargedId(null);
      }
      else setExpanded(false);
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', escape);
    };
  }, [expanded, enlargedCameraId]);
  const toggleFullscreen = async () => {
    if (expanded) { setExpanded(false); return; }
    try {
      if (document.fullscreenElement === workspaceRef.current) await document.exitFullscreen();
      else if (workspaceRef.current?.requestFullscreen) await workspaceRef.current.requestFullscreen();
      else setExpanded(true);
    } catch { setExpanded(true); }
  };

  useEffect(() => {
    if (!catalogReady) return;
    const valid = sanitizeMonitorDesks(deskState, allowedIds);
    if (valid !== deskState) setDeskState(valid);
    saveMonitorDesks(browserStorage(), user.id, valid);
  }, [catalogReady, deskState, allowedIds, user.id]);
  useEffect(() => {
    if (enlargedId && !enlargedCameraId) setEnlargedId(null);
  }, [enlargedId, enlargedCameraId]);

  const register = useCallback((id, controller) => {
    if (controller) controllers.current.set(id, controller);
    else {
      controllers.current.delete(id);
      currentPhases.current.delete(id);
    }
  }, []);
  const phaseChanged = useCallback((id, phase) => {
    currentPhases.current.set(id, phase);
    setPhases(previous => previous[id] === phase ? previous : { ...previous, [id]: phase });
  }, []);
  const startCamera = id => {
    const controller = controllers.current.get(id);
    const live = currentPhases.current;
    if (!controller || !catalogReady || changingDesk.current || occupiedPhases.has(live.get(id))) return;
    if (selectedIds.filter(cameraId => occupiedPhases.has(live.get(cameraId))).length >= limit) return;
    phaseChanged(id, 'starting');
    return controller.start();
  };
  const stopAll = () => Promise.allSettled([...controllers.current.values()].map(controller => controller.stop()));

  const changeDesk = async next => {
    if (changingDesk.current) return;
    if (next === deskState) { setDeskEditor(null); return; }
    if (next.activeId !== deskState.activeId) {
      changingDesk.current = true;
      setSwitching(true);
      await stopAll();
      currentPhases.current.clear();
      setPhases({});
      setEnlargedId(null);
      setSearch('');
      setRegion('');
      setPickerOpen(cameraIdsFor(next).length === 0);
      changingDesk.current = false;
      setSwitching(false);
    }
    setDeskState(next);
    setDeskEditor(null);
  };
  const editDesk = action => {
    setDeskName(action === 'rename' ? activeDesk.name : '');
    setDeskEditor(action);
  };
  const saveDeskName = event => {
    event.preventDefault();
    if (!deskName.trim()) return;
    void changeDesk(deskEditor === 'create' ? addMonitorDesk(deskState, deskName) : renameMonitorDesk(deskState, activeDesk.id, deskName));
  };
  const toggle = id => {
    if (changingDesk.current) return;
    if (enlargedId === id) setEnlargedId(null);
    setDeskState(previous => {
      const current = sanitizeMonitorSelection(cameraIdsFor(previous), allowedIds);
      return setMonitorDeskCameras(previous, current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
    });
  };
  const clearSelection = () => {
    if (changingDesk.current) return;
    void stopAll();
    setEnlargedId(null);
    setDeskState(previous => setMonitorDeskCameras(previous, []));
  };
  const startAll = () => {
    void Promise.allSettled(selectedIds.map(startCamera));
    setPickerOpen(false);
  };
  const active = selectedIds.filter(id => activePhases.has(phases[id])).length;
  const playing = selectedIds.filter(id => phases[id] === 'playing').length;
  const occupied = selectedIds.filter(id => occupiedPhases.has(phases[id])).length;
  const remaining = Math.max(0, limit - occupied);
  const eligible = selected.length - occupied;
  const groupLabel = remaining > 0 && eligible > remaining ? `Запустить ${remaining} из ${eligible}` : 'Запустить все';

  return <section ref={workspaceRef} className={`monitoring-workspace ${expanded ? 'is-expanded' : ''}`} aria-label="Мониторинг камер">
    <div className="monitoring-toolbar" inert={Boolean(enlargedCameraId)}>
      <div className="monitoring-toolbar-row">
        <div className="monitoring-summary"><strong>Ваш экран наблюдения</strong><p title="Каждый сеанс длится до 10 минут. При уходе со вкладки просмотр останавливается.">Выбрано {selected.length} · В эфире {playing} · До {limit} одновременно</p></div>
        <div className="monitoring-actions">
          <button type="button" className="button button-secondary" disabled={switching} aria-expanded={pickerOpen} aria-controls="monitoring-picker" onClick={() => setPickerOpen(value => !value)}><SlidersHorizontal size={16} />Выбрать камеры<ChevronDown size={14} /></button>
          <button type="button" className="button button-primary" disabled={!catalogReady || !remaining || !eligible || switching} onClick={startAll}><Play size={15} />{groupLabel}</button>
          <button type="button" className="button button-secondary" disabled={!active || switching} onClick={() => void stopAll()}><Square size={14} />Остановить все</button>
          <button type="button" className="button button-secondary" aria-pressed={videoOnly} onClick={() => setVideoOnly(value => !value)}>{videoOnly ? <Eye size={16} /> : <EyeOff size={16} />}{videoOnly ? 'Показать описание' : 'Скрыть описание'}</button>
          <button type="button" className="button button-secondary" onClick={toggleFullscreen} aria-label={full ? 'Выйти из полноэкранного мониторинга' : 'Развернуть мониторинг на весь экран'}>{full ? <Minimize size={15} /> : <Maximize size={15} />}{full ? 'Свернуть' : 'На весь экран'}</button>
        </div>
      </div>
      <div className="monitoring-desks">
        {deskState.desks.length > 0 && <label className="plain-select"><span className="sr-only">Рабочий стол</span><select aria-label="Рабочий стол" value={deskState.activeId ?? ''} disabled={switching} onChange={event => void changeDesk(selectMonitorDesk(deskState, event.target.value))}>{deskState.desks.map(desk => <option key={desk.id} value={desk.id}>{desk.name}</option>)}</select></label>}
        <button type="button" className="button button-secondary" disabled={switching} onClick={() => editDesk('create')}><Plus size={15} />Создать стол</button>
        {activeDesk && <><button type="button" className="icon-button" disabled={switching} aria-label="Переименовать рабочий стол" title="Переименовать рабочий стол" onClick={() => editDesk('rename')}><Pencil size={16} /></button><button type="button" className="icon-button" disabled={switching} aria-label="Удалить рабочий стол" title="Удалить рабочий стол" onClick={() => editDesk('delete')}><Trash2 size={16} /></button></>}
        {switching && <span role="status" className="monitoring-switching">Переключаем стол…</span>}
      </div>
      {deskEditor && (deskEditor === 'delete' ? <div className="monitoring-desk-editor" role="group" aria-label="Удаление рабочего стола">
        <span>Удалить «{activeDesk.name}»?</span><button type="button" className="button button-secondary" disabled={switching} onClick={() => void changeDesk(removeMonitorDesk(deskState, activeDesk.id))}>Удалить</button><button type="button" className="button button-secondary" disabled={switching} onClick={() => setDeskEditor(null)}>Отмена</button>
      </div> : <form className="monitoring-desk-editor" onSubmit={saveDeskName}>
        <label><span className="sr-only">Название рабочего стола</span><input aria-label="Название рабочего стола" placeholder="Название рабочего стола" value={deskName} maxLength={60} required autoFocus onChange={event => setDeskName(event.target.value)} /></label><button type="submit" className="button button-primary" disabled={!deskName.trim() || switching}>Сохранить</button><button type="button" className="button button-secondary" disabled={switching} onClick={() => setDeskEditor(null)}>Отмена</button>
      </form>)}
    </div>
    {pickerOpen && <section className="monitoring-picker" id="monitoring-picker" aria-label="Выбор камер для мониторинга" inert={Boolean(enlargedCameraId)}>
      <div className="monitoring-picker-heading"><div><h2>Какие камеры показать?</h2><p>Выбор сохраняется в этом браузере для вашей учётной записи.</p></div><div className="monitoring-picker-actions"><button type="button" className="button button-small" disabled={!selected.length || switching} onClick={clearSelection}>Снять все</button><button type="button" className="button button-small" onClick={() => setPickerOpen(false)}><Check size={15} />Готово</button></div></div>
      <div className="monitoring-filters"><label className="monitoring-search"><Search size={17} /><span className="sr-only">Найти камеру для мониторинга</span><input type="search" placeholder="Адрес, название камеры или регион" aria-label="Найти камеру для мониторинга" value={search} onChange={event => setSearch(event.target.value)} /></label><label className="plain-select"><span className="sr-only">Регион камер мониторинга</span><select aria-label="Регион камер мониторинга" value={region} onChange={event => setRegion(event.target.value)}><option value="">Все регионы</option>{regions.map(value => <option key={value}>{value}</option>)}</select></label></div>
      {loading && !catalogReady ? <Spinner label="Загружаем доступные камеры…" /> : !found.length ? <div className="monitoring-no-results">{candidates.length ? 'По этому запросу камер не найдено.' : 'Для доступных вам камер онлайн-просмотр пока не настроен.'}</div> : <div className="monitoring-camera-options">
        {found.map(camera => {
          const checked = selectedSet.has(camera.id);
          return <label className={`monitoring-option ${checked ? 'is-selected' : ''}`} key={camera.id}><input type="checkbox" checked={checked} disabled={switching} onChange={() => toggle(camera.id)} /><span><strong>{camera.station ? stationTitle(camera.station) : camera.name}</strong><span>{camera.station ? camera.name : 'Адрес не подтверждён'}{camera.station?.region && ` · ${camera.station.region}`}</span></span><Camera size={17} /></label>;
        })}
      </div>}
    </section>}
    {!catalogReady && loading ? <Spinner label="Подготавливаем экран наблюдения…" /> : !selected.length ? <Empty title="Соберите свой экран наблюдения" description="Выберите нужные камеры разных ПТО, затем запустите просмотр." icon={LayoutGrid} action={!pickerOpen && <button className="button button-primary" onClick={() => setPickerOpen(true)}>Выбрать камеры</button>} /> : <div ref={gridRef} className={`monitoring-grid ${gridDensity}${videoOnly ? ' is-video-only' : ''}`} style={gridStyle}>
      {selected.map(camera => {
        const enlarged = enlargedCameraId === camera.id;
        const title = camera.station ? stationTitle(camera.station) : camera.name;
        return <article className={`monitoring-tile ${enlarged ? 'is-enlarged' : ''}`} key={`${deskState.activeId ?? 'draft'}/${camera.id}`} aria-label={`Окно камеры: ${camera.name}`} inert={Boolean(enlargedCameraId && !enlarged)}>
          <div className="monitoring-tile-body" role={enlarged ? 'dialog' : undefined} aria-modal={enlarged || undefined} aria-label={enlarged ? `Просмотр камеры ${camera.name}` : undefined} onKeyDown={enlarged ? event => {
            if (event.key !== 'Tab') return;
            const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled), video[controls]')];
            const from = event.shiftKey ? controls.at(0) : controls.at(-1);
            const to = event.shiftKey ? controls.at(-1) : controls.at(0);
            if (event.target === from) { event.preventDefault(); to?.focus(); }
          } : undefined}>
            <header className="monitoring-tile-header"><div className="monitoring-tile-heading"><h2><button type="button" className="monitoring-tile-title" aria-label={`${enlarged ? 'Свернуть' : 'Увеличить'} окно камеры ${camera.name}`} title={`${enlarged ? 'Свернуть' : 'Увеличить'} · ${title}`} onClick={() => setEnlargedId(enlarged ? null : camera.id)}><span>{title}</span>{enlarged ? <Minimize size={14} /> : <Maximize size={14} />}</button></h2><p>{camera.station ? camera.name : 'Адрес не подтверждён'}{camera.station?.region && ` · ${camera.station.region}`}</p></div><button type="button" className="icon-button monitoring-remove" disabled={switching} aria-label={`Убрать камеру ${camera.name}`} onClick={() => toggle(camera.id)} title="Убрать с экрана"><X size={17} /></button></header>
            <LivePlayer cameraId={camera.id} cameraName={camera.name} compact videoOnly={videoOnly} maxStreams={limit} onController={register} onPhaseChange={phaseChanged} onStart={startCamera} startBlocked={!remaining} startDisabled={switching || !catalogReady} message="Запустите просмотр этой камеры или всей сетки." />
          </div>
        </article>;
      })}
    </div>}
  </section>;
}
