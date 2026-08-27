'use strict';

// The on-demand raw fault list, and the bulk read that made the Troubleshooting
// screen stop paying for it on page load.
//
// The behaviour under test, in one sentence: GET /api/troubleshooting/overview
// must not read one row per cluster member (a fleet holds tens of thousands),
// and the rows themselves move to GET /api/troubleshooting/faults, which the
// dashboard calls only when the operator asks to list them.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeEventClustersRepo, makeFindingStore, authHeader,
} = require('../test-support/fakes');
const { createTroubleshootingOverviewService, MAX_FAULT_PAGE } = require('../src/troubleshooting/overviewService');
const { FindingStore } = require('../src/analysis/findings');
const TV = require('../public/troubleshootingView');

const FAULTS_PATH = '/api/troubleshooting/faults';
const OVERVIEW_PATH = '/api/troubleshooting/overview';

const AGENTS = [
  { id: 1, hostname: 'sw-core', status: 'online', location_id: 1 },
  { id: 2, hostname: 'sw-acc-a', status: 'online', location_id: 1 },
];

// A fleet of `clusters` clusters, each holding `per` member findings.
async function seed({ clusters = 2, per = 3 } = {}) {
  const findingStore = makeFindingStore();
  const clustersRepo = makeEventClustersRepo();
  for (let c = 0; c < clusters; c += 1) {
    const ids = [];
    for (let m = 0; m < per; m += 1) {
      const saved = await findingStore.save({
        id: `c${c}-f${m}`,
        hostId: String((m % 2) + 1),
        metric: 'link.errors',
        severity: m === 0 ? 'CRIT' : 'WARN',
        observed: 9, baseline: 1, deviation: 8,
        explanation: 'errors up',
        evidence: [{ ts: '2026-07-27T11:50:00.000Z', value: 9 }],
        createdAt: '2026-07-27T11:50:00.000Z',
      });
      ids.push(saved.id);
    }
    await clustersRepo.create({
      confidence: 'high',
      memberFindingIds: ids,
      suspectedCommonCause: `cause ${c}`,
      detectedAt: new Date(Date.UTC(2026, 6, 27, 12, c)),
    });
  }
  return { findingStore, clustersRepo };
}

function appFor({ findingStore, clustersRepo, agents = AGENTS } = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: async () => agents,
      findById: async (id) => agents.find((a) => a.id === Number(id)) || null,
    }),
    findingStore,
    eventClustersRepo: clustersRepo,
  });
}

// --- the point of the change: the overview stops reading per member ---------
test('the overview hydrates members in ONE bulk read, not one read per member', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 4, per: 25 });
  const calls = { bulk: 0, single: 0, ids: 0 };
  const counted = {
    ...findingStore,
    listByIds: async (ids, opts) => { calls.bulk += 1; calls.ids += ids.length; return findingStore.listByIds(ids, opts); },
    get: async (id) => { calls.single += 1; return findingStore.get(id); },
  };
  const service = createTroubleshootingOverviewService({
    clustersRepo, findingStore: counted, logger: { warn() {} },
  });

  const overview = await service.getOverview();
  assert.equal(calls.single, 0, 'no per-member reads');
  assert.equal(calls.bulk, 1, 'one bulk read for the whole screen');
  assert.equal(calls.ids, 100, 'every member id in that one read');
  assert.equal(overview.summary.activeFaults, 100);
  assert.equal(overview.summary.rootCauses, 4);
});

test('the bulk read asks for the narrow projection — the screen never pulls evidence blobs', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 1, per: 2 });
  let opts = null;
  const service = createTroubleshootingOverviewService({
    clustersRepo,
    findingStore: { ...findingStore, listByIds: async (ids, o) => { opts = o; return findingStore.listByIds(ids, o); } },
    logger: { warn() {} },
  });
  await service.getOverview();
  assert.deepEqual(opts, { light: true });
});

test('a store without listByIds still works — the per-id path is the fallback, not the norm', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 1, per: 3 });
  const legacy = { get: findingStore.get, list: findingStore.list };
  const service = createTroubleshootingOverviewService({ clustersRepo, findingStore: legacy, logger: { warn() {} } });
  const overview = await service.getOverview();
  assert.equal(overview.summary.activeFaults, 3);
  assert.equal(overview.rootCauses[0].severity, 'CRIT');
});

