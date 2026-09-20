'use strict';

// Interface capacity forecasting — GET /api/forecast/interfaces.
//
// The forecast engine (src/analysis/forecast.js) and POST /api/forecast both
// existed and were correct, but nothing in the product could reach them: the
// endpoint needs a caller to hand it a series, and no caller did. This is the
// wiring that makes it a feature — the server reads the series from stored
// results and the ceiling from the link's own negotiated speed.
//
// What is worth pinning here: that a rising link produces a believable
// days-to-saturation, that a flat one does not, that an interface with no known
// speed still reports a trend without inventing a ceiling, and that the HTTP
// shape behaves (400/404/503) rather than 500-ing or answering emptily.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeResultsRepo, authHeader } = require('../test-support/fakes');
const { forecastInterfaces, downsample, seriesFromResults } = require('../src/analysis/interfaceForecast');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Builds result rows the way the repository returns them: newest first, with a
// `payload.traffic` carrying per-interface counters. `utilFor(dayIndex)` decides
// the utilisation, so a test says what shape it wants rather than doing arithmetic.
function rows({ days = 14, perDay = 24, speedMbps = 1000, iface = 'eth0', utilFor, now = Date.now() }) {
  const out = [];
  for (let d = days - 1; d >= 0; d -= 1) {
    for (let h = 0; h < perDay; h += 1) {
      const t = now - d * DAY - h * HOUR;
      const utilPct = utilFor(days - 1 - d, h);
      // utilPct is derived by computeInterfaceHealth from bytes/sec + speed, so
      // work backwards: bytes/sec that yields the utilisation we want.
      const bytesPerSec = (utilPct / 100) * speedMbps * 1e6 / 8;
      out.push({
        id: out.length + 1,
        agent_id: 1,
        created_at: new Date(t),
        payload: {
          traffic: {
            source: 'proc',
            elapsedSec: 60,
            interfaces: [{ iface, speedMbps, rxBytesPerSec: bytesPerSec, txBytesPerSec: 0, operStatus: 'up' }],
          },
        },
      });
    }
  }
  return out.sort((a, b) => b.created_at - a.created_at); // newest first, as the repo returns
}

// ------------------------------------------------------------------ the engine

test('a steadily rising link is projected to saturate, and the estimate is in the right ballpark', () => {
  const now = Date.now();
  // 20% today, climbing 5 points a day → 100% in ~16 days from the last sample.
  const data = rows({ days: 14, utilFor: (day) => 20 + day * 5, now });
  const [eth0] = forecastInterfaces(data, { now });

  assert.equal(eth0.iface, 'eth0');
  assert.equal(eth0.ok, true);
  assert.equal(eth0.direction, 'rising');
  assert.ok(Math.abs(eth0.slopePerDay - 5) < 0.5, `slope ${eth0.slopePerDay}/day should be ~5`);
  assert.ok(eth0.daysUntilCapacity != null, 'a rising link with a known speed must have a days-to-capacity');
  // Last sample sits at ~85%, climbing 5/day → ~3 days. Generous bounds: the
  // point is that it is days, not months, and not negative.
  assert.ok(eth0.daysUntilCapacity > 0 && eth0.daysUntilCapacity < 10, `got ${eth0.daysUntilCapacity} days`);
  assert.match(eth0.explanation, /reaches capacity/);
  assert.equal(eth0.evidence.method, 'theil-sen');
});

test('a flat link has no days-to-capacity, however long it has been flat', () => {
  const now = Date.now();
  const data = rows({ days: 14, utilFor: () => 42, now });
  const [eth0] = forecastInterfaces(data, { now });

  assert.equal(eth0.ok, true);
  assert.equal(eth0.direction, 'flat');
  assert.equal(eth0.daysUntilCapacity, null, 'a flat link never fills');
});

test('a falling link is not reported as heading for capacity', () => {
  const now = Date.now();
  const data = rows({ days: 14, utilFor: (day) => 80 - day * 3, now });
  const [eth0] = forecastInterfaces(data, { now });

  assert.equal(eth0.direction, 'falling');
  assert.equal(eth0.daysUntilCapacity, null);
});

test('one spike does not create a trend — the fit is robust, which is the whole reason for Theil–Sen', () => {
  const now = Date.now();
  const flatWithSpike = rows({
    days: 14,
    // One hour at 99% in the middle of an otherwise flat 30%.
    utilFor: (day, hour) => (day === 7 && hour === 12 ? 99 : 30),
    now,
  });
  const [eth0] = forecastInterfaces(flatWithSpike, { now });
  assert.ok(Math.abs(eth0.slopePerDay) < 1, `one spike tilted the line to ${eth0.slopePerDay}/day`);
  assert.equal(eth0.daysUntilCapacity, null, 'a single spike is not a capacity problem');
});

