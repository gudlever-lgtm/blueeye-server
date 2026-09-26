'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, authHeader } = require('../test-support/fakes');

const admin = () => authHeader('admin');
const viewer = () => authHeader('viewer');

// ---- GET /api/settings (admin overview) -----------------------------------
test('GET /api/settings returns the effective configuration for an admin', async () => {
  const res = await request(makeApp()).get('/api/settings').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.ok(res.body.license && typeof res.body.license === 'object');
  assert.ok(res.body.analysis && 'critSigma' in res.body.analysis);
  assert.ok(res.body.alerting);
  assert.ok(res.body.retention);
  assert.ok(res.body.map.tileUrl.includes('{z}'));
  // TSDB status is reported (read-only, env-driven) with the connection target
  // but never the password.
  assert.ok(res.body.tsdb && res.body.tsdb.enabled === true);
  assert.equal(res.body.tsdb.host, 'tsdb.example');
  assert.equal(res.body.tsdb.database, 'blueeye_telemetry');
  assert.equal(res.body.tsdb.passwordSet, true);
  assert.equal(res.body.tsdb.editable, false);
  assert.equal(res.body.tsdb.source, 'env');
  assert.ok(!('password' in res.body.tsdb));
  assert.ok(!JSON.stringify(res.body).includes('super-secret-pw'));
  // No secrets leaked.
  assert.ok(!JSON.stringify(res.body).toLowerCase().includes('api_key'));
});

test('GET /api/settings is admin-only (viewer 403, no token 401)', async () => {
  assert.equal((await request(makeApp()).get('/api/settings').set('Authorization', viewer())).status, 403);
  assert.equal((await request(makeApp()).get('/api/settings')).status, 401);
});

// ---- PUT /api/settings/map -------------------------------------------------
test('PUT /api/settings/map updates the tile source and /api/map/config reflects it', async () => {
  const app = makeApp(); // one app instance so the in-memory store persists across requests
  const put = await request(app).put('/api/settings/map').set('Authorization', admin())
    .send({ tileUrl: 'https://eu.tiles.local/{z}/{x}/{y}.png', maxZoom: 17 });
  assert.equal(put.status, 200);
  assert.equal(put.body.map.tileUrl, 'https://eu.tiles.local/{z}/{x}/{y}.png');
  assert.equal(put.body.map.maxZoom, 17);

  const cfg = await request(app).get('/api/map/config').set('Authorization', viewer());
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.tileUrl, 'https://eu.tiles.local/{z}/{x}/{y}.png');
  assert.equal(cfg.body.maxZoom, 17);
});

