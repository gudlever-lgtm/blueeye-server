'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { FindingStore } = require('../findings');
const { Severity, FindingKind } = require('../constants');

// A tiny in-memory fake of the mysql2 pool that understands the exact SQL the
// FindingStore issues (INSERT / SELECT ... [WHERE host_id] [created_at >=] /
// UPDATE acked). Rows are kept as the DB would store them (JSON as strings).
function makeFakePool() {
  const rows = [];
  return {
    rows,
    async query(sql, params = []) {
      if (/^INSERT INTO findings/i.test(sql)) {
        const [id, host_id, metric, severity, kind, observed, baseline, deviation,
          window_from, window_to, explanation, evidence, correlated_with, acked, created_at] = params;
        rows.push({ id, host_id, metric, severity, kind, observed, baseline, deviation,
          window_from, window_to, explanation, evidence, correlated_with, acked, created_at });
        return [{ affectedRows: 1 }];
      }
      if (/^SELECT .* FROM findings WHERE id = \?/i.test(sql)) {
        return [rows.filter((r) => r.id === params[0])];
      }
      // Shared WHERE parser — clauses appear in buildFilter() order:
      // host_id, severity, metric, created_at >=, created_at <=.
      const applyWhere = () => {
        let out = rows.slice();
        let p = 0;
        if (/host_id = \?/.test(sql)) { const h = params[p++]; out = out.filter((r) => r.host_id === h); }
        if (/severity = \?/.test(sql)) { const s = params[p++]; out = out.filter((r) => r.severity === s); }
        if (/metric = \?/.test(sql)) { const m = params[p++]; out = out.filter((r) => r.metric === m); }
        if (/created_at >= \?/.test(sql)) { const s = params[p++]; out = out.filter((r) => r.created_at >= s); }
        if (/created_at <= \?/.test(sql)) { const u = params[p++]; out = out.filter((r) => r.created_at <= u); }
        return out;
      };
      const devs = (list) => list.map((r) => r.deviation).filter((v) => v != null).map(Number);
      const avg = (list) => (devs(list).length ? devs(list).reduce((a, b) => a + b, 0) / devs(list).length : null);
      const max = (list) => (devs(list).length ? Math.max(...devs(list)) : null);
      if (/GROUP BY severity/i.test(sql)) {
        const by = new Map();
        for (const r of applyWhere()) { const g = by.get(r.severity) || { cnt: 0, acked: 0 }; g.cnt += 1; g.acked += (r.acked === 1 || r.acked === true) ? 1 : 0; by.set(r.severity, g); }
        return [[...by.entries()].map(([severity, g]) => ({ severity, cnt: g.cnt, acked: g.acked }))];
      }
      if (/GROUP BY metric/i.test(sql)) {
        const by = new Map();
        for (const r of applyWhere()) { const g = by.get(r.metric) || []; g.push(r); by.set(r.metric, g); }
        return [[...by.entries()].map(([metric, list]) => ({ metric, cnt: list.length, avg_dev: avg(list), max_dev: max(list) }))];
      }
      if (/GROUP BY host_id/i.test(sql)) {
        const by = new Map();
        for (const r of applyWhere()) { const g = by.get(r.host_id) || []; g.push(r); by.set(r.host_id, g); }
        return [[...by.entries()].map(([host_id, list]) => ({
          host_id, cnt: list.length,
          crit: list.filter((r) => r.severity === 'CRIT').length,
          warn: list.filter((r) => r.severity === 'WARN').length,
          info: list.filter((r) => r.severity === 'INFO').length,
          acked: list.filter((r) => r.acked === 1 || r.acked === true).length,
          avg_dev: avg(list), max_dev: max(list),
          last_at: list.reduce((mx, r) => (r.created_at > mx ? r.created_at : mx), list[0].created_at),
        }))];
      }
      if (/^SELECT .* FROM findings/i.test(sql)) {
        const out = applyWhere();
        out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // DESC
        return [out];
      }
      if (/^UPDATE findings SET acked = 1 WHERE id = \?/i.test(sql)) {
        const r = rows.find((x) => x.id === params[0]);
        if (!r) return [{ affectedRows: 0 }];
        r.acked = 1;
        return [{ affectedRows: 1 }];
      }
      if (/^UPDATE findings SET correlated_with = \? WHERE id = \?/i.test(sql)) {
        const r = rows.find((x) => x.id === params[1]);
        if (!r) return [{ affectedRows: 0 }];
        r.correlated_with = params[0];
        return [{ affectedRows: 1 }];
      }
      if (/^UPDATE findings SET event_case_id = \? WHERE id = \?/i.test(sql)) {
        const r = rows.find((x) => x.id === params[1]);
        if (!r) return [{ affectedRows: 0 }];
        r.event_case_id = params[0];
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected SQL in fake pool: ${sql}`);
    },
  };
}

function sample(over = {}) {
  return { hostId: 'h1', metric: 'cpu', value: 99, ts: new Date('2026-01-01T00:00:00Z'), labels: {}, ...over };
}

function finding(over = {}) {
  return {
    hostId: 'h1',
    metric: 'cpu',
    severity: Severity.CRIT,
    kind: FindingKind.ANOMALY,
    observed: 99,
    baseline: 10,
    deviation: 8,
    window: [new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:01:00Z')],
    explanation: 'cpu at 99 deviated 8.0σ from baseline (10)',
    evidence: [sample()],
    correlatedWith: [],
    ...over,
  };
}

test('save throws on an empty explanation', async () => {
  const store = new FindingStore({ db: { pool: makeFakePool() } });
  await assert.rejects(() => store.save(finding({ explanation: '   ' })), /explanation/);
});

test('save throws on an empty evidence array', async () => {
  const store = new FindingStore({ db: { pool: makeFakePool() } });
  await assert.rejects(() => store.save(finding({ evidence: [] })), /evidence/);
});

test('save persists and returns a finding with an id', async () => {
  const store = new FindingStore({ db: { pool: makeFakePool() } });
  const saved = await store.save(finding());
  assert.ok(saved.id && typeof saved.id === 'string');
  assert.equal(saved.acked, false);
});

test('list filters correctly on hostId and since', async () => {
  const pool = makeFakePool();
  const store = new FindingStore({ db: { pool } });
  await store.save(finding({ hostId: 'h1', createdAt: new Date('2026-01-01T00:00:00Z') }));
  await store.save(finding({ hostId: 'h2', createdAt: new Date('2026-01-02T00:00:00Z') }));
  await store.save(finding({ hostId: 'h1', createdAt: new Date('2026-01-03T00:00:00Z') }));

  const all = await store.list();
  assert.equal(all.length, 3);

  const h1 = await store.list('h1');
  assert.equal(h1.length, 2);
  assert.ok(h1.every((f) => f.hostId === 'h1'));

  const since = await store.list('h1', new Date('2026-01-02T12:00:00Z'));
  assert.equal(since.length, 1);
  assert.equal(since[0].createdAt.toISOString(), '2026-01-03T00:00:00.000Z');
});

test('list filters on severity and metric', async () => {
  const store = new FindingStore({ db: { pool: makeFakePool() } });
  await store.save(finding({ metric: 'cpu', severity: Severity.CRIT }));
  await store.save(finding({ metric: 'cpu', severity: Severity.WARN }));
  await store.save(finding({ metric: 'mem', severity: Severity.WARN }));

  const crit = await store.list(undefined, undefined, undefined, undefined, { severity: 'CRIT' });
  assert.equal(crit.length, 1);
  assert.equal(crit[0].severity, 'CRIT');

  const mem = await store.list(undefined, undefined, undefined, undefined, { metric: 'mem' });
  assert.equal(mem.length, 1);
  assert.equal(mem[0].metric, 'mem');
});

test('summary aggregates by severity, metric and host', async () => {
  const store = new FindingStore({ db: { pool: makeFakePool() } });
  await store.save(finding({ hostId: 'h1', metric: 'cpu', severity: Severity.CRIT, deviation: 6 }));
  await store.save(finding({ hostId: 'h1', metric: 'cpu', severity: Severity.WARN, deviation: 4 }));
  await store.save(finding({ hostId: 'h2', metric: 'mem', severity: Severity.WARN, deviation: 3 }));

  const s = await store.summary();
  assert.equal(s.total, 3);
  assert.deepEqual(s.bySeverity, { CRIT: 1, WARN: 2, INFO: 0 });
  const cpu = s.byMetric.find((m) => m.metric === 'cpu');
  assert.equal(cpu.count, 2);
  assert.equal(cpu.avgDeviation, 5);
  assert.equal(cpu.maxDeviation, 6);
  const h1 = s.byHost.find((h) => h.hostId === 'h1');
  assert.equal(h1.count, 2);
  assert.equal(h1.crit, 1);
  assert.equal(h1.warn, 1);
});

test('summary honours the metric filter', async () => {
  const store = new FindingStore({ db: { pool: makeFakePool() } });
  await store.save(finding({ hostId: 'h1', metric: 'cpu', severity: Severity.CRIT, deviation: 6 }));
  await store.save(finding({ hostId: 'h2', metric: 'mem', severity: Severity.WARN, deviation: 3 }));

  const s = await store.summary({ metric: 'cpu' });
  assert.equal(s.total, 1);
  assert.deepEqual(s.bySeverity, { CRIT: 1, WARN: 0, INFO: 0 });
  assert.equal(s.byMetric.length, 1);
  assert.equal(s.byMetric[0].metric, 'cpu');
});

test('ack sets acked=true (and returns false for unknown id)', async () => {
  const store = new FindingStore({ db: { pool: makeFakePool() } });
  const saved = await store.save(finding());
  assert.equal(await store.ack(saved.id), true);
  const got = await store.get(saved.id);
  assert.equal(got.acked, true);
  assert.equal(await store.ack('no-such-id'), false);
});

test('setCorrelations persists the linked ids (and returns false for unknown id)', async () => {
  const store = new FindingStore({ db: { pool: makeFakePool() } });
  const a = await store.save(finding());
  const b = await store.save(finding());
  assert.equal(await store.setCorrelations(a.id, [b.id]), true);
  const got = await store.get(a.id);
  assert.deepEqual(got.correlatedWith, [b.id]);
  assert.equal(await store.setCorrelations('no-such-id', [b.id]), false);
});

test('setCorrelations coerces a non-array argument to an empty list', async () => {
  const store = new FindingStore({ db: { pool: makeFakePool() } });
  const a = await store.save(finding());
  assert.equal(await store.setCorrelations(a.id, null), true);
  const got = await store.get(a.id);
  assert.deepEqual(got.correlatedWith, []);
});

test('a freshly saved finding has no event case', async () => {
  const store = new FindingStore({ db: { pool: makeFakePool() } });
  const saved = await store.save(finding());
  const got = await store.get(saved.id);
  assert.equal(got.eventCaseId, null);
});

test('setEventCase links (and unlinks) a finding to an event case', async () => {
  const store = new FindingStore({ db: { pool: makeFakePool() } });
  const a = await store.save(finding());
  assert.equal(await store.setEventCase(a.id, 42), true);
  assert.equal((await store.get(a.id)).eventCaseId, 42);
  assert.equal(await store.setEventCase(a.id, null), true);
  assert.equal((await store.get(a.id)).eventCaseId, null);
  assert.equal(await store.setEventCase('no-such-id', 1), false);
});

test('constructor requires the db pool handle', () => {
  assert.throws(() => new FindingStore({}), /db handle/);
});
