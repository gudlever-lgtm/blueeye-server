'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createSystemInfo } = require('../src/services/systemInfo');
const { makeApp, makeSystemInfo, makeTsdb, makeSourceStore, authHeader } = require('../test-support/fakes');

// ---- service unit tests ----------------------------------------------------
test('getDisk computes total/used/free from statfs', async () => {
  const statfs = (path, cb) => cb(null, { bsize: 4096, blocks: 1000, bfree: 600, bavail: 500 });
  const si = createSystemInfo({ db: {}, diskPath: '/data', statfs });
  const disk = await si.getDisk();
  assert.equal(disk.available, true);
  assert.equal(disk.totalBytes, 4096 * 1000);
  assert.equal(disk.usedBytes, 4096 * 400); // total - bfree
  assert.equal(disk.freeBytes, 4096 * 500); // bavail
  assert.equal(disk.usedPercent, 40);
});

test('getDisk reports unavailable on a statfs error', async () => {
  const statfs = (path, cb) => cb(new Error('ENOENT'));
  const si = createSystemInfo({ db: {}, diskPath: '/nope', statfs });
  const disk = await si.getDisk();
  assert.equal(disk.available, false);
  assert.match(disk.error, /ENOENT/);
});

test('getDatabase sums table sizes from information_schema (fake pool)', async () => {
  const db = {
    databaseName: 'blueeye',
    pool: {
      query: async (sql) => {
        if (/SUM\(data_length \+ index_length\)/.test(sql) && /AS bytes/.test(sql)) {
          return [[{ bytes: 3000, dataBytes: 2500, indexBytes: 500, tables: 2 }]];
        }
        return [[
          { name: 'results', bytes: 2000, rows: 100 },
          { name: 'agents', bytes: 1000, rows: 5 },
        ]];
      },
    },
  };
  const si = createSystemInfo({ db });
  const out = await si.getDatabase();
  assert.equal(out.name, 'blueeye');
  assert.equal(out.totalBytes, 3000);
  assert.equal(out.tableCount, 2);
  assert.equal(out.tables[0].name, 'results');
  assert.equal(out.tables[0].bytes, 2000);
});

test('getIngest reports recent rows/bytes and getStorage includes the estimate', async () => {
  const db = {
    pool: {
      query: async (sql) => {
        if (/FROM results WHERE created_at/.test(sql)) return [[{ c: 6, bytes: 1200 }]];
        if (/SUM\(data_length \+ index_length\)/.test(sql) && /AS bytes/.test(sql)) return [[{ bytes: 3000, dataBytes: 2500, indexBytes: 500, tables: 2 }]];
        return [[]];
      },
    },
  };
  const statfs = (path, cb) => cb(null, { bsize: 1, blocks: 100, bfree: 60, bavail: 60 });
  const si = createSystemInfo({ db, statfs });
  const ing = await si.getIngest(3);
  assert.equal(ing.rows, 6);
  assert.equal(ing.bytes, 1200);
  assert.equal(ing.bytesPerDay, Math.round((1200 / 3) * 1440));
  const out = await si.getStorage();
  assert.ok(out.ingest && out.ingest.bytes === 1200);
});

// ---- TSDB (TimescaleDB telemetry store) ------------------------------------
test('getTsdb reports not configured when no TSDB client is wired', async () => {
  const si = createSystemInfo({ db: {} });
  const out = await si.getTsdb();
  assert.deepEqual(out, { configured: false });
});

test('getTsdb sums size + largest hypertables from a fake TSDB client', async () => {
  const tsdb = makeTsdb({
    databaseName: 'blueeye_telemetry',
    query: async (sql) => {
      if (/pg_database_size/.test(sql)) return [{ bytes: 5000, tables: 4 }];
      if (/timescaledb_information\.hypertables/.test(sql)) {
        return [
          { name: 'results', bytes: 3000, rows: 900, hypertable: true },
          { name: 'flow_records', bytes: 1500, rows: 400, hypertable: true },
          { name: 'schema_migrations', bytes: 100, rows: 3, hypertable: false },
        ];
      }
      return [];
    },
  });
  const si = createSystemInfo({ db: {}, tsdb });
  const out = await si.getTsdb();
  assert.equal(out.configured, true);
  assert.equal(out.name, 'blueeye_telemetry');
  assert.equal(out.totalBytes, 5000);
  assert.equal(out.tableCount, 4);
  assert.equal(out.hypertableCount, 2);
  assert.equal(out.tables[0].name, 'results');
  assert.equal(out.tables[0].bytes, 3000);
  assert.equal(out.tables[0].hypertable, true);
});

