import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorLimit, monitorCandidates, monitorGridLayout, sanitizeMonitorSelection } from './src/monitoringSelection.js';

const cameras = [
  { id: 'camera-a', name: 'Ворота', stationId: 'pto-a', liveAvailable: true },
  { id: 'camera-b', name: 'Северный бокс', liveAvailable: true },
  { id: 'demo-camera', status: 'demo', liveAvailable: true },
  { id: 'probe-c300', status: 'recorded_probe', liveAvailable: false },
  { id: 'unavailable', liveAvailable: false },
];
const stations = [{ id: 'pto-a', city: 'Примерск', address: 'Примерск, Учебная, 42/2', region: 'Учебный регион' }];

test('monitoring offers only the server-authorized live cameras and searches address, region and name', () => {
  const items = monitorCandidates(cameras, stations);
  assert.deepEqual(items.map(item => item.id), ['camera-a', 'camera-b']);
  assert.equal(monitorCandidates(cameras, stations, 'учебный')[0].id, 'camera-a');
  assert.equal(monitorCandidates(cameras, stations, '42/2')[0].id, 'camera-a');
  assert.equal(monitorCandidates(cameras, stations, 'северный')[0].id, 'camera-b');
  assert.equal(monitorCandidates(cameras, stations, 'другой адрес').length, 0);
});

test('restored selection keeps all authorized IDs, removing revoked, duplicate and malformed entries', () => {
  const authorized = Array.from({ length: 50 }, (_, index) => `camera-${index}`);
  assert.deepEqual(sanitizeMonitorSelection([...authorized, 'revoked', null, authorized[0]], authorized), authorized);
  assert.deepEqual(sanitizeMonitorSelection('camera-a', ['camera-a']), []);
});

test('HTTP/1.x playback leaves a request slot free while modern protocols use the server capacity', () => {
  assert.equal(monitorLimit(50, 'http/1.1'), 5);
  assert.equal(monitorLimit(50), 5);
  assert.equal(monitorLimit(2, 'http/1.0'), 2);
  assert.equal(monitorLimit(50, 'h2'), 50);
  assert.equal(monitorLimit(150, 'h3'), 150);
  assert.equal(monitorLimit(151, 'h2'), 1);
  assert.equal(monitorLimit('5'), 1);
});

test('grid fits every selected tile on wide, narrow and short stages', () => {
  for (const [count, width, height] of [[1, 1024, 500], [15, 1600, 650], [50, 320, 420], [150, 1920, 420]]) {
    const { rows, columns, tileWidth, tileHeight, gap } = monitorGridLayout(count, width, height);
    assert.ok(columns * rows >= count);
    assert.ok(tileWidth > 0 && tileHeight > 0);
    assert.ok(columns * tileWidth + (columns - 1) * gap <= width + 0.001);
    assert.ok(rows * tileHeight + (rows - 1) * gap <= height + 0.001);
  }
  assert.ok(monitorGridLayout(15, 900, 180).columns > monitorGridLayout(15, 900, 1000).columns);
  assert.ok(monitorGridLayout(50, 1600, 650).tileWidth < monitorGridLayout(5, 1600, 650).tileWidth);
});
