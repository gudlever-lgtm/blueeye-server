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
`;

const LOCATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

function tableExists(database, name) {
  return !!database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

function columnNames(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// Migrate the "customers" concept to "locations".
//
//  1. If a legacy `customers` table exists (and `locations` does not yet),
//     rename it in place so existing rows are preserved.
//  2. Otherwise create a fresh `locations` table.
//  3. Backfill any expected columns missing from a renamed legacy table.
function migrateLocations(database) {
  if (tableExists(database, 'customers') && !tableExists(database, 'locations')) {
    database.exec('ALTER TABLE customers RENAME TO locations');
    console.log('[db] Renamed table customers -> locations');
  }

  database.exec(LOCATIONS_TABLE);

  const cols = new Set(columnNames(database, 'locations'));
  const now = Date.now();
  if (!cols.has('name')) {
    database.exec("ALTER TABLE locations ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.has('description')) {
    database.exec('ALTER TABLE locations ADD COLUMN description TEXT');
  }
  if (!cols.has('created_at')) {
    database.exec(`ALTER TABLE locations ADD COLUMN created_at INTEGER NOT NULL DEFAULT ${now}`);
  }
  if (!cols.has('updated_at')) {
    database.exec(`ALTER TABLE locations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT ${now}`);
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
  db.exec(MIGRATIONS);
  migrateLocations(db);
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
