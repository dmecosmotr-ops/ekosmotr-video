import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, Building2, CalendarDays, Camera, CheckCircle2, ChevronDown,
  CircleHelp, ClipboardList, LayoutDashboard, LayoutGrid, LogOut, Menu, Mic, RefreshCw,
  ShieldCheck, UsersRound, X,
} from 'lucide-react';
import { api, configureSession, query } from './api.js';
import { Brand, Login } from './screens.jsx';
import { Cameras, Overview } from './WorkspaceScreens.jsx';
import Events from './EventsScreen.jsx';
import Microphones from './MicrophonesScreen.jsx';
import Monitoring from './MonitoringScreen.jsx';
import { Users, Audit } from './ManagementScreens.jsx';
import { anonymousSession, localDay, presentWorkspace } from './dataPresentation.js';
import { CameraDetail, ErrorNotice, initials, roleNames, Spinner, StationDetail } from './components.jsx';

const pageTitles = { overview: 'Обзор сети', cameras: 'Камеры по адресам', monitoring: 'Мониторинг', microphones: 'Микрофоны', events: 'События ПТО', users: 'Пользователи и доступ', audit: 'Действия пользователей' };
const pageDescriptions = {
  overview: 'Адреса, видео и результаты за выбранный день',
  cameras: 'Найдите ПТО и выберите нужную камеру',
  monitoring: 'Камеры разных ПТО на одном экране — в прямом эфире',
  microphones: 'Сводка по доптоварам и отчёты по сменам ПТО',
  events: 'Выберите показатель, затем станцию и нужный момент',
  users: 'Роли пользователей и границы их доступа',
  audit: 'Входы, права доступа и просмотры видео',
};
const navigation = [
  { id: 'overview', label: 'Обзор сети', icon: LayoutDashboard },
  { id: 'cameras', label: 'Камеры', icon: Camera },
  { id: 'monitoring', label: 'Мониторинг', icon: LayoutGrid },
  { id: 'microphones', label: 'Микрофоны', icon: Mic, microphones: true },
  { id: 'events', label: 'События ПТО', icon: Activity },
  { id: 'users', label: 'Пользователи', icon: UsersRound, manage: true },
  { id: 'audit', label: 'Действия пользователей', icon: ClipboardList, manage: true },
];
const hashPage = () => window.location.hash.slice(1).split('?')[0] || 'overview';
const hasMicrophoneAccess = user => Boolean(user?.microphoneStationIds?.length);