test('PUT /api/settings/map rejects an invalid tile URL with 400 + details', async () => {
  const res = await request(makeApp()).put('/api/settings/map').set('Authorization', admin())
    .send({ tileUrl: 'http://no-placeholders.example/' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details && res.body.details.tileUrl);
});

test('PUT /api/settings/map is admin-only (viewer 403)', async () => {
  const res = await request(makeApp()).put('/api/settings/map').set('Authorization', viewer()).send({ maxZoom: 10 });
  assert.equal(res.status, 403);
});

// ---- GET /api/map/config (ungated, viewer+) -------------------------------
test('GET /api/map/config is available to viewers and includes the geocoder URL', async () => {
  const res = await request(makeApp()).get('/api/map/config').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.ok(res.body.tileUrl.includes('{z}'));
  assert.ok(typeof res.body.geocodeUrl === 'string');
});

test('GET /api/map/config without a token returns 401', async () => {
  assert.equal((await request(makeApp()).get('/api/map/config')).status, 401);
});

// ---- PUT /api/settings/throughput (speed-test health thresholds) -----------
test('PUT /api/settings/throughput saves thresholds and GET reflects them (admin)', async () => {
  const app = makeApp();
  const put = await request(app).put('/api/settings/throughput').set('Authorization', admin()).send({ enabled: true, downBadMbps: 50, downWarnMbps: 100 });
  assert.equal(put.status, 200);
  assert.equal(put.body.throughput.enabled, true);
  assert.equal(put.body.throughput.downBadMbps, 50);
  const get = await request(app).get('/api/settings').set('Authorization', admin());
  assert.equal(get.body.throughput.enabled, true);
  assert.equal(get.body.throughput.downBadMbps, 50);
});

test('PUT /api/settings/throughput rejects a negative threshold (400)', async () => {
  const res = await request(makeApp()).put('/api/settings/throughput').set('Authorization', admin()).send({ downBadMbps: -5 });
  assert.equal(res.status, 400);
});

test('PUT /api/settings/throughput is admin-only (viewer 403)', async () => {
  const res = await request(makeApp()).put('/api/settings/throughput').set('Authorization', viewer()).send({ enabled: true });
  assert.equal(res.status, 403);
});

test('GET /api/settings includes throughput defaults (disabled)', async () => {
  const res = await request(makeApp()).get('/api/settings').set('Authorization', admin());
  assert.ok(res.body.throughput && res.body.throughput.enabled === false);
});

// ---- PUT /api/settings/events (bulk-action policy) -------------------------
// The Events page's bulk cap used to be a constant in the router, which meant a
// number nobody could change on a server that could happily take more — or
// less. It is a per-server decision, so it is a per-server setting.
test('PUT /api/settings/events saves the bulk policy and GET reflects it (admin)', async () => {
  const app = makeApp();
  const put = await request(app).put('/api/settings/events').set('Authorization', admin())
    .send({ bulkMax: 1200, bulkAll: false });
  assert.equal(put.status, 200);
  assert.equal(put.body.events.bulkMax, 1200);
  assert.equal(put.body.events.bulkAll, false);
  const get = await request(app).get('/api/settings').set('Authorization', admin());
  assert.equal(get.body.events.bulkMax, 1200);
  assert.equal(get.body.events.bulkAll, false);
});

test('PUT /api/settings/events refuses a cap outside 1..5000 (400)', async () => {
  const app = makeApp();
  for (const bulkMax of [0, 5001, 2.5, 'lots']) {
    const res = await request(app).put('/api/settings/events').set('Authorization', admin()).send({ bulkMax });
    assert.equal(res.status, 400, String(bulkMax));
  }
});

test('PUT /api/settings/events is admin-only (viewer 403)', async () => {
  const res = await request(makeApp()).put('/api/settings/events').set('Authorization', viewer()).send({ bulkMax: 10 });
  assert.equal(res.status, 403);
});

test('GET /api/settings includes the event defaults (500, all-form on)', async () => {
  const res = await request(makeApp()).get('/api/settings').set('Authorization', admin());
  assert.deepEqual(res.body.events, { bulkMax: 500, bulkAll: true });
});

// ---- PUT /api/settings/agents (default traffic source for new agents) ------
// The two values are ONE decision. An sFlow source with no exporter binds a
// collector and waits for datagrams that never arrive — worse than proc, which
// at least produces interface rates. If the source default ever moves without
// the exporter default moving with it, a fresh install ships empty flow
// screens, which is the state this default was changed to fix.
test('a fresh install defaults to sFlow, with the local exporter that makes it collect', async () => {
  const res = await request(makeApp()).get('/api/settings').set('Authorization', admin());
  assert.ok(res.body.agents);
  assert.equal(res.body.agents.defaultTrafficSource, 'sflow');
  assert.equal(res.body.agents.defaultSflowHsflowd, true, 'sFlow without an exporter collects nothing');
});

test('PUT /api/settings/agents saves the default traffic source and GET reflects it (admin)', async () => {
  const app = makeApp();
  const put = await request(app).put('/api/settings/agents').set('Authorization', admin())
    .send({ defaultTrafficSource: 'sflow', defaultSflowHsflowd: true });
  assert.equal(put.status, 200);
  assert.equal(put.body.agents.defaultTrafficSource, 'sflow');
  assert.equal(put.body.agents.defaultSflowHsflowd, true);
  const get = await request(app).get('/api/settings').set('Authorization', admin());
  assert.equal(get.body.agents.defaultTrafficSource, 'sflow');
  assert.equal(get.body.agents.defaultSflowHsflowd, true);
});

test('PUT /api/settings/agents rejects an unknown source with 400 + details', async () => {
  const res = await request(makeApp()).put('/api/settings/agents').set('Authorization', admin())
    .send({ defaultTrafficSource: 'wireshark' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details && res.body.details.defaultTrafficSource);
});

test('PUT /api/settings/agents rejects snmp as a fleet-wide default (400)', async () => {
  const res = await request(makeApp()).put('/api/settings/agents').set('Authorization', admin())
    .send({ defaultTrafficSource: 'snmp' });
  assert.equal(res.status, 400);
});

test('PUT /api/settings/agents is admin-only (viewer 403)', async () => {
  const res = await request(makeApp()).put('/api/settings/agents').set('Authorization', viewer())
    .send({ defaultTrafficSource: 'netflow' });
  assert.equal(res.status, 403);
});

// ---- PUT /api/settings/ladder (the diagnostic ladder) ----------------------
//
// The order is the part with teeth: six rungs are a causal chain, and an order
// that breaks it must be REFUSED rather than quietly corrected — a screen
// showing an order the server is not walking is the bug this prevents.

const { LAYERS: LADDER_LAYERS, DEFAULT_CONFIG: LADDER_DEFAULTS } = require('../src/connectionTest/ladder');

test('GET /api/settings carries the ladder, defaulted to the shipped one', async () => {
  const res = await request(makeApp()).get('/api/settings').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.ladder.order, [...LADDER_DEFAULTS.order]);
  assert.deepEqual(res.body.ladder.ports, [...LADDER_DEFAULTS.ports]);
  assert.equal(res.body.ladder.certWarnDays, LADDER_DEFAULTS.certWarnDays);
  for (const l of LADDER_LAYERS) assert.equal(res.body.ladder.enabled[l], true, l);
});

test('PUT /api/settings/ladder saves a legal order and GET reflects it (admin)', async () => {
  const app = makeApp();
  const order = ['nat_lb', 'dns', 'routing', 'firewall', 'tcp', 'tls', 'application', 'arp'];
  const put = await request(app).put('/api/settings/ladder').set('Authorization', admin())
    .send({ order, enabled: { arp: false }, ports: [443, 8443], certWarnDays: 30, lossThresholdPct: 10 });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.ladder.order, order);
  assert.equal(put.body.ladder.enabled.arp, false);
  assert.equal(put.body.ladder.enabled.dns, true, 'an unlisted rung was turned off');
  assert.deepEqual(put.body.ladder.ports, [443, 8443]);
  const get = await request(app).get('/api/settings').set('Authorization', admin());
  assert.deepEqual(get.body.ladder.order, order);
  assert.equal(get.body.ladder.lossThresholdPct, 10);
});

