import test from 'node:test';
import assert from 'node:assert/strict';
import {
  archiveSearchAllowed, cameraAvailabilityLabel, cameraInitialView, cameraViewLabel,
  selectDetailCamera, stationAddress, stationTitle,
} from './src/detailPresentation.js';

test('station title includes full street address without repeating the city', () => {
  assert.equal(stationTitle({ city: 'Бийск', address: 'Бийск, Перевозный пер., 7' }), 'Бийск · Перевозный пер., 7');
  assert.equal(stationTitle({ city: 'Бийск', address: 'г. БИЙСК, Перевозный пер., 7' }), 'Бийск · Перевозный пер., 7');
  assert.equal(stationAddress({ city: 'Бийск', address: 'ул. Бийская, 7' }), 'ул. Бийская, 7');
});

test('missing address stays unknown rather than using the camera name as an address', () => {
  assert.equal(stationTitle(null), 'Адрес ПТО не установлен');
  assert.equal(stationTitle({ city: 'Бийск' }), 'Бийск · адрес ПТО не указан');
  assert.equal(stationTitle({ address: 'Перевозный пер., 7' }), 'Перевозный пер., 7');
  assert.equal(cameraViewLabel({ view: 'unknown' }), 'Ракурс не проверен');
});

const cameras = [
  { id: 'unconnected', liveAvailable: false, archiveAvailable: false },
  { id: 'configured', liveAvailable: true, archiveAvailable: false },
  { id: 'probe', status: 'recorded_probe', liveAvailable: false, archiveAvailable: true },
];

test('online opens the configured camera even if inventory starts with an unconnected one', () => {
  assert.equal(selectDetailCamera(cameras, { mode: 'online', currentId: 'unconnected' }), 'configured');
  assert.equal(selectDetailCamera(cameras, { mode: 'archive' }), 'probe');
  assert.equal(selectDetailCamera([], { mode: 'online' }), '');
});

test('an explicit available camera selection survives mode switches but missing cameras do not', () => {
  assert.equal(selectDetailCamera(cameras, { mode: 'online', currentId: 'unconnected', preserveSelection: true }), 'unconnected');
  assert.equal(selectDetailCamera(cameras, { mode: 'archive', currentId: 'configured', preserveSelection: true }), 'configured');
  assert.equal(selectDetailCamera(cameras, { mode: 'online', currentId: 'removed', preserveSelection: true }), 'configured');
});

test('camera availability describes configured viewing rather than claiming a live connection', () => {
  assert.equal(cameraAvailabilityLabel(cameras[0]), 'Видео не подключено');
  assert.equal(cameraAvailabilityLabel(cameras[1]), 'Просмотр настроен');
  assert.equal(cameraAvailabilityLabel(cameras[2]), 'Архив');
  assert.equal(cameraAvailabilityLabel({ status: 'recorded_probe', archiveAvailable: false }), 'Видео не подключено');
});

test('archive search requires loaded availability for this exact camera', () => {
  assert.equal(archiveSearchAllowed(null, 'probe'), false);
  assert.equal(archiveSearchAllowed({ cameraId: 'probe', archive: { status: 'available' } }, 'probe', true), false);
  assert.equal(archiveSearchAllowed({ cameraId: 'probe', archive: { status: 'available' } }, 'different'), false);
  assert.equal(archiveSearchAllowed({ cameraId: 'probe', archive: { status: 'not_connected' } }, 'probe'), false);
  assert.equal(archiveSearchAllowed({ cameraId: 'probe', archive: { status: 'available' } }, 'probe'), true);
});

test('detail starts in an explicit mode or uses only actually configured video', () => {
  assert.deepEqual(cameraInitialView(cameras[0], 'archive'), { section: 'video', mode: 'archive' });
  assert.deepEqual(cameraInitialView(cameras[1]), { section: 'video', mode: 'online' });
  assert.deepEqual(cameraInitialView(cameras[2]), { section: 'video', mode: 'archive' });
  assert.deepEqual(cameraInitialView({ status: 'recorded_probe', archiveAvailable: false }), { section: 'events', mode: 'online' });
});
