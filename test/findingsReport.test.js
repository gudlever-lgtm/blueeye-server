'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Findings over time, and the executive report built from them.
//
// The Analysis screen answers "what is wrong NOW". These answer the two
// questions a report is opened for: when did it happen, and where should
// somebody be sent.
//
// The report is DETERMINISTIC on purpose. Every number is computed and every
// sentence is assembled from those numbers, because a document a manager
// forwards to an engineer has to be defensible line by line.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildNetworkReport, renderNetworkReportHtml, MIN_WARN_TO_NAME } = require('../src/analysis/networkReport');
const { makeApp, makeFindingStore, makeAgentsRepo, authHeader } = require('../test-support/fakes');

const agents = () => makeAgentsRepo({
  findAll: async () => ([
    { id: 7, display_name: 'oslo-edge-01', location_name: 'Oslo' },
    { id: 8, hostname: 'cph-core-02', location_name: 'Copenhagen' },
  ]),
});

const SUMMARY = {
  total: 500, acked: 20, unacked: 480,
  bySeverity: { CRIT: 30, WARN: 470, INFO: 0 },
  byMetric: [{ metric: 'probe.latency', count: 400 }, { metric: 'if.12.in.errPps', count: 100 }],
  byHost: [
    { hostId: 7, count: 400, crit: 28, warn: 372, info: 0, acked: 10, lastAt: '2026-09-20T12:00:00.000Z',
      topMetrics: [{ metric: 'probe.latency', count: 380, crit: 28 }, { metric: 'probe.loss', count: 20, crit: 0 }] },
    { hostId: 8, count: 100, crit: 2, warn: 98, info: 0, acked: 10, lastAt: '2026-09-20T11:00:00.000Z',
      topMetrics: [{ metric: 'if.12.in.errPps', count: 100, crit: 2 }] },
    { hostId: 9, count: 1, crit: 0, warn: 1, info: 0, acked: 0, lastAt: '2026-09-20T09:00:00.000Z',
      topMetrics: [{ metric: 'cpu', count: 1, crit: 0 }] },
  ],
};

const trendOf = (counts) => counts.map((c, i) => ({
  bucket: `2026-09-${String(i + 1).padStart(2, '0')}`, count: c, crit: 0, warn: c, info: 0, acked: 0,
}));

const build = (over = {}) => buildNetworkReport({
  summary: SUMMARY,
  trend: trendOf([10, 10, 10, 10]),
  hostName: (id) => ({ 7: 'oslo-edge-01', 8: 'cph-core-02' }[id] || `#${id}`),
  locationOf: (id) => ({ 7: 'Oslo', 8: 'Copenhagen' }[id] || null),
  ...over,
});

// ---------------------------------------------------------- the structure
test('the report names the worst places, worst first, with what to fix', () => {
  const r = build();
  assert.equal(r.places[0].host, 'oslo-edge-01', 'most criticals leads');
  assert.equal(r.places[0].location, 'Oslo');
  // The ISSUES, because that column is the instruction — not a count somebody
  // then has to go and interpret.
  assert.deepEqual(r.places[0].issues.map((i) => i.metric), ['probe.latency', 'probe.loss']);
  assert.equal(r.places[1].host, 'cph-core-02');
});

test('a place too quiet to name is counted, not listed', () => {
  // An executive report that lists forty sites reads as "everything is
  // broken", which is the same as saying nothing.
  const r = build();
  assert.ok(!r.places.some((p) => p.host === '#9'), 'a single warning got its own row');
  assert.equal(r.totals.placesNotNamed, 1);
  assert.ok(MIN_WARN_TO_NAME > 1, 'the threshold has to be more than one finding');
});

test('the trend is a comparison, and a short period says so instead of guessing', () => {
  assert.equal(build({ trend: trendOf([10, 10, 10, 10]) }).direction, 'flat');
  assert.equal(build({ trend: trendOf([100, 100, 10, 10]) }).direction, 'better');
  assert.equal(build({ trend: trendOf([10, 10, 100, 100]) }).direction, 'worse');
  // Two points is not a trend, it is two numbers.
  assert.equal(build({ trend: trendOf([1, 100]) }).direction, 'unknown');
  assert.equal(build({ trend: [] }).direction, 'unknown');
});

test('a clean period says so plainly rather than rendering empty tables', () => {
  const r = buildNetworkReport({ summary: { total: 0, bySeverity: {}, byHost: [], byMetric: [] } });
  assert.equal(r.totals.findings, 0);
  assert.equal(r.places.length, 0);
  const html = renderNetworkReportHtml(r);
  assert.match(html, /No findings were recorded/);
});

test('findings with no place worth naming report the SPREAD, not an arbitrary host', () => {
  const thin = {
    total: 12, acked: 0, unacked: 12, bySeverity: { CRIT: 0, WARN: 12, INFO: 0 }, byMetric: [],
    byHost: Array.from({ length: 12 }, (_, i) => ({
      hostId: 100 + i, count: 1, crit: 0, warn: 1, info: 0, acked: 0, topMetrics: [],
    })),
  };
  const html = renderNetworkReportHtml(buildNetworkReport({ summary: thin, trend: trendOf([3, 3, 3, 3]) }));
  assert.match(html, /broad, thin spread/);
});

