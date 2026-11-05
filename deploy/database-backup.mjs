import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync, rmSync, chmodSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const source = resolve(process.env.PILOT_DB || '/var/lib/camera-pilot/pilot.sqlite');
statSync(source); // Do not silently create a new empty database for a mistyped path.
const directory = resolve(dirname(source), 'backups');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const target = resolve(directory, `pilot-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.sqlite`);
const db = new DatabaseSync(source, { readOnly: true });
try {
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally { db.close(); }
const copy = new DatabaseSync(target, { readOnly: true });
try {
  const result = copy.prepare('PRAGMA quick_check').get();
  if (Object.values(result)[0] !== 'ok') throw new Error('BACKUP_INTEGRITY_FAILED');
} catch (error) {
  copy.close();
  rmSync(target, { force: true });
  throw error;
}
copy.close();
chmodSync(target, 0o600);
console.log(basename(target));
