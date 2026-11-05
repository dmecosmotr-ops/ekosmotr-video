import test from 'node:test';
import assert from 'node:assert/strict';
import { presentWorkspace, sumMeasured, groupCameras } from './src/dataPresentation.js';

const stations = [{ id: 'a', city: 'Бийск', address: 'Бийск, пер. Перевозный, 7', metrics: { source: 'demo', entries: 99 } }, { id: 'b', city: 'Тула', address: 'Тула, ул. Тестовая, 2', metrics: { source: 'none', entries: null } }];
const cameras = [{ id: 'demo', stationId: 'a', status: 'demo', metrics: { source: 'demo', entries: 99 } }, { id: 'real', stationId: 'a', status: 'unconnected', metrics: { source: 'none', entries: null } }, { id: 'probe', stationId: null, status: 'recorded_probe' }];
test('рабочий режим не показывает демонстрационные камеры, события и показатели на настоящем адресе', () => {
  const view = presentWorkspace(stations, cameras, [{ id: 'e', cameraId: 'demo', source: 'demo' }], 'real');
  assert.deepEqual(view.cameras.map(c => c.id), ['real', 'probe']);
  assert.equal(view.events.length, 0);
  assert.equal(view.stations[0].metrics.source, 'none');
  assert.equal(view.stations[0].metrics.entries, null);
  assert.equal(view.stations[0].cameraCount, 1);
  assert.equal(view.stations.length, 2);
  assert.equal(stations[0].metrics.entries, 99, 'исходный API-ответ не изменён');
});
test('режим примера содержит только пример и сохраняет пункты без анализа', () => {
  const view = presentWorkspace(stations, cameras, [{ id: 'e', cameraId: 'demo', source: 'demo' }, { id: 'hidden', cameraId: 'not-allowed', source: 'demo' }], 'demo');
  assert.deepEqual(view.cameras.map(c => c.id), ['demo']);
  assert.deepEqual(view.events.map(e => e.id), ['e']);
  assert.equal(view.stations[0].metrics.entries, 99);
  assert.equal(view.stations[1].metrics.entries, null);
});
test('сумма не подменяет неизвестные результаты нулём', () => {
  assert.equal(sumMeasured([], 'entries'), null);
  assert.equal(sumMeasured([{ metrics: { entries: null } }], 'entries'), null);
  assert.equal(sumMeasured([{ metrics: { entries: 0 } }], 'entries'), 0);
  assert.equal(sumMeasured([{ metrics: { entries: 3 } }, { metrics: { entries: null } }], 'entries'), null);
});
test('группы камер строятся только из переданных объектов, без скрытых cameraCount', () => {
  const groups = groupCameras(cameras.filter(c => c.status !== 'demo'), stations);
  assert.equal(groups.length, 2);
  assert.equal(groups.find(g => g.station?.id === 'a').cameras.length, 1);
  assert.equal(groups.find(g => !g.station).cameras[0].id, 'probe');
});