// ------------------------------------------------------------- the document
test('the document renders through the NIS2 chrome, in the requested locale', () => {
  const en = renderNetworkReportHtml(build({ locale: 'en' }), { org: 'Acme' });
  assert.match(en, /<!DOCTYPE html>/);
  assert.match(en, /Network status/);
  assert.match(en, /Acme/);
  assert.match(en, /oslo-edge-01/);
  assert.match(en, /probe\.latency/, 'the issue to fix is in the document');

  // The locale is a per-request parameter, not module state — two people can
  // pull a report in two languages at once.
  const da = renderNetworkReportHtml(build({ locale: 'da' }));
  assert.match(da, /Netv/, 'the Danish title');
  assert.match(da, /lang="da-DK"/, 'htmlLang is a full tag, not a bare language');
});

test('no model is called to write it', () => {
  // The whole point: a report forwarded to an engineer is defensible line by
  // line. If this module ever grows a provider call, this fails.
  //
  // COMMENTS ARE STRIPPED FIRST. The prose above explains WHY there is no model
  // here, which means it mentions one — and a check that read the explanation
  // as a violation would be a test nobody could satisfy.
  const src = require('fs').readFileSync(require.resolve('../src/analysis/networkReport.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/fetch\(|chat\(|openai|mistral|assistant/i.test(src), 'the report reached for a model');
});

// ----------------------------------------------------------------- the API
const get = (app, path, role = 'viewer') => request(app).get(path).set('Authorization', authHeader(role));

async function seeded() {
  const findingStore = makeFindingStore();
  const at = (h) => new Date(Date.now() - h * 60 * 60 * 1000);
  await findingStore.save({ id: 'a', hostId: '7', metric: 'probe.latency', severity: 'CRIT', kind: 'ANOMALY', createdAt: at(1) });
  await findingStore.save({ id: 'b', hostId: '7', metric: 'probe.latency', severity: 'WARN', kind: 'ANOMALY', createdAt: at(2) });
  await findingStore.save({ id: 'c', hostId: '8', metric: 'cpu', severity: 'WARN', kind: 'ANOMALY', createdAt: at(30) });
  return findingStore;
}

test('GET /api/findings/trend buckets by hour or day, and refuses anything else', async () => {
  const app = makeApp({ findingStore: await seeded(), agentsRepo: agents() });

  const day = await get(app, '/api/findings/trend');
  assert.equal(day.status, 200);
  assert.equal(day.body.bucket, 'day');
  assert.ok(day.body.points.length >= 1);
  assert.ok(day.body.points.every((p) => p.bucket && typeof p.count === 'number'));

  const hour = await get(app, '/api/findings/trend?bucket=hour');
  assert.equal(hour.body.bucket, 'hour');
  // An hour bucket splits what a day bucket merged.
  assert.ok(hour.body.points.length >= day.body.points.length);

  assert.equal((await get(app, '/api/findings/trend?bucket=week')).status, 400);
  assert.equal((await get(app, '/api/findings/trend?severity=NOPE')).status, 400);
  assert.equal((await request(app).get('/api/findings/trend')).status, 401);
});

test('a store too old to bucket answers 404, not a blank chart', async () => {
  // The route is mounted against whatever store it was wired with. A store
  // without trend() is a real state during a rolling upgrade, and a chart drawn
  // from an empty 200 reads as "nothing happened" — which is a lie.
  const findingStore = await seeded();
  delete findingStore.trend;
  const app = makeApp({ findingStore, agentsRepo: agents() });

  assert.equal((await get(app, '/api/findings/trend')).status, 404);
  // The report still comes out: the places are the summary's, and it simply
  // cannot say which direction things moved.
  const report = await get(app, '/api/findings/report');
  assert.equal(report.status, 200);
  assert.equal(report.body.report.direction, 'unknown');
});

test('GET /api/findings/report answers JSON, and HTML when asked', async () => {
  const app = makeApp({ findingStore: await seeded(), agentsRepo: agents() });

  const json = await get(app, '/api/findings/report');
  assert.equal(json.status, 200);
  assert.equal(json.body.report.periodDays, 30);
  assert.ok(json.body.report.totals.findings >= 3);
  // The agent NAME and its site, resolved server-side.
  assert.ok(JSON.stringify(json.body.report.places).includes('oslo-edge-01'));

  const html = await get(app, '/api/findings/report?format=html');
  assert.equal(html.status, 200);
  assert.match(html.headers['content-type'], /text\/html/);
  assert.match(html.headers['content-disposition'], /attachment; filename="network-status-/);
  assert.match(html.text, /<!DOCTYPE html>/);
});

test('the report period is bounded', async () => {
  const app = makeApp({ findingStore: await seeded(), agentsRepo: agents() });
  assert.equal((await get(app, '/api/findings/report?days=0')).status, 400);
  assert.equal((await get(app, '/api/findings/report?days=366')).status, 400);
  assert.equal((await get(app, '/api/findings/report?days=1')).status, 200);
});

test('a store failure is a 500, not an empty report', async () => {
  // A report that silently says "nothing is wrong" because the database is
  // down is the worst possible output of this endpoint.
  const findingStore = makeFindingStore({ summary: async () => { throw new Error('db down'); } });
  const app = makeApp({ findingStore, agentsRepo: agents() });
  assert.equal((await get(app, '/api/findings/report')).status, 500);
});