test('PUT /api/settings/ladder refuses an order that breaks the causal chain', async () => {
  // TLS above TCP would report "stops at TLS" for a port that never opened.
  const res = await request(makeApp()).put('/api/settings/ladder').set('Authorization', admin())
    .send({ order: ['dns', 'arp', 'routing', 'firewall', 'tls', 'tcp', 'nat_lb', 'application'] });
  assert.equal(res.status, 400);
  assert.match(res.body.details.order, /causal chain/);
  // And it is refused, not corrected: nothing was stored.
  const get = await request(makeApp()).get('/api/settings').set('Authorization', admin());
  assert.deepEqual(get.body.ladder.order, [...LADDER_DEFAULTS.order]);
});

test('PUT /api/settings/ladder: viewer 403, no token 401, junk 400 and never 500', async () => {
  assert.equal((await request(makeApp()).put('/api/settings/ladder').set('Authorization', viewer()).send({ ports: [443] })).status, 403);
  assert.equal((await request(makeApp()).put('/api/settings/ladder').send({ ports: [443] })).status, 401);
  const bad = [
    { order: ['dns'] },
    { order: 'nope' },
    { enabled: 'no' },
    { enabled: { nope: true } },
    { enabled: { dns: 'yes' } },
    { ports: [] },
    { ports: [0] },
    { ports: [70000] },
    { ports: ['x'] },
    { ports: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { certWarnDays: -1 },
    { certWarnDays: 400 },
    { lossThresholdPct: 0 },
    { lossThresholdPct: 101 },
  ];
  for (const body of bad) {
    const res = await request(makeApp()).put('/api/settings/ladder').set('Authorization', admin()).send(body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} → ${res.status}`);
    assert.ok(res.body.details && Object.keys(res.body.details).length, JSON.stringify(body));
  }
  for (const junk of [{}, [], 'str', null]) {
    const res = await request(makeApp()).put('/api/settings/ladder').set('Authorization', admin())
      .set('Content-Type', 'application/json').send(JSON.stringify(junk));
    assert.ok(res.status < 500, `${JSON.stringify(junk)} → ${res.status}`);
  }
});