// --- getFaults --------------------------------------------------------------
test('getFaults pages the raw alarms in root-cause order', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 2, per: 3 });
  const service = createTroubleshootingOverviewService({ clustersRepo, findingStore, logger: { warn() {} } });

  const first = await service.getFaults({ limit: 4, offset: 0 });
  assert.equal(first.total, 6);
  assert.equal(first.returned, 4);
  assert.equal(first.hasMore, true);
  // Clusters come back newest-activity first, so cluster 1 leads.
  assert.deepEqual(first.faults.map((f) => f.findingId), ['c1-f0', 'c1-f1', 'c1-f2', 'c0-f0']);

  const second = await service.getFaults({ limit: 4, offset: 4 });
  assert.equal(second.returned, 2);
  assert.equal(second.hasMore, false);
  assert.deepEqual(second.faults.map((f) => f.findingId), ['c0-f1', 'c0-f2']);
});

test('the fault total matches the Active faults figure the link carries', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 3, per: 7 });
  const service = createTroubleshootingOverviewService({ clustersRepo, findingStore, logger: { warn() {} } });
  const overview = await service.getOverview();
  const page = await service.getFaults({ limit: 1 });
  assert.equal(page.total, overview.summary.activeFaults);
});

test('a fault row carries the evidence the rollup does not — explanation and cause', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 1, per: 1 });
  const service = createTroubleshootingOverviewService({ clustersRepo, findingStore, logger: { warn() {} } });
  const [row] = (await service.getFaults()).faults;
  assert.equal(row.explanation, 'errors up');
  assert.equal(row.cause, 'cause 0');
  assert.equal(row.severity, 'CRIT');
  assert.equal(row.hostId, '1');
  assert.equal(row.createdAt, '2026-07-27T11:50:00.000Z');
  assert.equal(row.missing, false);
});

test('a member purged by retention is still a row, flagged, so the counter can reach its total', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 1, per: 2 });
  await clustersRepo.create({
    confidence: 'low', memberFindingIds: ['gone-1'], suspectedCommonCause: 'ghost',
    detectedAt: new Date(Date.UTC(2026, 6, 27, 13, 0)),
  });
  const service = createTroubleshootingOverviewService({ clustersRepo, findingStore, logger: { warn() {} } });
  const page = await service.getFaults();
  assert.equal(page.total, 3);
  assert.equal(page.returned, 3);
  const ghost = page.faults.find((f) => f.findingId === 'gone-1');
  assert.equal(ghost.missing, true);
  assert.equal(ghost.severity, null);
  assert.equal(ghost.createdAt, null);
  assert.equal(ghost.cause, 'ghost');
});

test('clusterId narrows the list to one root cause', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 2, per: 3 });
  const service = createTroubleshootingOverviewService({ clustersRepo, findingStore, logger: { warn() {} } });
  const page = await service.getFaults({ clusterId: 1 });
  assert.equal(page.total, 3);
  assert.ok(page.faults.every((f) => f.clusterId === 1));
});

test('an offset past the end returns an empty page, not an error', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 1, per: 2 });
  const service = createTroubleshootingOverviewService({ clustersRepo, findingStore, logger: { warn() {} } });
  const page = await service.getFaults({ offset: 500 });
  assert.deepEqual(page.faults, []);
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, false);
});

test('the same finding in two clusters is listed once, and counted once', async () => {
  const findingStore = makeFindingStore();
  const clustersRepo = makeEventClustersRepo();
  await findingStore.save({ id: 'shared', hostId: '1', metric: 'link.errors', severity: 'WARN', explanation: 'x', evidence: [{ ts: 1, value: 1 }] });
  await clustersRepo.create({ memberFindingIds: ['shared'], detectedAt: new Date(Date.UTC(2026, 6, 27, 12, 0)) });
  await clustersRepo.create({ memberFindingIds: ['shared'], detectedAt: new Date(Date.UTC(2026, 6, 27, 12, 1)) });
  const service = createTroubleshootingOverviewService({ clustersRepo, findingStore, logger: { warn() {} } });
  const page = await service.getFaults();
  assert.equal(page.total, 1);
  assert.equal(page.faults.length, 1);
});

test('no clusters means an empty list, and the store is never touched', async () => {
  let touched = false;
  const service = createTroubleshootingOverviewService({
    clustersRepo: { listOpen: async () => [] },
    findingStore: { listByIds: async () => { touched = true; return []; } },
    logger: { warn() {} },
  });
  const page = await service.getFaults();
  assert.deepEqual(page.faults, []);
  assert.equal(page.total, 0);
  assert.equal(touched, false);
});

// --- the endpoint -----------------------------------------------------------
test('401 without a token', async () => {
  const { findingStore, clustersRepo } = await seed();
  assert.equal((await request(appFor({ findingStore, clustersRepo })).get(FAULTS_PATH)).status, 401);
});

