import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (script, path, options = {}) => spawnSync(process.execPath, [resolve(root, 'deploy', script)], {
  env: { ...process.env, PILOT_DB: path, ...options.env }, input: options.input, encoding: 'utf8', timeout: 20000,
});
function database(path, name) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE users(name TEXT); CREATE TABLE sessions(id TEXT); CREATE TABLE audit(id TEXT);`);
  db.prepare('INSERT INTO users VALUES(?)').run(name);
  return db;
}
test('backup captures committed WAL data in one separately readable SQLite file', () => {
  const directory = mkdtempSync(join(root, 'deploy', '.test-backup-'));
  const source = join(directory, 'pilot.sqlite');
  const active = database(source, 'committed while app remains open');
  try {
    assert.ok(existsSync(source + '-wal'));
    const result = run('database-backup.mjs', source);
    assert.equal(result.status, 0, result.stderr);
    const saved = join(directory, 'backups', result.stdout.trim());
    const backup = new DatabaseSync(saved, { readOnly: true });
    try { assert.equal(backup.prepare('SELECT name FROM users').get().name, 'committed while app remains open'); }
    finally { backup.close(); }
  } finally { active.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('restore requires stop confirmation, rejects bad input, preserves and replaces old database', () => {
  const directory = mkdtempSync(join(root, 'deploy', '.test-restore-'));
  const source = join(directory, 'pilot.sqlite');
  const original = database(source, 'before update');
  original.close();
  try {
    const saved = run('database-backup.mjs', source);
    assert.equal(saved.status, 0, saved.stderr);
    const contents = readFileSync(join(directory, 'backups', saved.stdout.trim()));
    const later = new DatabaseSync(source);
    later.exec("UPDATE users SET name='after update'");
    later.close();
    const confirm = { PILOT_RESTORE_CONFIRM: 'application-is-stopped' };
    assert.notEqual(run('database-restore.mjs', source, { input: contents }).status, 0);
    assert.notEqual(run('database-restore.mjs', source, { input: Buffer.from('not SQLite'), env: confirm }).status, 0);
    const stillOriginal = new DatabaseSync(source, { readOnly: true });
    try { assert.equal(stillOriginal.prepare('SELECT name FROM users').get().name, 'after update'); }
    finally { stillOriginal.close(); }
    const restored = run('database-restore.mjs', source, { input: contents, env: confirm });
    assert.equal(restored.status, 0, restored.stderr);
    const current = new DatabaseSync(source, { readOnly: true });
    try { assert.equal(current.prepare('SELECT name FROM users').get().name, 'before update'); }
    finally { current.close(); }
    const preserved = readdirSync(directory).find(name => name.startsWith('before-restore-'));
    assert.ok(preserved);
    const previous = new DatabaseSync(join(directory, preserved, 'pilot.sqlite'), { readOnly: true });
    try { assert.equal(previous.prepare('SELECT name FROM users').get().name, 'after update'); }
    finally { previous.close(); }
    assert.ok(!readdirSync(directory).some(name => name.startsWith('restore-')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