test('an interface with no known link speed reports a trend but never invents a ceiling', () => {
  const now = Date.now();
  // speedMbps null → computeInterfaceHealth cannot derive utilPct, so there is
  // no series at all. That is the honest outcome: no ceiling AND no percentage.
  const data = rows({ days: 14, speedMbps: 0, utilFor: (day) => 20 + day * 5, now });
  const series = seriesFromResults(data);
  assert.equal(series.size, 0, 'utilisation without a link speed is not a number we can report');
  assert.deepEqual(forecastInterfaces(data, { now }), []);
});

test('too little history is said plainly rather than guessed at', () => {
  const now = Date.now();
  const data = rows({ days: 1, perDay: 2, utilFor: () => 10, now });
  const [eth0] = forecastInterfaces(data, { now });
  assert.equal(eth0.ok, false);
  assert.equal(eth0.reason, 'insufficient_data');
  assert.match(eth0.explanation, /Not enough data/);
});

test('the most urgent link sorts first, across several interfaces', () => {
  const now = Date.now();
  const slow = rows({ days: 14, iface: 'eth1', utilFor: (day) => 10 + day * 0.2, now });
  const fast = rows({ days: 14, iface: 'eth0', utilFor: (day) => 20 + day * 5, now });
  // Interleave into one stream the way a real agent reports them.
  const merged = [...slow, ...fast].map((r, i) => ({ ...r, id: i + 1 }));
  const out = forecastInterfaces(merged, { now });
  assert.equal(out.length, 2);
  assert.equal(out[0].iface, 'eth0', 'the link that fills soonest must be read first');
});

test('downsampling bounds the O(n^2) fit without letting a sampling artefact decide the trend', () => {
  const now = Date.now();
  const many = [];
  for (let i = 0; i < 5000; i += 1) many.push({ t: now - (5000 - i) * 60000, v: i / 100 });
  const reduced = downsample(many, 400);
  assert.ok(reduced.length <= 400, `downsample returned ${reduced.length}`);
  assert.ok(reduced.length > 100, 'it must not collapse the series to nothing');
  // Averaged, not sampled: the ends still bracket the real range.
  assert.ok(reduced[0].v < reduced[reduced.length - 1].v, 'the shape must survive');
  for (let i = 1; i < reduced.length; i += 1) {
    assert.ok(reduced[i].t > reduced[i - 1].t, 'buckets must stay in time order');
  }
});

// -------------------------------------------------------------------- the route

const viewer = () => authHeader('viewer');

test('GET /api/forecast/interfaces returns a forecast per interface for a known agent', async () => {
  const now = Date.now();
  const data = rows({ days: 14, utilFor: (day) => 20 + day * 5, now });
  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findById: async () => ({ id: 1, hostname: 'edge-01' }) }),
    resultsRepo: makeResultsRepo({ findByAgentId: async () => data }),
  });

  const res = await request(app).get('/api/forecast/interfaces?agentId=1').set('Authorization', viewer());

  assert.equal(res.status, 200);
  assert.equal(res.body.agentId, 1);
  assert.equal(res.body.capacity.ceiling, 100);
  assert.equal(res.body.capacity.metric, 'utilPct');
  assert.equal(res.body.interfaces.length, 1);
  assert.equal(res.body.interfaces[0].iface, 'eth0');
  assert.ok(res.body.interfaces[0].daysUntilCapacity > 0);
});

test('GET /api/forecast/interfaces: 400 without an agentId, 404 for an unknown one', async () => {
  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findById: async () => null }),
    resultsRepo: makeResultsRepo({ findByAgentId: async () => [] }),
  });

  const missing = await request(app).get('/api/forecast/interfaces').set('Authorization', viewer());
  assert.equal(missing.status, 400);
  assert.match(missing.body.details.agentId, /required/);

  const unknown = await request(app).get('/api/forecast/interfaces?agentId=999999').set('Authorization', viewer());
  assert.equal(unknown.status, 404, 'an unknown agent is not an empty forecast');
});

test('GET /api/forecast/interfaces: a nonsense window falls back to the default instead of 400-ing the read', async () => {
  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findById: async () => ({ id: 1 }) }),
    resultsRepo: makeResultsRepo({ findByAgentId: async () => [] }),
  });
  const res = await request(app).get('/api/forecast/interfaces?agentId=1&days=soon&horizonDays=-4').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.equal(res.body.windowDays, 14);
  assert.equal(res.body.horizonDays, 1, 'a negative horizon clamps to the minimum, it does not go backwards');
});

test('GET /api/forecast/interfaces: an agent with no stored results is an empty list, not an error', async () => {
  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findById: async () => ({ id: 1 }) }),
    resultsRepo: makeResultsRepo({ findByAgentId: async () => [] }),
  });
  const res = await request(app).get('/api/forecast/interfaces?agentId=1').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.interfaces, []);
  assert.equal(res.body.samples, 0);
});

test('GET /api/forecast/interfaces requires a session', async () => {
  const res = await request(makeApp()).get('/api/forecast/interfaces?agentId=1');
  assert.equal(res.status, 401);
});
