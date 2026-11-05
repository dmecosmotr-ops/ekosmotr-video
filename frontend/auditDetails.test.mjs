import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAuditDetails } from './src/auditDetails.js';

test('audit permission JSON becomes readable Russian without raw JSON', () => {
  assert.equal(formatAuditDetails('{"role":"regional","active":false,"stations":0,"cameras":1}'),
    'Роль: региональный руководитель · Учётная запись отключена · Станций целиком: 0 · Отдельных камер: 1');
});
test('unknown fields remain short text and nested objects do not become JSON', () => {
  assert.equal(formatAuditDetails({ message: 'Доступ изменён', nested: { id: 'test' } }),
    'Описание: Доступ изменён · nested: дополнительные сведения');
});
test('malformed JSON stays plain text for React text rendering', () => {
  assert.equal(formatAuditDetails('{not-json <b>test</b>'), '{not-json <b>test</b>');
});
test('known sensitive field names are not rendered', () => {
  assert.equal(formatAuditDetails({ stations: 1, password: 'not-real', token: 'not-real' }), 'Станций целиком: 1');
});

test('live stop reasons use readable labels while unknown reasons remain plain text', () => {
  assert.equal(formatAuditDetails({ reason: 'startup_timeout' }), 'Причина: Не дождались видео от камеры');
  assert.equal(formatAuditDetails({ reason: 'bridge_closed' }), 'Причина: Источник завершил передачу');
  assert.equal(formatAuditDetails({ reason: 'other reason' }), 'Причина: other reason');
});
