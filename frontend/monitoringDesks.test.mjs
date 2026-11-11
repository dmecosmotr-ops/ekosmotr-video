import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonitorDesk, loadMonitorDesks, removeMonitorDesk, renameMonitorDesk, sanitizeMonitorDesks,
  saveMonitorDesks, selectMonitorDesk, setMonitorDeskCameras,
} from './src/monitoringDesks.js';

function browserStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('the user names the first desk and can keep their earlier selection on it', () => {
  const storage = browserStorage();
  const cameras = Array.from({ length: 21 }, (_, index) => `camera-${index}`);
  storage.setItem('ekosmotr.monitoring.v1.director', JSON.stringify([...cameras, null, cameras[0]]));
  const draft = loadMonitorDesks(storage, 'director');
  assert.deepEqual(draft, { activeId: null, desks: [], draftCameraIds: cameras });
  assert.equal(addMonitorDesk(draft, '   '), draft);
  const named = addMonitorDesk(draft, '  Москва  ');
  assert.equal(named.desks[0].name, 'Москва');
  assert.deepEqual(named.desks[0].cameraIds, cameras);
  assert.deepEqual(named.draftCameraIds, []);
  saveMonitorDesks(storage, 'director', named);
  assert.deepEqual(loadMonitorDesks(storage, 'director'), named);
  assert.equal(loadMonitorDesks(storage, 'other').desks.length, 0);
});

test('eight personal desks retain separate selections when a user switches, clears or renames one', () => {
  const storage = browserStorage();
  let state = loadMonitorDesks(storage, 'director');
  for (let index = 1; index <= 8; index++) {
    state = addMonitorDesk(state, `Регион ${index}`);
    assert.deepEqual(state.desks.at(-1).cameraIds, []);
    state = setMonitorDeskCameras(state, [`camera-${index}`, 'revoked']);
  }
  const [first, second] = state.desks;
  state = selectMonitorDesk(state, first.id);
  state = setMonitorDeskCameras(state, []);
  state = renameMonitorDesk(state, first.id, 'Москва');
  state = sanitizeMonitorDesks(state, Array.from({ length: 8 }, (_, index) => `camera-${index + 1}`));
  saveMonitorDesks(storage, 'director', state);
  const restored = loadMonitorDesks(storage, 'director');
  assert.equal(restored.desks.length, 8);
  assert.deepEqual(restored.desks[0], { id: first.id, name: 'Москва', cameraIds: [] });
  assert.deepEqual(restored.desks[1].cameraIds, ['camera-2']);
  assert.ok(restored.desks.every(desk => !desk.cameraIds.includes('revoked')));
  assert.equal(removeMonitorDesk(restored, first.id).activeId, second.id);
  const empty = restored.desks.reduce((next, desk) => removeMonitorDesk(next, desk.id), restored);
  saveMonitorDesks(storage, 'director', empty);
  assert.deepEqual(loadMonitorDesks(storage, 'director'), { activeId: null, desks: [], draftCameraIds: [] });
});
