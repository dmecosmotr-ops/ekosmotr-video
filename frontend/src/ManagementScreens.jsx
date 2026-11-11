import React, { useEffect, useMemo, useState } from 'react';
import { Check, Plus, Search, ShieldCheck, UsersRound } from 'lucide-react';
import { api } from './api.js';
import { buildUserMutation } from './userMutation.js';
import { formatAuditDetails } from './auditDetails.js';
import { address, Badge, Empty, ErrorNotice, initials, matches, Modal, roleNames, Spinner } from './components.jsx';
import {
  actionNames, auditActorKey, auditPersonLabel, buildAccessTree, canGrantCamera,
  canGrantStation, describeAccess, filterAuditItems, roleDescriptions,
} from './managementPresentation.js';
import './management.css';

function AccessContents({ summary, saving = false }) {
  if (summary.all) return <p className="management-all-access">Вся сеть: все ПТО и камеры, управление пользователями и доступами.</p>;
  return <>
    {summary.fullStations.length > 0 && <ul className="management-address-list">{summary.fullStations.map((station, index) => <li key={index}><strong>{station.label}</strong><span>ПТО целиком, включая его камеры</span></li>)}</ul>}
    {summary.cameraGroups.length > 0 && <ul className="management-address-list">{summary.cameraGroups.map((group, index) => <li key={index}><strong>{group.label}</strong><span>Только выбранные камеры: {group.cameras.map(camera => camera.name).join(', ')}</span></li>)}</ul>}
    {!summary.fullStations.length && !summary.cameraGroups.length && !summary.hasUnavailable && <p>Доступ к ПТО и камерам не назначен.</p>}
    {summary.hasUnavailable && <p className="management-unavailable">Часть назначений нельзя показать в пределах вашего доступа. {saving ? 'Эти назначения сохранятся без изменений.' : 'Адреса или камеры недоступны для просмотра.'}</p>}
  </>;
}

const accessCount = summary => `ПТО целиком: ${summary.fullStations.length} · Отдельных камер: ${summary.individualCameraCount}`;

function UserAccess({ user, stations, cameras, showMicrophones }) {
  const summary = describeAccess(user, stations, cameras);
  const microphoneCount = user.microphoneStationIds?.length || 0;
  return <>{summary.all ? <span>Вся сеть</span> : <details className="management-user-access"><summary><span>{accessCount(summary)}</span><span className="management-disclosure-label">Показать адреса{summary.hasUnavailable ? ' и ограничения' : ''}</span></summary><div className="management-user-access-content"><AccessContents summary={summary} /></div></details>}
    {showMicrophones && <small className="management-microphone-count">Микрофоны · {microphoneCount ? `${microphoneCount} ПТО` : 'доступа нет'}</small>}
  </>;
}