export default function App() {
  const [session, setSession] = useState(null);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [sessionError, setSessionError] = useState('');
  const [booting, setBooting] = useState(true);
  const [date, setDate] = useState(localDay);
  const [dataMode, setDataMode] = useState('real');
  const realDate = useRef(localDay());
  const identity = useRef(null);
  const [page, setPage] = useState(hashPage);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stations, setStations] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [catalogReady, setCatalogReady] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [region, setRegion] = useState('');
  const [search, setSearch] = useState('');
  const [selectedStation, setSelectedStation] = useState(null);
  const [selectedCamera, setSelectedCamera] = useState(null);
  const [cameraMode, setCameraMode] = useState(undefined);
  const [cameraEventRequest, setCameraEventRequest] = useState(null);
  const [notice, setNotice] = useState('');
  const user = session?.user;
  const mayManage = user && user.role !== 'regional';

  const clearScopedState = useCallback(() => {
    setStations([]); setCameras([]); setEvents([]); setCatalogReady(false);
    setSelectedStation(null); setSelectedCamera(null); setCameraEventRequest(null);
    setRegion(''); setSearch(''); setNotice(''); setError('');
    setMenuOpen(false);
  }, []);

  const acceptSession = useCallback(data => {
    // Scope changes must never retain a previous account's station or media state.
    const sameAccount = Boolean(data.user?.id && data.user.id === identity.current);
    if (sameAccount) {
      setStations([]); setCameras([]); setEvents([]); setCatalogReady(false);
      setSelectedStation(null); setSelectedCamera(null); setCameraEventRequest(null);
      setError(''); setMenuOpen(false);
    } else {
      clearScopedState(); setDataMode('real'); setDate(localDay()); realDate.current = localDay();
    }
    identity.current = data.user?.id || null;
    configureSession(data.csrfToken, () => {
      clearScopedState();
      identity.current = null;
      setSession(anonymousSession);
    });
    setSession(data);
    setSessionEpoch(value => value + 1);
  }, [clearScopedState]);

  const getSession = useCallback(async () => {
    setSessionError('');
    try { const data = await api('/session'); acceptSession(data); return data; }
    catch (failure) { setSessionError(failure.message); return null; }
    finally { setBooting(false); }
  }, [acceptSession]);

  useEffect(() => { getSession(); }, [getSession]);
  useEffect(() => {
    const update = () => { setPage(hashPage()); setMenuOpen(false); setSelectedCamera(null); setSelectedStation(null); setCameraEventRequest(null); };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    let timer;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const dateQuery = query({ date });
    const refreshCameras = async () => {
      try {
        if (!document.hidden) {
          const data = await api(`/cameras${dateQuery}`, options);
          if (alive) setCameras(data.cameras || []);
        }
      } catch {
        // Keep the loaded list on a transient error. The API handles expired sessions.
      } finally {
        if (alive) timer = setTimeout(refreshCameras, 30000);
      }
    };
    setLoading(true); setError(''); setCatalogReady(false);
    setStations([]); setCameras([]); setEvents([]);
    Promise.all([api(`/stations${dateQuery}`, options), api(`/cameras${dateQuery}`, options), api(`/events${dateQuery}`, options)])
      .then(([stationData, cameraData, eventData]) => {
        if (!alive) return;
        setStations(stationData.stations || []); setCameras(cameraData.cameras || []); setEvents(eventData.events || []);
        setCatalogReady(true);
        setRegion(previous => previous && !(stationData.stations || []).some(station => station.region === previous) ? '' : previous);
      }).catch(failure => { if (alive) setError(failure.message); })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
        if (session?.xiaomiSyncEnabled || page === 'monitoring') timer = setTimeout(refreshCameras, 30000);
      });
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [user?.id, sessionEpoch, date, version, session?.xiaomiSyncEnabled, page === 'monitoring']);

  const navigate = destination => {
    if (window.location.hash === `#${destination}`) setPage(destination);
    else window.location.hash = destination;
    setMenuOpen(false);
  };
  const refreshSession = async () => { const data = await getSession(); setVersion(value => value + 1); return data; };
  const logout = async () => {
    setError('');
    try { await api('/logout', { method: 'POST' }); configureSession(null); clearScopedState(); identity.current = null; setSession(anonymousSession); }
    catch (failure) { setError(failure.message); }
  };

  if (booting) return <div className="boot-screen"><Brand /><Spinner label="Открываем рабочий кабинет…" /></div>;
  if (sessionError && !session) return <div className="boot-screen"><Brand /><ErrorNotice message={sessionError} retry={getSession} /></div>;
  if (!user) return <Login demoLoginAvailable={session?.demoLoginAvailable === true} onLogin={data => { acceptSession(data); setVersion(value => value + 1); setRegion(''); setSearch(''); navigate(hashPage() === 'microphones' && hasMicrophoneAccess(data.user) ? 'microphones' : hashPage() === 'monitoring' ? 'monitoring' : 'overview'); }} />;

  const allowedNavigation = navigation.filter(item => (!item.manage || mayManage) && (!item.microphones || hasMicrophoneAccess(user)));
  const activePage = allowedNavigation.some(item => item.id === page) ? page : 'overview';
  const isMicrophones = activePage === 'microphones';
  const isMonitoring = activePage === 'monitoring';
  const maxStreams = session?.liveLimits?.maxStreams || 1;
  const isVideoWorkspace = ['overview', 'cameras', 'events'].includes(activePage);
  const view = presentWorkspace(stations, cameras, events, dataMode);
  const stationDetail = view.stations.find(station => station.id === selectedStation);
  const cameraDetail = view.cameras.find(camera => camera.id === selectedCamera);
  const openCamera = (camera, mode) => { setSelectedStation(null); setCameraEventRequest(null); setCameraMode(mode); setSelectedCamera(camera.id); };
  const openEventRecord = event => { setSelectedStation(null); setCameraEventRequest({ ...event, date, key: `${event.id}-${Date.now()}` }); setSelectedCamera(event.cameraId); };
  const changeMode = mode => {
    if (mode === dataMode) return;
    setSelectedStation(null); setSelectedCamera(null); setCameraEventRequest(null);
    if (mode === 'demo') { realDate.current = date; setDate(session.demoDate || '2026-10-30'); }
    else setDate(realDate.current);
    setDataMode(mode);
  };
  const overviewTitle = user.role === 'regional' ? 'Мои ПТО' : user.role === 'director' ? 'Моя зона ответственности' : pageTitles.overview;

  return <div className="app-shell">
    {menuOpen && <button className="mobile-scrim" onClick={() => setMenuOpen(false)} aria-label="Закрыть меню" />}
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}><div className="sidebar-brand"><Brand light /><button className="icon-button mobile-close" onClick={() => setMenuOpen(false)} aria-label="Закрыть меню"><X size={20} /></button></div>
      <div className="workspace-label"><span className="workspace-avatar"><Building2 size={18} /></span><div><strong>{user.role === 'admin' ? 'Сеть Экосмотр' : 'Моя зона доступа'}</strong><span>{view.stations.length} ПТО в доступе</span></div></div>
      <nav aria-label="Главная навигация">{allowedNavigation.map(item => <a key={item.id} href={`#${item.id}`} className={activePage === item.id ? 'nav-link active' : 'nav-link'} aria-current={activePage === item.id ? 'page' : undefined} onClick={() => setMenuOpen(false)}><item.icon size={19} strokeWidth={1.65} /><span>{item.id === 'overview' ? user.role === 'regional' ? 'Мои ПТО' : user.role === 'director' ? 'Моя зона' : item.label : item.label}</span>{item.id === 'cameras' && <span className="nav-count">{view.cameras.length}</span>}</a>)}</nav>
      <div className="sidebar-bottom"><div className="pilot-sidebar"><span className="pilot-dot" /><div><strong>Пилотный контур</strong><span>Локальная версия сервиса</span></div></div><div className="profile"><span className="profile-avatar">{initials(user.name)}</span><div className="profile-text"><strong>{user.name}</strong><span>{roleNames[user.role]}</span></div><button className="icon-button logout" onClick={logout} aria-label="Выйти из сервиса"><LogOut size={17} /></button></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="topbar-start"><button className="icon-button mobile-menu" aria-label="Открыть меню" onClick={() => setMenuOpen(true)}><Menu size={22} /></button><span>Сеть ПТО</span><span className="breadcrumb-separator">/</span><strong>{isMicrophones ? 'Микрофоны' : 'Видеоаналитика'}</strong></div><div className="topbar-right"><span className="environment-mark"><span />Пилот</span><span className="topbar-role"><ShieldCheck size={15} />{roleNames[user.role]}</span></div></header>
      <main className="main-content"><div className="page-header"><div><h1>{activePage === 'overview' ? overviewTitle : pageTitles[activePage]}</h1><p>{pageDescriptions[activePage]}</p></div>{(isVideoWorkspace || isMonitoring) && <div className="page-actions">{isVideoWorkspace && activePage !== 'cameras' && <label className="date-control"><CalendarDays size={17} /><span className="sr-only">Дата анализа</span><input type="date" aria-label="Дата анализа" value={date} onChange={event => event.target.value && setDate(event.target.value)} /></label>}<button className="icon-button refresh-button" onClick={() => setVersion(value => value + 1)} aria-label="Обновить данные" disabled={loading}><RefreshCw size={18} className={loading ? 'spin' : ''} /></button></div>}</div>
        {isVideoWorkspace && <div className="data-mode-control"><div className="segmented" role="group" aria-label="Источник данных"><button type="button" className={dataMode === 'real' ? 'selected' : ''} aria-pressed={dataMode === 'real'} onClick={() => changeMode('real')}>Рабочие данные</button><button type="button" className={dataMode === 'demo' ? 'selected' : ''} aria-pressed={dataMode === 'demo'} onClick={() => changeMode('demo')}>Пример данных</button></div><p>{dataMode === 'demo' ? 'Учебные события за 30.10.2026. Это пример интерфейса, а не результаты работы ПТО.' : 'Реальные камеры и полученные результаты. Метрики фрагмента не равны итогу дня; привязки по названиям требуют проверки.'}</p></div>}
        {!isMicrophones && <ErrorNotice message={error} retry={() => setVersion(value => value + 1)} />}
        {activePage === 'overview' && <Overview {...view} {...{ loading, region, setRegion, search, setSearch, date, dataMode }} currentUser={user} onStation={setSelectedStation} onNavigate={navigate} />}
        {activePage === 'cameras' && <Cameras {...view} {...{ loading, dataMode }} onCamera={openCamera} />}
        {isMonitoring && <Monitoring key={`monitoring-${sessionEpoch}`} {...{ cameras, stations, user, loading, catalogReady, maxStreams }} />}
        {isMicrophones && <Microphones key={`microphones-${sessionEpoch}`} />}
        {activePage === 'events' && <Events {...view} {...{ loading, date, dataMode }} onStation={setSelectedStation} onRecord={openEventRecord} />}
        {activePage === 'users' && <Users key={`users-${sessionEpoch}`} currentUser={user} {...{ stations, cameras, refreshSession }} onNotice={setNotice} />}
        {activePage === 'audit' && <Audit key={`audit-${sessionEpoch}`} />}
        <footer className="app-footer"><span>Экосмотр · {isMicrophones ? 'Микрофоны' : 'Видеоаналитика'}</span>{!isMicrophones && <span>Нет данных ≠ станция закрыта</span>}</footer>
      </main>
    </div>
    {stationDetail && <StationDetail key={stationDetail.id} station={stationDetail} cameras={view.cameras} events={view.events} date={date} maxStreams={maxStreams} onClose={() => setSelectedStation(null)} onCamera={openCamera} />}
    {cameraDetail && <CameraDetail key={`${cameraDetail.id}:${cameraEventRequest?.key || cameraMode || ''}`} camera={cameraDetail} station={view.stations.find(station => station.id === cameraDetail.stationId)} events={view.events} date={date} maxStreams={maxStreams} initialMode={cameraEventRequest ? 'archive' : cameraMode} initialEventRequest={cameraEventRequest} onClose={() => { setSelectedCamera(null); setCameraEventRequest(null); }} />}
    {notice && <div className="toast" role="status"><CheckCircle2 size={18} />{notice}</div>}
  </div>;
}
