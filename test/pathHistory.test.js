'use strict';

// The history of one traced path: the runs kept apart, what changed between
// two of them, and where the route moved.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { summarise, routeKey, withRouteChanges, diffRuns } = require('../src/analysis/pathHistory');
const { createProbeResultsRepository } = require('../src/repositories/probeResultsRepository');
const {
  makeApp, makeAgentsRepo, makeProbeResultsRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');

const hop = (n, ip, rttMs, extra = {}) => ({ hop: n, ip, rttMs, ...extra });
const run = (id, ts, hops, extra = {}) => ({ id, ts, agentId: 9, type: 'traceroute', target: 'example.com', ok: true, hops, ...extra });

const A = run(1, '2026-09-25T10:00:00Z', [hop(1, '10.0.0.1', 1), hop(2, '62.1.1.1', 5), hop(3, '93.1.1.1', 20)]);
// A hop inserted in the middle, and the last hop got slower.
const B = run(2, '2026-09-25T11:00:00Z', [hop(1, '10.0.0.1', 1), hop(2, '62.1.1.1', 5), hop(3, '80.9.9.9', 9), hop(4, '93.1.1.1', 60)]);

// ---- summaries -------------------------------------------------------------

test('a summary carries what the list is scanned for, and no hops', () => {
  const s = summarise(run(3, '2026-09-25T12:00:00Z', [hop(1, '10.0.0.1', 1), { hop: 2, ip: null, rttMs: null }, hop(3, '93.1.1.1', 30)], { lossPct: 4 }));
  assert.equal(s.id, 3);
  assert.equal(s.hopCount, 3);
  assert.equal(s.respondingCount, 2);
  assert.equal(s.silentCount, 1, 'a silent router is worth counting, and is not a fault');
  assert.equal(s.rttMs, 30, 'the last hop that answered is the end-to-end number');
  assert.equal(s.lossPct, 4);
  assert.equal(s.hops, undefined, 'the hop array must not ride along on a list row');
});

test('a run that produced nothing summarises as itself, with the reason', () => {
  const s = summarise({ id: 4, ts: '2026-09-25T13:00:00Z', type: 'traceroute', target: 'x', ok: false, hops: [], detail: 'could not resolve the target name' });
  assert.equal(s.ok, false);
  assert.equal(s.hopCount, 0);
  assert.equal(s.rttMs, null);
  assert.equal(s.detail, 'could not resolve the target name');
  assert.equal(s.routeKey, '');
});

// ---- route identity --------------------------------------------------------

test('a route is the addresses that answered, in order', () => {
  assert.equal(routeKey(A.hops), '10.0.0.1>62.1.1.1>93.1.1.1');
  assert.notEqual(routeKey(A.hops), routeKey(B.hops));
});

test('a router that stops answering ICMP is not a reroute', () => {
  const quiet = [hop(1, '10.0.0.1', 1), { hop: 2, ip: null, rttMs: null }, hop(3, '93.1.1.1', 20)];
  const loud = [hop(1, '10.0.0.1', 1), hop(3, '93.1.1.1', 20)];
  assert.equal(routeKey(quiet), routeKey(loud), 'a silent hop is not part of a route\'s identity');
});

test('withRouteChanges marks the newer run, never the oldest, and returns newest-first', () => {
  const C = run(3, '2026-09-25T12:00:00Z', B.hops); // same route as B
  const rows = withRouteChanges([B, A, C]);
  assert.deepEqual(rows.map((r) => r.id), [3, 2, 1], 'newest first, whatever order they came in');
  assert.equal(rows[2].routeChanged, false, 'the oldest run has nothing to have changed from');
  assert.equal(rows[1].routeChanged, true, 'B took a different route from A');
  assert.equal(rows[0].routeChanged, false, 'C took the same route as B');
});

test('a failed run neither counts as a change nor hides the next one', () => {
  const failed = { id: 9, ts: '2026-09-25T10:30:00Z', type: 'traceroute', target: 'example.com', ok: false, hops: [] };
  const rows = withRouteChanges([A, failed, B]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(9).routeChanged, false, 'a run that traced nothing is not a reroute');
  assert.equal(byId.get(2).routeChanged, true, 'and it does not hide the reroute after it');
});

// ---- the diff --------------------------------------------------------------

test('an inserted hop is ONE added row, not every hop after it changing', () => {
  const d = diffRuns(A, B);
  assert.equal(d.routeChanged, true);
  assert.equal(d.addedCount, 1);
  assert.equal(d.removedCount, 0);
  assert.deepEqual(d.rows.map((r) => `${r.kind}:${r.ip}`), [
    'same:10.0.0.1', 'same:62.1.1.1', 'added:80.9.9.9', 'same:93.1.1.1',
  ]);
  const last = d.rows[3];
  assert.equal(last.beforeHop, 3);
  assert.equal(last.afterHop, 4, 'it shifted position, which is not a change of hop');
  assert.equal(last.deltaMs, 40);
});

test('the diff names the hop where the time appeared, and the end-to-end change', () => {
  const d = diffRuns(A, B);
  assert.equal(d.rttBeforeMs, 20);
  assert.equal(d.rttAfterMs, 60);
  assert.equal(d.rttDeltaMs, 40);
  assert.equal(d.worstDelta.ip, '93.1.1.1');
  assert.equal(d.worstDelta.deltaMs, 40);
});

test('a hop that went away reads as removed', () => {
  const d = diffRuns(B, A);
  assert.equal(d.removedCount, 1);
  assert.equal(d.addedCount, 0);
  assert.equal(d.rows.find((r) => r.kind === 'removed').ip, '80.9.9.9');
  assert.equal(d.rttDeltaMs, -40, 'and the other direction is the other sign');
});

test('two runs of the same route differ in nothing but their numbers', () => {
  const slower = run(5, '2026-09-25T12:00:00Z', [hop(1, '10.0.0.1', 1), hop(2, '62.1.1.1', 8), hop(3, '93.1.1.1', 22)]);
  const d = diffRuns(A, slower);
  assert.equal(d.routeChanged, false);
  assert.equal(d.addedCount + d.removedCount, 0);
  assert.ok(d.rows.every((r) => r.kind === 'same'));
  assert.equal(d.worstDelta.ip, '62.1.1.1', '3 ms on hop 2 beats 2 ms on hop 3');
});

test('an empty run on either side is a diff, not a crash', () => {
  const empty = { id: 6, ts: '2026-09-25T09:00:00Z', hops: [] };
  assert.equal(diffRuns(empty, A).addedCount, 3);
  assert.equal(diffRuns(A, empty).removedCount, 3);
  assert.equal(diffRuns(null, null).rows.length, 0);
  assert.equal(diffRuns(undefined, { hops: 'nonsense' }).rows.length, 0);
});

// ---- the repository ---------------------------------------------------------

test('listRuns pages newest-first and bounds what a caller may ask for', async () => {
  const calls = [];
  const repo = createProbeResultsRepository({ pool: { async query(sql, params) { calls.push({ sql, params }); return [[]]; } } });
  await repo.listRuns({ agentId: 9, type: 'traceroute', target: 'x', limit: 40, offset: 80 });
  assert.match(calls[0].sql, /ORDER BY ts DESC, id DESC LIMIT \? OFFSET \?/);
  assert.deepEqual(calls[0].params, [9, 'traceroute', 'x', 40, 80]);
  await repo.listRuns({ agentId: 9, type: 'traceroute', target: 'x', limit: 9999, offset: -5 });
  assert.deepEqual(calls[1].params.slice(-2), [50, 0], 'an absurd page falls back to the default');
});

test('findRunById is scoped to the agent, so another agent\'s run reads as absent', async () => {
  const calls = [];
  const repo = createProbeResultsRepository({ pool: { async query(sql, params) { calls.push({ sql, params }); return [[]]; } } });
  await repo.findRunById(12, { agentId: 9 });
  assert.match(calls[0].sql, /WHERE id = \? AND agent_id = \? LIMIT 1/);
  assert.deepEqual(calls[0].params, [12, 9]);
});

test('previousRun breaks a timestamp tie by id, so two runs in the same second still order', async () => {
  let seen = null;
  const repo = createProbeResultsRepository({ pool: { async query(sql, params) { seen = { sql, params }; return [[]]; } } });
  await repo.previousRun({ agentId: 9, type: 'traceroute', target: 'x', beforeTs: '2026-09-25T10:00:00Z', beforeId: 7 });
  assert.match(seen.sql, /ts < \? OR \(ts = \? AND id < \?\)/);
  assert.deepEqual(seen.params, [9, 'traceroute', 'x', '2026-09-25T10:00:00Z', '2026-09-25T10:00:00Z', 7]);
});

// ---- API --------------------------------------------------------------------

const agentsRepo = makeAgentsRepo({ findById: async (id) => (id === 9 ? { id, hostname: 'h1' } : null) });
const get = (app, path, role = 'viewer') => {
  const r = request(app).get(path);
  return role ? r.set('Authorization', authHeader(role)) : r;
};
const historyApp = (over = {}) => makeApp({
  agentsRepo,
  probeResultsRepo: makeProbeResultsRepo({
    findByAgent: async () => [A, B],
    listRuns: async () => [B, A],
    countRuns: async () => 2,
    findRunById: async (id) => [A, B].find((r) => r.id === id) || null,
    previousRun: async () => A,
    ...over,
  }),
});

test('GET /api/probes/path/runs lists the runs with their route changes (200)', async () => {
  const res = await get(historyApp(), '/api/probes/path/runs?agentId=9&target=example.com');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.deepEqual(res.body.runs.map((r) => r.id), [2, 1]);
  assert.equal(res.body.runs[0].routeChanged, true);
  assert.equal(res.body.runs[0].hops, undefined, 'a list never carries hop arrays');
});

test('GET /api/probes/path/runs compares the page\'s oldest row with the run before it', async () => {
  // Page 2: its oldest row must be judged against the run before it, not read
  // as "no change" because the page happens to start there.
  const older = run(0, '2026-09-25T09:00:00Z', [hop(1, '10.0.0.1', 1)]);
  const res = await get(historyApp({ listRuns: async () => [A], previousRun: async () => older }), '/api/probes/path/runs?agentId=9&target=example.com&offset=1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.runs.map((r) => r.id), [1], 'the run fetched for context is not itself listed');
  assert.equal(res.body.runs[0].routeChanged, true);
});

test('GET /api/probes/path/runs: empty, 400, 404', async () => {
  const none = await get(makeApp({ agentsRepo }), '/api/probes/path/runs?agentId=9');
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.runs, [], 'no traces yet is an answer, not an error');
  assert.equal((await get(historyApp(), '/api/probes/path/runs')).status, 400);
  assert.equal((await get(historyApp(), '/api/probes/path/runs?agentId=10')).status, 404);
  assert.equal((await get(historyApp(), '/api/probes/path/runs?agentId=9', null)).status, 401);
});

test('GET /api/probes/path?runId= returns that one run, not a median', async () => {
  const res = await get(historyApp(), '/api/probes/path?agentId=9&runId=2');
  assert.equal(res.status, 200);
  assert.equal(res.body.runId, 2);
  assert.equal(res.body.samples, 1, 'one run means one sample');
  assert.equal(res.body.nodes.length, 5, 'source + its four hops');
  assert.equal((await get(historyApp({ findRunById: async () => null }), '/api/probes/path?agentId=9&runId=99')).status, 404);
});

test('GET /api/probes/path/compare defaults to the run before (200)', async () => {
  const res = await get(historyApp(), '/api/probes/path/compare?agentId=9&runId=2');
  assert.equal(res.status, 200);
  assert.equal(res.body.before.id, 1);
  assert.equal(res.body.after.id, 2);
  assert.equal(res.body.diff.routeChanged, true);
  assert.equal(res.body.diff.rttDeltaMs, 40);
});

test('GET /api/probes/path/compare orders the pair oldest-first, whichever way it was asked', async () => {
  const res = await get(historyApp(), '/api/probes/path/compare?agentId=9&runId=1&againstRunId=2');
  assert.equal(res.status, 200);
  assert.equal(res.body.before.id, 1, '"changed" only means something in one direction');
  assert.equal(res.body.diff.rttDeltaMs, 40);
});

test('GET /api/probes/path/compare: the first run ever has nothing to compare with', async () => {
  const res = await get(historyApp({ previousRun: async () => null }), '/api/probes/path/compare?agentId=9&runId=2');
  assert.equal(res.status, 200);
  assert.equal(res.body.before, null);
  assert.equal(res.body.diff, null, 'null, not an empty diff that reads as "nothing changed"');
});

test('GET /api/probes/path/compare: 400, 404 and a refusal to compare two different paths', async () => {
  const app = historyApp();
  assert.equal((await get(app, '/api/probes/path/compare?agentId=9')).status, 400);
  assert.equal((await get(app, '/api/probes/path/compare?runId=1')).status, 400);
  assert.equal((await get(app, '/api/probes/path/compare?agentId=9&runId=2&againstRunId=x')).status, 400);
  assert.equal((await get(app, '/api/probes/path/compare?agentId=10&runId=1')).status, 404);
  assert.equal((await get(historyApp({ findRunById: async () => null }), '/api/probes/path/compare?agentId=9&runId=1')).status, 404);

  const other = run(3, '2026-09-25T12:00:00Z', [hop(1, '10.0.0.1', 1)], { target: 'elsewhere.example' });
  const mixed = historyApp({ findRunById: async (id) => [A, other].find((r) => r.id === id) || null });
  const res = await get(mixed, '/api/probes/path/compare?agentId=9&runId=1&againstRunId=3');
  assert.equal(res.status, 400, 'two different paths would diff as "every hop changed"');
});

test('GET /api/probes/path/compare: 500 when the store fails', async () => {
  const res = await get(historyApp({ findRunById: throwingAsync('db down') }), '/api/probes/path/compare?agentId=9&runId=1');
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

test('an unknown path endpoint next to these is 404', async () => {
  assert.equal((await get(historyApp(), '/api/probes/path/history')).status, 404);
});