function MicrophoneAccessEditor({ stations, stationIds, assignedIds, role, disabled, onToggle, onClearUnavailable }) {
  const [search, setSearch] = useState('');
  const eligibleIds = new Set(stationIds);
  const assigned = new Set(assignedIds);
  const knownIds = new Set(stations.map(station => station.id));
  const unavailableCount = assignedIds.filter(id => !knownIds.has(id)).length;
  const options = stations.filter(station => (role === 'admin' || eligibleIds.has(station.id) || assigned.has(station.id)) &&
    matches([station.city, station.address, station.region], search));
  return <section className="access-editor management-access-editor" aria-labelledby="management-microphone-title">
    <div className="access-title"><h3 id="management-microphone-title">Доступ к разделу «Микрофоны»</h3></div>
    <p className="access-explanation">Назначается отдельно для каждого ПТО. Для директора и регионального руководителя сначала выберите «ПТО целиком» в разделе выше.</p>
    <div className="access-toolbar"><label className="search-field management-access-search"><Search size={16} /><span className="sr-only">Поиск ПТО для микрофонов</span><input type="search" placeholder="Город, адрес или регион…" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
    <div className="management-access-tree management-microphone-list">
      {options.length ? options.map(station => {
        const selected = assigned.has(station.id);
        const eligible = role === 'admin' || eligibleIds.has(station.id);
        return <label className={`management-access-choice ${selected ? 'is-selected' : ''}`} key={station.id}>
          <input type="checkbox" checked={selected} disabled={disabled} onChange={() => onToggle(station.id)} />
          <span><strong>{station.city} · {address(station)}</strong><small>{station.region}{!eligible && ' · Доступ приостановлен до назначения ПТО целиком'}</small></span>{selected && <Check size={16} />}
        </label>;
      }) : <p className="access-no-match">{search.trim() ? 'Подходящие ПТО не найдены.' : 'Доступных для назначения ПТО пока нет.'}</p>}
    </div>
    {unavailableCount > 0 && <div className="access-explanation"><p>Назначения для ПТО, которых нет в справочнике: {unavailableCount}. Сейчас они не дают доступа.</p><button type="button" className="button button-small" disabled={disabled} onClick={onClearUnavailable}>Снять эти назначения</button></div>}
  </section>;
}

