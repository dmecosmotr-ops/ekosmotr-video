import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matchCamera, matchCameras } from '../backend/camera-matching.mjs';

const stations = JSON.parse(await readFile(new URL('../data/stations.json', import.meta.url), 'utf8'));
const byAddress = address => {
  const station = stations.find(item => item.address === address);
  assert.ok(station, `Required source fixture is missing: ${address}`);
  return station;
};
const optikov = byAddress('Санкт-Петербург, ул. Оптиков, 1к3');
const cherepanova = byAddress('Екатеринбург, ул. Черепанова 23');
const demidovskaya = byAddress('Челябинск, ул. Демидовская, 8А');
const popova = byAddress('Барнаул, ул. Попова, 226А');
const titova = byAddress('Барнаул, ул. Германа Титова, д. 37');
const perevozny = byAddress('Бийск, пер. Перевозный, 7');
const camera = name => ({ id: 'stable-camera-id', name, model: 'xiaomi.camera.c01a01' });

for (const [name, expected] of [
  ['Оптиков', optikov],
  ['САНКТ-ПЕТЕРБУРГ, ул. Оптиков, д. 1, корпус 3', optikov],
  ['Черепанова23', cherepanova],
  ['Демидовская8 а', demidovskaya],
  ['Демидовская8A', demidovskaya],
  ['Барнаул Попова226а бокс', popova],
  ['Барнаул Титова37', titova],
  ['Барнаул Титова37бокс', titova],
  ['Бийск Перевозный7', perevozny],
  ['Бийск Перевозный7бокс', perevozny],
]) {
  test(`matches the actual source address for ${name}`, () => {
    const result = matchCamera(camera(name), stations);
    assert.equal(result.mappingStatus, 'matched');
    assert.equal(result.stationId, expected.id);
    assert.deepEqual(result.candidateStationIds, [expected.id]);
    assert.equal(result.id, 'stable-camera-id');
    assert.ok(result.mappingReason.length > 0);
  });
}

for (const name of ['Черепанова123', 'Черепанова2', 'Демидовская8', 'Демидовская8Б', 'Барнаул Попова226 въезд', 'Барнаул Попова226въезд', 'Оптиков3', 'Оптиков1строение3']) {
  test(`does not silently accept an incompatible number in ${name}`, () => {
    const result = matchCamera(camera(name), stations);
    assert.equal(result.mappingStatus, 'needs_mapping');
    assert.equal(result.stationId, null);
    assert.deepEqual(result.candidateStationIds, []);
  });
}

test('requires manual mapping for a shared street without a city', () => {
  const fixtures = [
    { id: 'ekat', city: 'Екатеринбург', address: 'Екатеринбург, ул. Чкалова, 4' },
    { id: 'chelyabinsk', city: 'Челябинск', address: 'Челябинск, ул. Чкалова, 4' },
  ];
  const result = matchCamera(camera('Чкалова4 бокс'), fixtures);
  assert.equal(result.mappingStatus, 'ambiguous');
  assert.equal(result.stationId, null);
  assert.deepEqual(result.candidateStationIds, ['chelyabinsk', 'ekat']);
  assert.equal(matchCamera(camera('Екатеринбург Чкалова4'), fixtures).stationId, 'ekat');
});

test('does not match city-only labels or short street words', () => {
  const fixtures = [{ id: 'single', city: 'Новосибирск', address: 'Новосибирск, ул. Мира, 63А' }];
  assert.equal(matchCamera(camera('Новосибирск'), fixtures).mappingStatus, 'needs_mapping');
  assert.equal(matchCamera(camera('Мира63А'), fixtures).mappingStatus, 'needs_mapping');
  assert.equal(matchCamera(camera('Новосибирск ул. Мира д.63А'), fixtures).stationId, 'single');
});

test('does not treat a model, a camera ordinal or an unconfirmed inflection as an address', () => {
  for (const name of ['Xiaomi Smart Camera C300', 'Видеокамера', 'Камера 23', 'Славянка', '']) {
    assert.equal(matchCamera(camera(name), stations).mappingStatus, 'needs_mapping', name);
  }
});

test('matches ё and е in addresses while retaining complete number units', () => {
  const fixtures = [{ id: 'birch', city: 'Город', address: 'Город, ул. Берёзовая, 23А' }];
  assert.equal(matchCamera(camera('Березовая23а'), fixtures).stationId, 'birch');
  assert.equal(matchCamera(camera('Березовая23'), fixtures).stationId, null);
});

test('matches 23 exactly rather than treating it as a substring of 123', () => {
  const fixtures = [
    { id: 'twenty-three', city: 'Город', address: 'Город, ул. Черепанова, 23' },
    { id: 'one-twenty-three', city: 'Город', address: 'Город, ул. Черепанова, 123' },
  ];
  assert.equal(matchCamera(camera('Черепанова23'), fixtures).stationId, 'twenty-three');
});

test('uses all supplied number components including corpus and building', () => {
  const fixtures = [
    { id: 'corpus', city: 'Город', address: 'Город, ул. Оптиков, д. 1, корп. 3' },
    { id: 'building', city: 'Город', address: 'Город, ул. Оптиков, д. 1, стр. 3' },
  ];
  assert.equal(matchCamera(camera('Оптиков1к3'), fixtures).stationId, 'corpus');
  assert.equal(matchCamera(camera('Оптиков1стр3'), fixtures).stationId, 'building');
  assert.equal(matchCamera(camera('Оптиков1'), fixtures).mappingStatus, 'ambiguous');
});

test('preserves camera identity across names, reordering and multiple cameras per station', () => {
  const inputs = [
    { ...camera('Оптиков'), id: 'device-a' },
    { ...camera('Черепанова23'), id: 'device-b' },
    { ...camera('Бийск Перевозный7бокс'), id: 'device-c' },
    { ...camera('Бийск Перевозный7'), id: 'device-d' },
  ];
  const snapshot = structuredClone(inputs);
  const results = matchCameras(inputs, stations);
  assert.deepEqual(inputs, snapshot);
  assert.deepEqual(results.map(item => item.id), ['device-a', 'device-b', 'device-c', 'device-d']);
  assert.equal(results[2].stationId, results[3].stationId);
  assert.equal(matchCamera({ ...inputs[0], name: 'Черепанова23' }, stations).id, 'device-a');
  assert.deepEqual(matchCameras([...inputs].reverse(), [...stations].reverse()).map(item => [item.id, item.stationId]), results.map(item => [item.id, item.stationId]).reverse());
});

test('does not invent an identity for a nameless or unidentified camera', () => {
  const result = matchCamera({ name: 'Оптиков', model: 'xiaomi.camera.c01a01' }, stations);
  assert.equal(result.id, undefined);
  assert.equal(result.stationId, null);
  assert.equal(result.mappingStatus, 'needs_mapping');
});
