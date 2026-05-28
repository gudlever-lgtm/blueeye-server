import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import config from '../config.js';

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  hostname TEXT,
  platform TEXT,
  arch TEXT,
  node_version TEXT,
  last_seen INTEGER,
  status TEXT DEFAULT 'offline'
);

CREATE TABLE IF NOT EXISTS tests (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  type TEXT,
  target TEXT,
  options TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  test_id TEXT,
  agent_id TEXT,
  type TEXT,
  target TEXT,
  status TEXT,
  result TEXT,
  error TEXT,
  duration_ms INTEGER,
  created_at INTEGER,
  FOREIGN KEY (test_id) REFERENCES tests(id)
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

function tableExists(db, name) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

// Rename a legacy `customers` table to `locations` when present, preserving its
// rows. The CREATE TABLE IF NOT EXISTS in MIGRATIONS then covers the
// fresh-install case (and is a harmless no-op after a rename).
function renameCustomersToLocations(db) {
  if (tableExists(db, 'customers') && !tableExists(db, 'locations')) {
    db.exec('ALTER TABLE customers RENAME TO locations');
    console.log('[db] Renamed table customers -> locations');
  }
}

let db;

export function initDb(dbPath = config.dbPath) {
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch {
    // directory may already exist
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  renameCustomersToLocations(db);
  db.exec(MIGRATIONS);
  console.log(`[db] Migrations applied (${dbPath})`);
  return db;
}

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