test('getTsdb falls back to a plain-PostgreSQL query when the TS-aware one fails', async () => {
  let sawFallback = false;
  const tsdb = makeTsdb({
    query: async (sql) => {
      if (/pg_database_size/.test(sql)) return [{ bytes: 200, tables: 1 }];
      if (/timescaledb_information\.hypertables/.test(sql)) throw new Error('function hypertable_size does not exist');
      sawFallback = true;
      return [{ name: 'results', bytes: 200, rows: 5, hypertable: false }];
    },
  });
  const si = createSystemInfo({ db: {}, tsdb });
  const out = await si.getTsdb();
  assert.equal(sawFallback, true);
  assert.equal(out.tables[0].name, 'results');
  assert.equal(out.hypertableCount, 0);
});

test('getStorage includes tsdb and stays resilient when the TSDB query throws', async () => {
  const statfs = (path, cb) => cb(null, { bsize: 1, blocks: 10, bfree: 5, bavail: 5 });
  const db = { pool: { query: async () => [[]] } };
  const tsdb = makeTsdb({ query: async () => { throw new Error('tsdb down'); } });
  const si = createSystemInfo({ db, tsdb, statfs });
  const out = await si.getStorage();
  assert.equal(out.tsdb.configured, true);
  assert.equal(out.tsdb.available, false);
  assert.match(out.tsdb.error, /tsdb down/);
});

test('getStorage reports tsdb not-configured by default (no TSDB wired)', async () => {
  const statfs = (path, cb) => cb(null, { bsize: 1, blocks: 10, bfree: 5, bavail: 5 });
  const db = { pool: { query: async () => [[]] } };
  const si = createSystemInfo({ db, statfs });
  const out = await si.getStorage();
  assert.deepEqual(out.tsdb, { configured: false });
});

test('getStorage stays resilient when the DB query throws', async () => {
  const statfs = (path, cb) => cb(null, { bsize: 1, blocks: 10, bfree: 5, bavail: 5 });
  const db = { pool: { query: async () => { throw new Error('db down'); } } };
  const si = createSystemInfo({ db, statfs });
  const out = await si.getStorage();
  assert.equal(out.disk.available, true);
  assert.equal(out.database.available, false);
  assert.match(out.database.error, /db down/);
});

// ---- route tests -----------------------------------------------------------
test('GET /system/storage returns disk + database (viewer+)', async () => {
  const res = await request(makeApp()).get('/system/storage').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.disk.usedPercent, 40);
  assert.equal(res.body.database.name, 'blueeye');
  assert.equal(res.body.tsdb.configured, false);
});

test('GET /system/storage without a token returns 401', async () => {
  const res = await request(makeApp()).get('/system/storage');
  assert.equal(res.status, 401);
});

test('GET /system/storage returns 500 when the service throws', async () => {
  const systemInfo = makeSystemInfo({ getStorage: async () => { throw new Error('boom'); } });
  const res = await request(makeApp({ systemInfo })).get('/system/storage').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
});

// ---- GET /system/version ---------------------------------------------------
test('GET /system/version returns server + served agent versions (viewer+)', async () => {
  const res = await request(makeApp()).get('/system/version').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.server, 'string');
  assert.equal(res.body.agent, '0.1.0'); // from the default fake source store
});

test('GET /system/version without a token returns 401', async () => {
  const res = await request(makeApp()).get('/system/version');
  assert.equal(res.status, 401);
});

// ---- POST /system/agent-source/reload --------------------------------------
test('POST /system/agent-source/reload re-packages and returns the served version (admin)', async () => {
  let reloaded = 0;
  let version = '0.1.0';
  const agentSourceStore = makeSourceStore({
    reload: () => { reloaded += 1; version = '0.2.0'; },
    sourceVersion: () => version,
  });
  const res = await request(makeApp({ agentSourceStore }))
    .post('/system/agent-source/reload')
    .set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(reloaded, 1);
  assert.equal(res.body.version, '0.2.0');
  assert.equal(res.body.available, true);
});

test('POST /system/agent-source/reload is admin-only (403 for viewer)', async () => {
  const res = await request(makeApp())
    .post('/system/agent-source/reload')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('POST /system/agent-source/reload without a token returns 401', async () => {
  const res = await request(makeApp()).post('/system/agent-source/reload');
  assert.equal(res.status, 401);
});