export function UserEditor({ currentUser, target, stations = [], cameras = [], onClose, onSaved }) {
  const [form, setForm] = useState({ name: target?.name || '', email: target?.email || '', password: '', role: target?.role || 'regional', active: target?.active ?? true });
  // Search, role selection and rendering never rewrite existing grants.
  const [stationIds, setStationIds] = useState(() => [...(target?.stationIds || [])]);
  const [cameraIds, setCameraIds] = useState(() => [...(target?.cameraIds || [])]);
  const [microphoneStationIds, setMicrophoneStationIds] = useState(() => [...(target?.assignedMicrophoneStationIds ?? target?.microphoneStationIds ?? [])]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key, value) => setForm(previous => ({ ...previous, [key]: value }));
  const toggle = (setter, id) => setter(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]);
  const tree = useMemo(() => buildAccessTree(stations, cameras, search), [stations, cameras, search]);
  const summary = useMemo(() => describeAccess({ role: form.role, stationIds, cameraIds }, stations, cameras), [form.role, stationIds, cameraIds, stations, cameras]);
  const mayManageMicrophones = currentUser.role === 'admin';
  const existingMicGrants = target?.assignedMicrophoneStationIds ?? target?.microphoneStationIds ?? [];
  const microphoneIdsToSave = form.role === 'admin' ? microphoneStationIds : microphoneStationIds.filter(id => stationIds.includes(id) || existingMicGrants.includes(id));
  const knownStationIds = new Set(stations.map(station => station.id));
  const effectiveMicrophoneCount = microphoneIdsToSave.filter(id => knownStationIds.has(id) && (form.role === 'admin' || stationIds.includes(id))).length;
  const save = async event => {
    event.preventDefault(); setError(''); setBusy(true);
    const body = buildUserMutation(target, form, stationIds, cameraIds, mayManageMicrophones ? microphoneIdsToSave : undefined);
    if (target && Object.keys(body).length === 0) { setBusy(false); onClose(); return; }
    try {
      await api(target ? `/users/${encodeURIComponent(target.id)}` : '/users', { method: target ? 'PATCH' : 'POST', body });
      await onSaved(); onClose();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <Modal title={target ? 'Настроить доступ' : 'Добавить пользователя'} subtitle="Выберите роль и проверьте адреса перед сохранением" onClose={onClose} wide>
    <form onSubmit={save} className="user-editor management-editor">
      <div className="user-editor-fields">
        <label>Имя и фамилия<input required value={form.name} onChange={event => set('name', event.target.value)} autoComplete="name" placeholder="Как обращаться к пользователю" /></label>
        <label>Электронная почта<input type="email" required value={form.email} onChange={event => set('email', event.target.value)} autoComplete="off" spellCheck="false" /></label>
        <label>{target ? 'Новый пароль' : 'Пароль'}<input type="password" required={!target} minLength={10} value={form.password} onChange={event => set('password', event.target.value)} autoComplete="new-password" placeholder={target ? 'Оставьте пустым, чтобы не менять' : 'Не менее 10 символов'} /></label>
        <label>Роль<select value={form.role} onChange={event => set('role', event.target.value)} aria-describedby="management-role-description">{(currentUser.role === 'admin' ? ['regional', 'director', 'admin'] : ['regional']).map(role => <option key={role} value={role}>{roleNames[role]}</option>)}</select><span id="management-role-description" className="management-role-description">{roleDescriptions[form.role]}</span></label>
      </div>
      {target && <label className="checkbox-inline user-active"><input type="checkbox" checked={form.active} onChange={event => set('active', event.target.checked)} />Учётная запись активна</label>}
      {form.role !== 'admin' && <section className="access-editor management-access-editor" aria-labelledby="management-access-title">
        <div className="access-title"><h3 id="management-access-title">Доступ к ПТО и камерам</h3></div>
        <p className="access-explanation">Раскройте адрес и выберите ПТО целиком или отдельные камеры. Доступ к ПТО включает его камеры. Поиск только сужает список и не меняет выбранные права.</p>
        <div className="access-toolbar"><label className="search-field management-access-search"><Search size={16} /><span className="sr-only">Поиск объектов доступа</span><input type="search" placeholder="Город, адрес, руководитель или камера…" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
        <div className="management-access-tree">
          {!tree.length ? <p className="access-no-match">Объекты не найдены. Выбранные права сохранены; измените поиск.</p> : tree.map(group => <details className="management-access-group" key={group.key} open>
            <summary><strong>{group.manager}</strong><span>{group.region}</span></summary>
            <div className="management-access-nodes">{group.nodes.map(node => {
              const full = node.station && stationIds.includes(node.station.id);
              const allowedFull = node.station && canGrantStation(currentUser, node.station.id);
              return <details className="management-station-node" key={node.key} open={Boolean(search.trim())}>
                <summary><span>{node.label}</span>{node.station && !allowedFull && <small>Только отдельные камеры</small>}</summary>
                {node.station && <label className={`management-access-choice management-whole-station ${full ? 'is-selected' : ''}`}>
                  <input type="checkbox" checked={Boolean(full)} disabled={!allowedFull || busy} onChange={() => toggle(setStationIds, node.station.id)} />
                  <span><strong>ПТО целиком</strong><small>{allowedFull ? 'Включая камеры этого ПТО' : 'Вы можете назначать только камеры из своего доступа'}</small></span>{full && <Check size={16} />}
                </label>}
                <div className="management-camera-choices">{!node.cameras.length ? <p className="management-no-cameras">В доступном списке нет камер{search.trim() ? ', подходящих под поиск' : ''}.</p> : node.cameras.map(camera => {
                  const allowed = canGrantCamera(currentUser, camera);
                  return <label className={`management-access-choice ${full ? 'is-inherited' : ''}`} key={camera.id}>
                    <input type="checkbox" checked={Boolean(full || cameraIds.includes(camera.id))} disabled={Boolean(full) || !allowed || busy} onChange={() => toggle(setCameraIds, camera.id)} />
                    <span><strong>{camera.name || 'Название камеры не указано'}</strong><small>{full ? 'Через доступ к ПТО' : !camera.stationId ? 'Непривязанные камеры доступны только администратору' : allowed ? 'Отдельная камера' : 'Назначение недоступно'}</small></span>
                  </label>;
                })}</div>
              </details>;
            })}</div>
          </details>)}
        </div>
        {currentUser.role === 'director' && <p className="permission-caption"><ShieldCheck size={14} />Назначаются только ПТО целиком и камеры из вашего доступа.</p>}
      </section>}
      {mayManageMicrophones && <MicrophoneAccessEditor stations={stations} stationIds={stationIds} assignedIds={microphoneStationIds} role={form.role} disabled={busy} onToggle={id => toggle(setMicrophoneStationIds, id)} onClearUnavailable={() => setMicrophoneStationIds(previous => previous.filter(id => knownStationIds.has(id)))} />}
      <section className="management-access-preview" aria-labelledby="management-preview-title"><h3 id="management-preview-title">Пользователь увидит</h3>{!summary.all && <p className="management-preview-count">{accessCount(summary)}{summary.hasUnavailable ? ' в доступном списке' : ''}</p>}<AccessContents summary={summary} saving />{mayManageMicrophones && <p className="management-preview-count">Микрофоны · {effectiveMicrophoneCount ? `${effectiveMicrophoneCount} ПТО` : 'доступа нет'}</p>}{!form.active && <p className="management-unavailable">Учётная запись отключена: войти в сервис нельзя.</p>}</section>
      <div className="editor-footer"><ErrorNotice message={error} /><div className="editor-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>Отмена</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Сохраняем…' : target ? 'Сохранить доступ' : 'Создать пользователя'}</button></div></div>
    </form>
  </Modal>;
}

export function Users({ currentUser, stations = [], cameras = [], refreshSession, onNotice }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState(null);
  const [search, setSearch] = useState('');
  const load = async () => {
    setLoading(true); setError('');
    try { const data = await api('/users'); setUsers(data.users || []); }
    catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const saved = async () => { await load(); await refreshSession(); onNotice('Права доступа сохранены'); };
  const filtered = users.filter(user => matches([user.name, user.email, roleNames[user.role]], search));
  return <><section className="data-section management-users"><div className="section-heading"><div><h2>{currentUser.role === 'admin' ? 'Пользователи сервиса' : 'Региональные руководители'}</h2><p>{currentUser.role === 'admin' ? 'Роли и доступ к конкретным адресам и камерам' : 'Выдавайте доступ в пределах своих полномочий'}</p></div><button className="button button-primary" onClick={() => setEditor({})}><Plus size={17} />Добавить пользователя</button></div>
    <div className="filter-bar"><label className="search-field"><Search size={18} /><span className="sr-only">Найти пользователя</span><input type="search" placeholder="Имя, почта или роль…" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
    <ErrorNotice message={error} retry={load} />
    {loading ? <Spinner /> : !filtered.length ? <Empty title={search.trim() ? 'Пользователи не найдены' : 'Пользователей пока нет'} description={search.trim() ? 'Измените поисковый запрос.' : 'Создайте учётную запись и назначьте ей ПТО или камеры.'} icon={UsersRound} /> : <div className="table-scroll"><table className="users-table"><thead><tr><th>Пользователь</th><th>Роль</th><th>Доступ</th><th>Статус</th><th /></tr></thead><tbody>{filtered.map(user => <tr key={user.id}>
      <td><div className="user-cell"><span className="avatar">{initials(user.name)}</span><div><strong>{user.name}{user.id === currentUser.id && <span className="you-label">вы</span>}</strong><span>{user.email}</span></div></div></td>
      <td><Badge kind={user.role === 'admin' ? 'teal' : 'neutral'}>{roleNames[user.role]}</Badge></td>
      <td><UserAccess user={user} stations={stations} cameras={cameras} showMicrophones={currentUser.role === 'admin'} /></td><td><Badge kind={user.active ? 'green' : 'neutral'} dot>{user.active ? 'Активен' : 'Отключён'}</Badge></td>
      <td><button className="button button-small" onClick={() => setEditor(user)}>Настроить доступ</button></td>
    </tr>)}</tbody></table></div>}
  </section>{editor && <UserEditor currentUser={currentUser} target={editor.id ? editor : null} stations={stations} cameras={cameras} onClose={() => setEditor(null)} onSaved={saved} />}</>;
}

export function Audit() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ from: '', to: '', actor: '', category: '' });
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const dateFormat = useMemo(() => new Intl.DateTimeFormat('ru-RU', { year: 'numeric', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone }), [timeZone]);
  const load = async () => {
    setLoading(true); setError('');
    try { const data = await api('/audit'); setItems(data.events || []); }
    catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const filtered = useMemo(() => filterAuditItems(items, filters, timeZone), [items, filters, timeZone]);
  const people = useMemo(() => {
    const actors = new Map();
    for (const item of items) { const key = auditActorKey(item.actor); if (key) actors.set(key, auditPersonLabel(item.actor)); }
    return [...actors.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  }, [items]);
  const setFilter = (key, value) => setFilters(previous => ({ ...previous, [key]: value }));
  const invalidRange = filters.from && filters.to && filters.from > filters.to;
  const hasFilters = Object.values(filters).some(Boolean);
  const formatDate = value => { const parsed = new Date(value); return Number.isNaN(parsed.valueOf()) ? 'Время не указано' : dateFormat.format(parsed); };
  return <section className="data-section management-audit" aria-label="Действия пользователей">
    <div className="section-heading management-audit-heading"><p>Входы в сервис, изменения доступа и просмотры видео</p><button className="button button-small" onClick={load} disabled={loading}>Обновить</button></div>
    <div className="management-audit-filters"><label>С даты<input type="date" value={filters.from} max={filters.to || undefined} onChange={event => setFilter('from', event.target.value)} /></label><label>По дату<input type="date" value={filters.to} min={filters.from || undefined} onChange={event => setFilter('to', event.target.value)} /></label><label>Человек<select value={filters.actor} onChange={event => setFilter('actor', event.target.value)}><option value="">Все пользователи</option>{filters.actor && !people.some(([key]) => key === filters.actor) && <option value={filters.actor}>Выбранный пользователь отсутствует в загруженных записях</option>}{people.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Категория<select value={filters.category} onChange={event => setFilter('category', event.target.value)}><option value="">Все действия</option><option value="access">Доступы</option><option value="auth">Входы</option><option value="view">Просмотры</option></select></label>{hasFilters && <button className="button button-small" type="button" onClick={() => setFilters({ from: '', to: '', actor: '', category: '' })}>Сбросить</button>}</div>
    <p className="management-audit-note">Часовой пояс браузера: <strong>{timeZone || 'местный'}</strong>. Даты фильтров и время записей указаны в этом поясе.</p>
    <p className="management-audit-note">Фильтры действуют на последние загруженные записи (не более 300). Полная история здесь не загружается.{!loading && ` Найдено: ${filtered.length} из ${items.length}.`}</p>
    {invalidRange && <p className="management-range-error" role="alert">Дата окончания должна быть не раньше даты начала.</p>}
    <ErrorNotice message={error} retry={load} />
    {loading ? <Spinner /> : !filtered.length ? <Empty title={hasFilters ? 'Действий с такими условиями не найдено' : 'В журнале пока нет действий'} description={hasFilters ? 'Измените фильтры. Более старые действия могут не входить в загруженный список.' : 'Новые входы, изменения доступа и просмотры появятся здесь.'} icon={ShieldCheck} /> : <div className="table-scroll"><table className="audit-table"><thead><tr><th>Дата и время</th><th>Кто</th><th>Действие</th><th>Объект и подробности</th></tr></thead><tbody>{filtered.map(item => <tr key={item.id}><td className="time-cell">{formatDate(item.at)}</td><td>{auditPersonLabel(item.actor)}</td><td>{actionNames[item.action] || item.action || 'Действие не указано'}</td><td><strong>{auditPersonLabel(item.target)}</strong><span className="audit-details">{formatAuditDetails(item.details)}</span></td></tr>)}</tbody></table></div>}
  </section>;
}