test('403 for a viewer — the detail of an operator-gated number stays operator-gated', async () => {
  const { findingStore, clustersRepo } = await seed();
  const res = await request(appFor({ findingStore, clustersRepo })).get(FAULTS_PATH).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('200 for operator and admin', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 2, per: 2 });
  for (const role of ['operator', 'admin']) {
    const res = await request(appFor({ findingStore, clustersRepo })).get(FAULTS_PATH).set('Authorization', authHeader(role));
    assert.equal(res.status, 200, `role ${role}`);
    assert.equal(res.body.total, 4);
    assert.equal(res.body.faults.length, 4);
  }
});

test('400 on an invalid limit', async () => {
  const { findingStore, clustersRepo } = await seed();
  const app = appFor({ findingStore, clustersRepo });
  for (const limit of ['0', '-3', 'x', '1.5', String(MAX_FAULT_PAGE + 1)]) {
    const res = await request(app).get(`${FAULTS_PATH}?limit=${limit}`).set('Authorization', authHeader('operator'));
    assert.equal(res.status, 400, `limit=${limit}`);
    assert.match(res.body.error, /limit/);
  }
});

test('400 on an invalid offset or clusterId', async () => {
  const { findingStore, clustersRepo } = await seed();
  const app = appFor({ findingStore, clustersRepo });
  for (const offset of ['-1', 'x', '2.5']) {
    const res = await request(app).get(`${FAULTS_PATH}?offset=${offset}`).set('Authorization', authHeader('operator'));
    assert.equal(res.status, 400, `offset=${offset}`);
  }
  for (const clusterId of ['0', '-2', 'x']) {
    const res = await request(app).get(`${FAULTS_PATH}?clusterId=${clusterId}`).set('Authorization', authHeader('operator'));
    assert.equal(res.status, 400, `clusterId=${clusterId}`);
  }
});

test('an empty query param is treated as absent, not invalid', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 1, per: 2 });
  const res = await request(appFor({ findingStore, clustersRepo }))
    .get(`${FAULTS_PATH}?limit=&offset=&clusterId=`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
});

test('the endpoint pages, and offset 0 + limit walks the whole set exactly once', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 3, per: 4 });
  const app = appFor({ findingStore, clustersRepo });
  const seen = [];
  let offset = 0;
  for (;;) {
    const res = await request(app).get(`${FAULTS_PATH}?limit=5&offset=${offset}`).set('Authorization', authHeader('operator'));
    assert.equal(res.status, 200);
    seen.push(...res.body.faults.map((f) => f.findingId));
    if (!res.body.hasMore) break;
    offset += res.body.faults.length;
  }
  assert.equal(seen.length, 12);
  assert.equal(new Set(seen).size, 12);
});

test('opening the overview does not fetch the fault rows', async () => {
  const { findingStore, clustersRepo } = await seed({ clusters: 2, per: 3 });
  let fullReads = 0;
  const watched = {
    ...findingStore,
    listByIds: async (ids, opts = {}) => { if (!opts.light) fullReads += 1; return findingStore.listByIds(ids, opts); },
  };
  const res = await request(appFor({ findingStore: watched, clustersRepo }))
    .get(OVERVIEW_PATH).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(fullReads, 0, 'the overview never asks for a full finding row');
  assert.equal(res.body.faults, undefined, 'and it does not carry the rows either');
  assert.equal(res.body.summary.activeFaults, 6, 'yet the figure the link needs is there');
});

test('503 when the aggregation service is not wired', async () => {
  const { createTroubleshootingRouter } = require('../src/routes/troubleshooting');
  const express = require('express');
  const { errorHandler } = require('../src/middleware/errorHandler');
  const app = express();
  app.use('/api/troubleshooting', createTroubleshootingRouter({ overviewService: null }));
  app.use(errorHandler);
  const res = await request(app).get(FAULTS_PATH).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 503);
});

// --- FindingStore.listByIds -------------------------------------------------
function stubPool(rowsById, { chunkSizes = [] } = {}) {
  return {
    pool: {
      query: async (sql, params) => {
        chunkSizes.push(params.length);
        assert.match(sql, /FROM findings WHERE id IN/);
        const light = !/evidence/.test(sql);
        const rows = params.map((id) => rowsById[id]).filter(Boolean).map((r) => (light
          ? { id: r.id, host_id: r.host_id, metric: r.metric, severity: r.severity, kind: r.kind, acked: r.acked, created_at: r.created_at }
          : r));
        return [rows];
      },
    },
  };
}

function dbRow(id) {
  return {
    id, host_id: '1', metric: 'link.errors', severity: 'CRIT', kind: 'anomaly',
    observed: 9, baseline: 1, deviation: 8, window_from: null, window_to: null,
    explanation: 'errors up', evidence: '[{"ts":"2026-07-27T11:50:00.000Z","value":9}]',
    correlated_with: '[]', event_case_id: null, acked: 0, created_at: new Date('2026-07-27T11:50:00.000Z'),
  };
}

