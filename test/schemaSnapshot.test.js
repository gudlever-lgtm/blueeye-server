'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { build, buildModel, modelFromSql, SCHEMA_PATH } = require('../scripts/build-schema');

// schema.sql is the full-schema snapshot README offers as a way to stand up a
// fresh database. It was hand-maintained next to migrations/ and drifted: by
// migration 077 it was 23 tables behind and declared a foreign key referencing
// event_cases, a table it never created, so the documented load simply failed.
// Nothing caught it because nothing read the file.
//
// It is generated now (scripts/build-schema.js replays migrations/), and these
// tests are what keep it honest. There is no MySQL in the test run, so the
// snapshot is verified structurally and by round-trip rather than by loading it.

const migrationsDir = path.join(__dirname, '..', 'migrations');
const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const snapshot = () => fs.readFileSync(SCHEMA_PATH, 'utf8');

// Excluded everywhere below: the migration runner creates schema_migrations
// itself (src/migrate.js), so it lives in the snapshot but in no migration.
const tablesOf = (model) => [...model.tables.values()].filter((t) => t.name !== 'schema_migrations');

test('schema.sql is up to date with migrations/', () => {
  assert.equal(
    snapshot(),
    build(),
    'schema.sql is stale — regenerate it with: node scripts/build-schema.js',
  );
});

test('the emitted snapshot re-parses to exactly the schema the migrations describe', () => {
  // The round-trip is what stands in for loading the file into a real MySQL: if
  // rendering dropped a column, mangled a definition or lost a key, the model
  // read back out of schema.sql stops matching the one replayed from migrations/.
  const shape = (model) => tablesOf(model)
    .map((t) => ({
      table: t.name,
      columns: t.columns.map((c) => `${c.name} ${c.def.replace(/\s+/g, ' ')}`),
      keys: t.keys.map((k) => k.def.replace(/\s+/g, ' ')),
    }))
    .sort((a, b) => (a.table < b.table ? -1 : 1));

  assert.deepEqual(shape(modelFromSql(snapshot())), shape(buildModel()));
});

test('every table any migration creates survives into the snapshot', () => {
  // The drift itself: 23 tables — event_cases, audit_log, api_tokens,
  // config_snapshots, runbooks, event_notes and more — existed only in
  // migrations/ and were missing from the hand-written file.
  const dropped = new Set();
  const created = new Map();
  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8').replace(/^\s*--.*$/gm, '');
    for (const stmt of sql.split(';')) {
      const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i.exec(stmt);
      if (create) { created.set(create[1], file); dropped.delete(create[1]); }
      const drop = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w`,\s]+)$/i.exec(stmt.trim());
      if (drop) for (const t of drop[1].split(',')) { dropped.add(t.trim().replace(/`/g, '')); created.delete(t.trim().replace(/`/g, '')); }
    }
  }

  // Renames (migration 077) mean the created name is not always the final one;
  // compare counts and resolve names through the replayed model instead.
  const final = new Set(tablesOf(buildModel()).map((t) => t.name));
  assert.equal(final.size, created.size, 'a table created by a migration is missing from the snapshot');

  const inSnapshot = new Set(tablesOf(modelFromSql(snapshot())).map((t) => t.name));
  for (const name of final) assert.ok(inSnapshot.has(name), `${name} is missing from schema.sql`);
});

test('every column a migration adds is present on the snapshot table', () => {
  // event_clusters is the case that mattered: the file stopped at migration 058,
  // so it lacked the ten columns 060 and 064 add, and every SELECT the repository
  // issues names all of them.
  const model = modelFromSql(snapshot());
  const renamed = { incident_cases: 'event_cases', incident_notes: 'event_notes', incident_clusters: 'event_clusters', incident_playbook_runs: 'event_playbook_runs', incidents: 'probe_outages', incident_thresholds: 'probe_thresholds' };

  const sources = migrationFiles.map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8').replace(/^\s*--.*$/gm, ''));
  const all = sources.join('\n');
  // A column can be renamed after it is added (077 turns findings.incident_case_id
  // into event_case_id), so follow the chain before looking it up.
  const columnRenames = new Map([...all.matchAll(/CHANGE\s+(?:COLUMN\s+)?`?(\w+)`?\s+`?(\w+)`?/gi)].map((m) => [m[1], m[2]]));
  const finalName = (col) => {
    let name = col;
    for (let hops = 0; columnRenames.has(name) && hops < 10; hops += 1) name = columnRenames.get(name);
    return name;
  };

  for (const [i, sql] of sources.entries()) {
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+`?(\w+)`?([\s\S]*?);/gi)) {
      const table = renamed[m[1]] || m[1];
      for (const add of m[2].matchAll(/ADD\s+COLUMN\s+`?(\w+)`?/gi)) {
        const column = finalName(add[1]);
        // A column a later migration deliberately drops is allowed to be absent.
        if (new RegExp(`DROP\\s+COLUMN\\s+\`?${column}\`?`, 'i').test(all)) continue;
        assert.ok(
          model.hasColumn(table, column),
          `${migrationFiles[i]} adds ${table}.${add[1]}, which is missing from schema.sql`,
        );
      }
    }
  }
});

test('no foreign key in the snapshot references a table the snapshot does not create', () => {
  // The old file's concrete breakage: event_playbook_runs declared
  // `REFERENCES event_cases (id)` while never creating event_cases, so loading
  // it into a fresh database failed partway through.
  const model = modelFromSql(snapshot());
  const names = new Set(model.tables.keys());
  const dangling = [];
  for (const table of model.tables.values()) {
    for (const key of table.keys) {
      const ref = /REFERENCES\s+`?(\w+)`?/i.exec(key.def);
      if (ref && !names.has(ref[1])) dangling.push(`${table.name} -> ${ref[1]}`);
    }
  }
  assert.deepEqual(dangling, []);
});

test('the retired incident_* vocabulary is gone from the snapshot', () => {
  // Migration 077 renamed these; the snapshot must show the renamed world, not
  // the pre-077 one, and its foreign keys must point at the new names.
  const model = modelFromSql(snapshot());
  for (const gone of ['incident_cases', 'incident_notes', 'incident_clusters', 'incident_playbook_runs', 'incidents', 'incident_thresholds']) {
    assert.ok(!model.tables.has(gone), `${gone} should have been renamed by migration 077`);
  }
  // blueeye_nis2_incidents keeps "incident" on purpose — it is the directive's word.
  assert.ok(model.tables.has('blueeye_nis2_incidents'));
  assert.doesNotMatch(snapshot(), /REFERENCES\s+`?incident_\w+/i);
});

test('the builder refuses DDL it does not model rather than silently skipping it', () => {
  // The property that makes the generator trustworthy: an unrecognised statement
  // form fails the build loudly instead of vanishing from the snapshot.
  assert.throws(
    () => modelFromSql('CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW SET @x = 1;'),
    /unsupported statement/,
  );
  assert.throws(
    () => modelFromSql('CREATE TABLE t (id INT);\nALTER TABLE t CONVERT TO CHARACTER SET utf8mb4;'),
    /unsupported ALTER clause/,
  );
});
