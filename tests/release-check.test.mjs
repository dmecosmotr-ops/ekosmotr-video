import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSource } from '../tools/check-release.mjs';
const bytes = text => Buffer.from(text);
test('release excludes private data, build output, credentials files and external binary dependencies', () => {
  for (const path of ['private/live-config.json', 'frontend/node_modules/react/index.js', '.env', 'deploy/secrets/admin.txt', 'tools/RelayLive.class', 'data/video.mp4', 'frontend/dist/index.html']) {
    assert.ok(reviewSource(path, bytes('{}')).length, path);
  }
});
test('release allows source and placeholder examples, but rejects credential literals without printing them', () => {
  assert.deepEqual(reviewSource('backend/app.mjs', bytes('export const ok = true;')), []);
  assert.deepEqual(reviewSource('backend/README.md', bytes('Backend instructions')), []);
  assert.deepEqual(reviewSource('.env.example', bytes('PILOT_PUBLIC_ORIGIN=https://cameras.example.invalid')), []);
  assert.ok(reviewSource('docs/README.md', bytes('ghp_' + 'A'.repeat(30))).includes('GitHub token'));
  assert.ok(reviewSource('tools/probe.py', bytes('-----BEGIN ' + 'PRIVATE KEY-----')).includes('private key'));
  assert.ok(reviewSource('tools/probe.py', Buffer.from([0, 1, 255])).includes('binary or invalid UTF-8'));
});
