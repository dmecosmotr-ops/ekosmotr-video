import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAccessTree, describeAccess, canGrantStation, canGrantCamera,
  filterAuditItems, auditCategory, auditDateKey,
} from './src/managementPresentation.js';
import { buildUserMutation } from './src/userMutation.js';

const stations = [
  { id: 's1', city: 'Бийск', address: 'Бийск, Перевозный 7', manager: 'Мария', region: 'Алтай' , cameraCount: 99 },
  { id: 's2', city: 'Омск', address: 'Лесная 2', manager: 'Алексей', region: 'Омская область' },
];
const cameras = [
  { id: 'c1', stationId: 's1', name: 'Бокс', model: 'A' },
  { id: 'c2', stationId: 's1', name: 'Въезд', model: 'B' },
  { id: 'c3', stationId: 's2', name: 'Клиентская зона', model: 'A' },
];

test('access tree groups allowed addresses and cameras without using total cameraCount', () => {
  const tree = buildAccessTree(stations, [cameras[0]]);
  assert.deepEqual(tree.map(group => group.nodes.map(node => [node.label, node.cameras.length])).flat(), [
    ['Омск · Лесная 2', 0], ['Бийск · Перевозный 7', 1],
  ]);
  assert.equal(JSON.stringify(tree).includes('cameraCount'), false);
});

test('search keeps parent address when matching its camera and does not change the input', () => {
  const stationSnapshot = JSON.stringify(stations);
  const cameraSnapshot = JSON.stringify(cameras);
  const tree = buildAccessTree(stations, cameras, 'Въезд');
  assert.equal(tree.length, 1);
  assert.equal(tree[0].nodes[0].station.id, 's1');
  assert.deepEqual(tree[0].nodes[0].cameras.map(camera => camera.id), ['c2']);
  assert.deepEqual(buildAccessTree(stations, cameras, 'ничего не существует'), []);
  assert.equal(JSON.stringify(stations), stationSnapshot);
  assert.equal(JSON.stringify(cameras), cameraSnapshot);
});

test('director with a single camera cannot grant its whole station or another camera', () => {
  const director = { role: 'director', stationIds: [], cameraIds: ['c1'] };
  assert.equal(canGrantStation(director, 's1'), false);
  assert.equal(canGrantCamera(director, cameras[0]), true);
  assert.equal(canGrantCamera(director, cameras[1]), false);
  assert.equal(canGrantCamera(director, { id: 'orphan', stationId: null }), false);
  assert.equal(canGrantStation({ ...director, stationIds: ['s1'] }, 's1'), true);
  assert.equal(canGrantCamera({ ...director, stationIds: ['s1'] }, cameras[1]), true);
  assert.equal(canGrantStation({ role: 'regional', stationIds: ['s1'] }, 's1'), false);
  assert.equal(canGrantStation({ role: 'admin' }, 's1'), true);
});

test('summary counts only individual cameras outside full stations and resolves exact addresses', () => {
  const summary = describeAccess({ role: 'regional', stationIds: ['s1', 's1'], cameraIds: ['c1', 'c2', 'c3', 'c3'] }, stations, cameras);
  assert.deepEqual(summary.fullStations.map(station => station.label), ['Бийск · Перевозный 7']);
  assert.equal(summary.individualCameraCount, 1);
  assert.deepEqual(summary.cameraGroups.map(group => [group.label, group.cameras.map(camera => camera.name)]), [['Омск · Лесная 2', ['Клиентская зона']]]);
  assert.equal(summary.hasUnavailable, false);
});

test('unknown assignments stay opaque and a no-match search never changes a saved grant set', () => {
  const target = { name: 'Проверка', email: 'test@example.local', role: 'regional', active: true, stationIds: ['hidden-station'], cameraIds: ['hidden-camera', 'c1'] };
  const summary = describeAccess(target, stations, cameras);
  assert.equal(summary.hasUnavailable, true);
  assert.equal(JSON.stringify(summary).includes('hidden-station'), false);
  assert.equal(JSON.stringify(summary).includes('hidden-camera'), false);
  buildAccessTree(stations, cameras, 'не найдено');
  assert.deepEqual(buildUserMutation(target, { ...target, password: '' }, target.stationIds, target.cameraIds), {});
});

test('camera without an available address does not expose its station identifier', () => {
  const camera = { id: 'c4', stationId: 'not-visible-station', name: 'Видимая камера' };
  const tree = buildAccessTree([], [camera]);
  assert.equal(tree[0].nodes[0].station, null);
  assert.equal(tree[0].nodes[0].label, 'Адрес ПТО недоступен');
  const summary = describeAccess({ role: 'regional', cameraIds: ['c4'] }, [], [camera]);
  assert.equal(summary.hasUnavailable, true);
  assert.equal(summary.cameraGroups[0].label, 'Адрес ПТО недоступен');
});

const audit = [
  { id: '1', at: '2026-11-04T20:30:00Z', actor: 'Анна', action: 'Вход в сервис' },
  { id: '2', at: '2026-11-05T18:00:00Z', actor: 'Борис', action: 'Изменены права пользователя' },
  { id: '3', at: '2026-11-05T16:59:59Z', actor: { name: 'Анна', email: 'anna@example.local' }, action: 'Запрошен онлайн-просмотр' },
  { id: '4', at: 'bad-time', actor: 'Анна', action: 'unknown' },
];

test('audit filters use inclusive calendar dates in the displayed timezone', () => {
  assert.equal(auditDateKey(audit[0].at, 'Asia/Novosibirsk'), '2026-11-05');
  assert.deepEqual(filterAuditItems(audit, { from: '2026-11-05', to: '2026-11-05' }, 'Asia/Novosibirsk').map(item => item.id), ['1', '3']);
  assert.deepEqual(filterAuditItems(audit, { from: '2026-11-06', to: '2026-11-05' }, 'Asia/Novosibirsk'), []);
  assert.equal(filterAuditItems(audit).length, 4);
});

test('audit filters combine person and category and leave unknown actions visible under All', () => {
  assert.equal(auditCategory('Неудачный вход'), 'auth');
  assert.equal(auditCategory('user.update'), 'access');
  assert.equal(auditCategory('Остановлен онлайн-просмотр'), 'view');
  assert.equal(auditCategory('media.view'), 'view');
  assert.equal(auditCategory('unknown'), 'other');
  assert.deepEqual(filterAuditItems(audit, { actor: 'Анна', category: 'auth' }).map(item => item.id), ['1']);
  assert.deepEqual(filterAuditItems(audit, { actor: 'anna@example.local', category: 'view' }).map(item => item.id), ['3']);
});
