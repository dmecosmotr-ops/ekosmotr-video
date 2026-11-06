import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server, VehicleVisits, RecordingAction, Events, EventGroups;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('.', import.meta.url)), configFile: false, server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
  ({ VehicleVisits, default: EventGroups } = await server.ssrLoadModule('/src/EventGroups.jsx'));
  ({ default: RecordingAction } = await server.ssrLoadModule('/src/RecordingAction.jsx'));
  ({ default: Events } = await server.ssrLoadModule('/src/EventsScreen.jsx'));
});
after(async () => { await server?.close(); });

const pair = [
  { id: 'entry', type: 'vehicle_entry', stationId: 's', cameraId: 'c', visitId: 'v', time: '08:00', label: 'Въезд автомобиля' },
  { id: 'exit', type: 'vehicle_exit', stationId: 's', cameraId: 'c', visitId: 'v', time: '08:15', label: 'Выезд автомобиля' },
];

test('a paired visit renders a separate recording action for entry and exit', () => {
  const html = renderToStaticMarkup(React.createElement(VehicleVisits, { events: pair, date: '2026-10-30', cameras: [{ id: 'c', archiveAvailable: true }], onRecord() {}, analysisSource: 'demo' }));
  assert.match(html, /aria-label="Посмотреть момент: Въезд автомобиля, 08:00:00"/);
  assert.match(html, /aria-label="Посмотреть момент: Выезд автомобиля, 08:15:00"/);
  assert.equal((html.match(/<button/g) || []).length, 2);
});

test('a live camera without an archive renders no recording button', () => {
  const html = renderToStaticMarkup(React.createElement(RecordingAction, { event: pair[0], camera: { id: 'c', liveAvailable: true, archiveAvailable: false }, onRecord() {} }));
  assert.match(html, /Запись пока недоступна/);
  assert.doesNotMatch(html, /<button|<a /);
});

test('the default metric view renders a permitted station without analysis', () => {
  const html = renderToStaticMarkup(React.createElement(Events, { stations: [{ id: 's', city: 'Бийск', address: 'Перевозный, 7', metrics: { source: 'none' } }], events: [], cameras: [], date: '2026-11-05' }));
  assert.match(html, /Бийск · Перевозный, 7/);
  assert.match(html, /Видео ещё не анализировалось/);
  assert.doesNotMatch(html, /За обработанный период отметки не найдены/);
});

test('station details count primary camera only while a secondary camera keeps its own observations', () => {
  const events = [{ ...pair[0], source: 'analysis', cameraId: 'primary' }, { ...pair[0], id: 'secondary-entry', source: 'analysis', cameraId: 'secondary' }];
  const cameras = [{ id: 'primary', primary: true }, { id: 'secondary', primary: false }];
  const html = renderToStaticMarkup(React.createElement(EventGroups, { stationScope: true, events, cameras, date: '2026-11-05', analysisSource: { source: 'analysis' } }));
  assert.match(html, /Наблюдаемые въезды <strong>1<\/strong>/);
  assert.doesNotMatch(html, /Наблюдаемые въезды <strong>2<\/strong>/);
  const secondary = renderToStaticMarkup(React.createElement(EventGroups, { events: [events[1]], cameras: [cameras[1]], date: '2026-11-05', analysisSource: { source: 'analysis' } }));
  assert.match(secondary, /Наблюдаемые въезды <strong>1<\/strong>/);
});