test('listByIds batches the ids instead of one query each', async () => {
  const ids = Array.from({ length: 2500 }, (_, i) => `f${i}`);
  const rowsById = Object.fromEntries(ids.map((id) => [id, dbRow(id)]));
  const chunkSizes = [];
  const store = new FindingStore({ db: stubPool(rowsById, { chunkSizes }) });

  const out = await store.listByIds(ids, { light: true });
  assert.equal(out.length, 2500);
  assert.deepEqual(chunkSizes, [1000, 1000, 500], 'three round trips, not 2500');
});

test('listByIds returns the rows in the order asked, deduped, missing ids dropped', async () => {
  const rowsById = { a: dbRow('a'), c: dbRow('c') };
  const store = new FindingStore({ db: stubPool(rowsById) });
  const out = await store.listByIds(['c', 'a', 'c', 'missing', null, '']);
  assert.deepEqual(out.map((r) => r.id), ['c', 'a']);
});

test('listByIds light rows carry no evidence — the caller must ask for the full row', async () => {
  const store = new FindingStore({ db: stubPool({ a: dbRow('a') }) });
  const [light] = await store.listByIds(['a'], { light: true });
  assert.equal(light.severity, 'CRIT');
  assert.equal(light.hostId, '1');
  assert.equal(light.evidence, undefined);
  assert.equal(light.explanation, undefined);

  const [full] = await store.listByIds(['a']);
  assert.equal(full.explanation, 'errors up');
  assert.equal(full.evidence.length, 1);
});

test('listByIds with nothing to fetch never touches the pool', async () => {
  const store = new FindingStore({ db: { pool: { query: async () => { throw new Error('should not query'); } } } });
  assert.deepEqual(await store.listByIds([]), []);
  assert.deepEqual(await store.listByIds(null), []);
  assert.deepEqual(await store.listByIds([null, undefined, '']), []);
});

// --- the view helpers behind the link and its counter -----------------------
test('a fault row reads a device name, not an agent id', () => {
  const m = TV.faultRowModel({ findingId: 'f1', hostId: 3, metric: 'link.errors', severity: 'crit', cause: 'uplink down' }, { 3: 'sw-acc-b' });
  assert.equal(m.deviceLabel, 'sw-acc-b');
  assert.equal(m.severity, 'CRIT');
  assert.equal(m.cause, 'uplink down');
});

test('an unknown or absent host degrades honestly rather than inventing a name', () => {
  assert.equal(TV.faultRowModel({ hostId: 9 }, {}).deviceLabel, 'agent 9');
  assert.equal(TV.faultRowModel({ hostId: null }, {}).deviceLabel, '—');
  assert.equal(TV.faultRowModel({}, null).metric, '—');
  assert.equal(TV.faultRowModel(null).severity, 'INFO');
});

test('the counter says how far a long read has got', () => {
  assert.deepEqual(TV.faultProgress({ loading: true, loaded: 0, total: 0 }), { key: 'tshoot.faults.loadingFirst', params: {} });
  assert.deepEqual(TV.faultProgress({ loading: true, loaded: 200, total: 28574 }), { key: 'tshoot.faults.loading', params: { loaded: 200, total: 28574 } });
  assert.deepEqual(TV.faultProgress({ loading: false, loaded: 200, total: 28574 }), { key: 'tshoot.faults.progress', params: { loaded: 200, total: 28574 } });
  assert.deepEqual(TV.faultProgress(), { key: 'tshoot.faults.progress', params: { loaded: 0, total: 0 } });
});

test('the load-more button never promises more rows than are left', () => {
  assert.equal(TV.faultsRemaining({ loaded: 100, total: 28574 }, 100), 100);
  assert.equal(TV.faultsRemaining({ loaded: 28500, total: 28574 }, 100), 74);
  assert.equal(TV.faultsRemaining({ loaded: 28574, total: 28574 }, 100), 0);
  assert.equal(TV.faultsRemaining({ loaded: 5, total: 2 }, 100), 0);
  assert.equal(TV.faultsRemaining(), 0);
});

test('every string the fault list renders exists in both catalogues', () => {
  const I18n = require('../public/i18n');
  const keys = Object.keys(I18n.STRINGS.en).filter((k) => k.startsWith('tshoot.faults.'));
  assert.ok(keys.length >= 15, 'the fault list has its own catalogue entries');
  for (const key of keys) assert.ok(I18n.has(key, 'da'), `missing da translation for ${key}`);
});
