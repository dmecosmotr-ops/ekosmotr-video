import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserMutation } from './src/userMutation.js';

const target = {
  id: 'regional-child', name: 'Региональный руководитель', email: 'regional@example.local',
  role: 'regional', active: true, stationIds: ['s-2', 's-1'], cameraIds: ['c-1'],
};
const form = { name: target.name, email: target.email, role: target.role, active: true, password: '' };

test('renaming a delegated user sends no role or grant fields', () => {
  assert.deepEqual(buildUserMutation(target, { ...form, name: 'Новое имя' }, ['s-1', 's-2'], ['c-1']), { name: 'Новое имя' });
});
test('password or active edits do not silently replace grants', () => {
  assert.deepEqual(buildUserMutation(target, { ...form, active: false, password: 'New-Pilot-2026!' }, target.stationIds, target.cameraIds), { active: false, password: 'New-Pilot-2026!' });
});
test('reordered and duplicate identifiers are the same permission set', () => {
  assert.deepEqual(buildUserMutation(target, form, ['s-1', 's-2', 's-1'], ['c-1', 'c-1']), {});
});
test('an intentional scope edit sends only its changed set', () => {
  assert.deepEqual(buildUserMutation(target, form, ['s-2'], ['c-1']), { stationIds: ['s-2'] });
});
test('creation still sends the complete initial role and permissions', () => {
  const initial = { ...form, password: 'New-Pilot-2026!' };
  assert.deepEqual(buildUserMutation(null, initial, ['s-1'], ['c-2']), { ...initial, stationIds: ['s-1'], cameraIds: ['c-2'] });
});
