import React, { useState } from 'react';
import { ArrowDownLeft, ArrowRight, DoorOpen, Eye, EyeOff, ListFilter, LockKeyhole, Search, ShieldCheck, UserRound } from 'lucide-react';
import { api } from './api.js';
import { Badge, ErrorNotice, roleNames } from './components.jsx';

const accounts = {
  admin: { email: 'admin@ekosmotr.local', password: 'Pilot-Admin-2026!' },
  director: { email: 'director@ekosmotr.local', password: 'Pilot-Director-2026!' },
  regional: { email: 'regional@ekosmotr.local', password: 'Pilot-Region-2026!' },
};

export function Brand({ light = false }) {
  return <div className={`brand ${light ? 'brand-light' : ''}`}><div className="brand-mark"><span /><span /><span /></div><div><strong>экосмотр</strong><span>видеоаналитика</span></div></div>;
}

export function Login({ onLogin, demoLoginAvailable = false }) {
  const [email, setEmail] = useState(demoLoginAvailable ? accounts.admin.email : '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault(); setError(''); setBusy(true);
    try { onLogin(await api('/login', { method: 'POST', body: { email, password } })); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <main className="login-page">
    <aside className="login-aside"><Brand light /><div className="login-intro"><div className="login-line" /><h1>Вся сеть.<br />Под вашим<br />наблюдением.</h1><p>Рабочий кабинет для станций, камер<br className="desktop-break" /> и событий рабочего дня.</p><div className="login-points"><span><DoorOpen size={19} />Открытие и закрытие станций</span><span><UserRound size={19} />Первое появление в кадре</span><span><ArrowDownLeft size={19} />Счётчик въездов в бокс</span></div></div><div className="login-aside-footer"><span>Экосмотр · внутренний сервис</span><Badge kind="nav">Пилот</Badge></div></aside>
    <section className="login-main"><div className="login-mobile-brand"><Brand /></div><div className="login-form-wrap"><div className="login-icon"><LockKeyhole size={24} /></div><h2>Вход в сервис</h2><p className="login-lead">Доступ к станциям определяется вашей ролью.</p>
      <form onSubmit={submit} className="login-form"><label htmlFor="login-email">Электронная почта<input id="login-email" type="email" autoComplete="username" spellCheck="false" required value={email} onChange={event => setEmail(event.target.value)} /></label><label htmlFor="login-password">Пароль<div className="password-input"><input id="login-password" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /><button type="button" className="icon-button" aria-label={show ? 'Скрыть пароль' : 'Показать пароль'} onClick={() => setShow(!show)}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label><ErrorNotice message={error} /><button className="button button-primary login-submit" disabled={busy}>{busy ? 'Входим…' : 'Войти'}<ArrowRight size={18} /></button></form>
      {demoLoginAvailable && <div className="demo-login"><div className="demo-login-heading">Проверить пилот в роли</div><div className="demo-role-buttons">{Object.keys(accounts).map(role => <button type="button" key={role} className="button button-small" onClick={() => { setEmail(accounts[role].email); setPassword(accounts[role].password); setError(''); }}>{role === 'regional' ? 'Регионал' : roleNames[role]}</button>)}</div><p>Это локальные тестовые учётные записи. Данные входа Xiaomi здесь не используются.</p></div>}
    </div><footer className="login-footer"><ShieldCheck size={15} />Доступ только к назначенным станциям и камерам</footer></section>
  </main>;
}

export function Filters({ region, setRegion, regions, search, setSearch, placeholder = 'Город, адрес или руководитель…' }) {
  return <div className="filter-bar"><label className="search-field"><Search size={18} /><span className="sr-only">Поиск</span><input type="search" placeholder={placeholder} value={search} onChange={event => setSearch(event.target.value)} /></label><label className="select-field"><ListFilter size={16} /><span className="sr-only">Регион</span><select aria-label="Регион" value={region} onChange={event => setRegion(event.target.value)}><option value="">Все регионы</option>{regions.map(item => <option key={item} value={item}>{item}</option>)}</select></label></div>;
}
