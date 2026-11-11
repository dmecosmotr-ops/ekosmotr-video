import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server, Monitoring;
const previousStorage = globalThis.localStorage;
const values = new Map();
before(async () => {
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  server = await createServer({ root: fileURLToPath(new URL('.', import.meta.url)), configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  ({ default: Monitoring } = await server.ssrLoadModule('/src/MonitoringScreen.jsx'));
});
after(async () => { globalThis.localStorage = previousStorage; await server?.close(); });

const stations = [{ id: 'pto-a', city: 'Примерск', address: 'Примерск, ул. Учебная, 42/2', region: 'Учебный регион' }];
const cameras = [{ id: 'camera-a', name: 'Учебная бокс', stationId: 'pto-a', liveAvailable: true }, { id: 'camera-b', name: 'Северный бокс', liveAvailable: true }];
const render = props => renderToStaticMarkup(React.createElement(Monitoring, { cameras, stations, user: { id: 'admin' }, catalogReady: true, maxStreams: 5, ...props }));

test('a new monitoring set renders selection and requires an explicit start, with no video element', () => {
  values.clear();
  const html = render();
  assert.match(html, /Какие камеры показать/);
  assert.match(html, /Примерск · ул. Учебная, 42\/2/);
  assert.match(html, /Адрес не подтверждён/);
  assert.match(html, /Выбрано 0 · В эфире 0 · До 5 одновременно/);
  assert.doesNotMatch(html, /<video/);
  assert.match(html, /Запустить все/);
  assert.match(html, /aria-label="Развернуть мониторинг на весь экран"/);
  assert.match(html, /Создать стол/);
  assert.match(html, /Снять все/);
  assert.doesNotMatch(html, /<option[^>]*>Основной|aria-label="Рабочий стол"/);
});

test('a saved set renders separate stopped players and removes a revoked camera before rendering', () => {
  values.set('ekosmotr.monitoring.v1.admin', JSON.stringify(['camera-b', 'revoked', 'camera-a']));
  const html = render();
  assert.match(html, /Выбрано 2 · В эфире 0 · До 5 одновременно/);
  assert.equal((html.match(/aria-label="Окно камеры:/g) || []).length, 2);
  assert.equal((html.match(/aria-label="Начать просмотр"/g) || []).length, 2);
  assert.doesNotMatch(html, /revoked|<video/);
});

test('a lower playback limit leaves both saved windows selected and describes the next start', () => {
  values.set('ekosmotr.monitoring.v1.admin', JSON.stringify(['camera-a', 'camera-b']));
  const html = render({ maxStreams: 1 });
  assert.match(html, /Выбрано 2 · В эфире 0 · До 1 одновременно/);
  assert.match(html, /Запустить 1 из 2/);
  assert.equal((html.match(/aria-label="Окно камеры:/g) || []).length, 2);
});

test('only the active named desk renders camera players without autoplay', () => {
  values.set('ekosmotr.monitoring.desks.v2.admin', JSON.stringify({ activeId: 'second', desks: [
    { id: 'first', name: 'Работа с клиентами', cameraIds: ['camera-a'] },
    { id: 'second', name: 'Северный', cameraIds: ['camera-b'] },
  ], draftCameraIds: [] }));
  const html = render();
  assert.match(html, /Работа с клиентами/);
  assert.match(html, /Окно камеры: Северный бокс/);
  assert.doesNotMatch(html, /Окно камеры: Учебная бокс|<video/);
});
