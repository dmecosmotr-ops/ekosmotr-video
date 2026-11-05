// Run only while the application is stopped. Reads one backup from stdin.
import { DatabaseSync } from 'node:sqlite';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';

if (process.env.PILOT_RESTORE_CONFIRM !== 'application-is-stopped') {
  throw new Error('Stop the application, then set PILOT_RESTORE_CONFIRM=application-is-stopped');
}
const target = resolve(process.env.PILOT_DB || '/var/lib/camera-pilot/pilot.sqlite');
const directory = dirname(target);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const temporary = resolve(directory, `restore-${randomUUID()}.sqlite`);
let bytes = 0;
const sizeLimit = new Transform({ transform(chunk, encoding, callback) {
  bytes += chunk.length;
  callback(bytes > 1024 * 1024 * 1024 ? new Error('Backup exceeds 1 GiB restore limit') : null, chunk);
} });
try {
  await pipeline(process.stdin, sizeLimit, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
  if (statSync(temporary).size < 100) throw new Error('INVALID_BACKUP');
  const incoming = new DatabaseSync(temporary, { readOnly: true });
  try {
    if (Object.values(incoming.prepare('PRAGMA quick_check').get())[0] !== 'ok') throw new Error('INVALID_BACKUP');
    for (const table of ['users', 'sessions', 'audit']) incoming.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
  } finally { incoming.close(); }
  // Preserve all old SQLite files together; rollback does not discard previous data.
  const preserved = resolve(directory, `before-restore-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  mkdirSync(preserved, { mode: 0o700 });
  const moved = [];
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const previous = target + suffix;
      if (existsSync(previous)) {
        const saved = resolve(preserved, basename(previous));
        renameSync(previous, saved);
        moved.push([saved, previous]);
      }
    }
    renameSync(temporary, target);
  } catch (error) {
    for (const [saved, previous] of moved.reverse()) renameSync(saved, previous);
    throw error;
  }
  console.log(`Restored. Previous files preserved in ${basename(preserved)}`);
} finally { rmSync(temporary, { force: true }); }
