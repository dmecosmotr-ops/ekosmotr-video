import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashPassword } from './security.mjs';
import { bootstrapAdminFor } from './config.mjs';

export function publicUser(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role, active: Boolean(row.active),
    stationIds: JSON.parse(row.station_ids), cameraIds: JSON.parse(row.camera_ids) };
}

export function openStore(path, stations, demoStationIds = [], deploymentConfig) {
  const bootstrapAdmin = deploymentConfig ? bootstrapAdminFor(deploymentConfig) : null;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
  // Check before schema migrations/seeding so a copied local database fails
  // closed instead of silently carrying its known demo logins into deployment.
  if (deploymentConfig?.mode === 'server' && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()
    && db.prepare("SELECT id FROM users WHERE id LIKE 'seed-%' OR lower(email) IN ('admin@ekosmotr.local','director@ekosmotr.local','regional@ekosmotr.local') LIMIT 1").get())
    throw new Error('Server deployment refuses a local demo/seed database; use a dedicated empty database');
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','director','regional')),
      active INTEGER NOT NULL DEFAULT 1, station_ids TEXT NOT NULL, camera_ids TEXT NOT NULL,
      created_by TEXT, created_at TEXT NOT NULL, delegated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      csrf TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, actor_id TEXT, actor TEXT NOT NULL,
      action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL
    );`);
  if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'delegated_by')) {
    db.exec('ALTER TABLE users ADD COLUMN delegated_by TEXT');
    db.exec(`UPDATE users SET delegated_by=created_by WHERE role='regional' AND created_by IN
      (SELECT id FROM users WHERE role='director')`);
  }
  const insert = db.prepare(`INSERT INTO users(id,name,email,password_salt,password_hash,role,active,station_ids,camera_ids,created_by,created_at)
    VALUES(?,?,?,?,?,?,1,?,?,?,?)`);
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) {
    if (deploymentConfig?.mode === 'server') {
      insert.run(randomUUID(), 'Администратор', bootstrapAdmin.email, bootstrapAdmin.salt, bootstrapAdmin.hash,
        'admin', '[]', '[]', null, new Date().toISOString());
    } else {
    const seed = (id, name, email, password, role, stationIds, creator) => {
      const { salt, hash } = hashPassword(password);
      insert.run(id, name, email, salt, hash, role, JSON.stringify(stationIds), '[]', creator, new Date().toISOString());
    };
    seed('seed-admin', 'Администратор', 'admin@ekosmotr.local', 'Pilot-Admin-2026!', 'admin', [], null);
    const seededScope = [...new Set([...demoStationIds, ...stations.map(s => s.id)])];
    seed('seed-director', 'Директор пилота', 'director@ekosmotr.local', 'Pilot-Director-2026!', 'director', seededScope.slice(0, 10), 'seed-admin');
    seed('seed-regional', 'Региональный руководитель', 'regional@ekosmotr.local', 'Pilot-Region-2026!', 'regional', seededScope.slice(0, 2), 'seed-director');
    db.prepare('UPDATE users SET delegated_by=? WHERE id=?').run('seed-director', 'seed-regional');
    }
  }
  const audit = (actor, action, target = '', details = '') => db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)')
    .run(randomUUID(), new Date().toISOString(), actor?.id || null, actor?.name || 'Неавторизованный посетитель', action, target, details);
  return { db, audit, insert };
  } catch (error) { db.close(); throw error; }
}
