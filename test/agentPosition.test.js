'use strict';

// An agent's own position on the map (migration 136). For an agent whose site
// is not where it runs — a cloud data centre, a VPN exit — so the traceroute
// map measures its hops from the right place.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { validateAgentPosition } = require('../src/validation/agentValidation');
const { agentPosition } = require('../src/geo/agentPosition');
const { createAgentsRepository } = require('../src/repositories/agentsRepository');
const { buildPathGraph } = require('../src/analysis/pathGraph');
const { createCentroids } = require('../src/geo/centroids');
const {
  makeApp, makeAgentsRepo, makeProbeResultsRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');

// ---- validation ------------------------------------------------------------

test('validateAgentPosition takes numbers, numeric strings or a pasted "lat, lng" pair', () => {
  assert.deepEqual(validateAgentPosition({ latitude: 55.6761, longitude: 12.5683 }).value, { latitude: 55.6761, longitude: 12.5683 });
  assert.deepEqual(validateAgentPosition({ latitude: '52.37', longitude: '4.89' }).value, { latitude: 52.37, longitude: 4.89 });
  assert.deepEqual(validateAgentPosition({ coordinates: ' 55.6761, 12.5683 ' }).value, { latitude: 55.6761, longitude: 12.5683 });
  assert.deepEqual(validateAgentPosition({ coordinates: '-33.8688 151.2093' }).value, { latitude: -33.8688, longitude: 151.2093 });
  assert.deepEqual(validateAgentPosition({ latitude: 1.23456789, longitude: 2 }).value, { latitude: 1.234568, longitude: 2 }, 'rounded to what DECIMAL(9,6) keeps');
});

test('both null clears; an empty body does not', () => {
  assert.deepEqual(validateAgentPosition({ latitude: null, longitude: null }).value, { latitude: null, longitude: null });
  assert.ok(validateAgentPosition({}).errors.latitude, 'an empty PUT must not quietly move the agent back to its site');
  assert.ok(validateAgentPosition([]).errors.latitude);
  assert.ok(validateAgentPosition(null).errors.latitude);
});

test('validateAgentPosition refuses out-of-range, one-sided and non-numeric input', () => {
  assert.ok(validateAgentPosition({ latitude: 91, longitude: 0 }).errors.latitude);
  assert.ok(validateAgentPosition({ latitude: 0, longitude: -181 }).errors.longitude);
  assert.ok(validateAgentPosition({ latitude: 55 }).errors.latitude, 'one without the other');
  assert.ok(validateAgentPosition({ latitude: 55, longitude: null }).errors.latitude);
  assert.ok(validateAgentPosition({ latitude: true, longitude: 1 }).errors.latitude);
  assert.ok(validateAgentPosition({ latitude: 'x', longitude: 1 }).errors.latitude);
  assert.ok(validateAgentPosition({ latitude: '', longitude: 1 }).errors.latitude);
  assert.ok(validateAgentPosition({ coordinates: 'Copenhagen' }).errors.coordinates);
  assert.ok(validateAgentPosition({ coordinates: 42 }).errors.coordinates);
  assert.ok(validateAgentPosition({ coordinates: '95, 10' }).errors.latitude);
});

// ---- which position counts --------------------------------------------------

test('agentPosition: the agent\'s own position wins, then the site, then none', () => {
  assert.deepEqual(agentPosition({ latitude: 52.37, longitude: 4.89, location_lat: 55.6, location_lng: 12.5 }), { lat: 52.37, lng: 4.89, source: 'agent' });
  assert.deepEqual(agentPosition({ latitude: null, longitude: null, location_lat: 55.6, location_lng: 12.5 }), { lat: 55.6, lng: 12.5, source: 'site' });
  assert.equal(agentPosition({ latitude: null, location_lat: null }), null);
  assert.equal(agentPosition(null), null);
});

// ---- repository --------------------------------------------------------------

test('setPosition writes both columns, and returns null for an unknown agent', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^UPDATE agents SET latitude/.test(sql)) return [{ affectedRows: params[2] === 9 ? 1 : 0 }];
      return [[{ id: 9, hostname: 'h', latitude: '52.370216', longitude: '4.895168', location_lat: '55.676100', location_lng: '12.568300' }]];
    },
  };
  const repo = createAgentsRepository({ pool });
  const a = await repo.setPosition(9, 52.370216, 4.895168);
  assert.equal(calls[0].sql, 'UPDATE agents SET latitude = ?, longitude = ? WHERE id = ?');
  assert.deepEqual(calls[0].params, [52.370216, 4.895168, 9]);
  assert.equal(a.latitude, 52.370216, 'DECIMAL strings come back as numbers');
  assert.equal(a.location_lat, 55.6761);
  assert.equal(await repo.setPosition(10, null, null), null);
  assert.deepEqual(calls[2].params, [null, null, 10]);
});

test('findForGeo prefers the agent position over the site', async () => {
  let seen = '';
  const repo = createAgentsRepository({ pool: { async query(sql) { seen = sql; return [[]]; } } });
  await repo.findForGeo();
  assert.match(seen, /COALESCE\(a\.latitude, l\.latitude\) AS lat, COALESCE\(a\.longitude, l\.longitude\) AS lng/);
});

// ---- API ---------------------------------------------------------------------

function appWith({ findById, setPosition } = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({
      findById: findById || (async (id) => (id === 9 ? { id: 9, hostname: 'h1' } : null)),
      setPosition: setPosition || (async (id, latitude, longitude) => ({ id, hostname: 'h1', latitude, longitude })),
    }),
  });
}
const put = (app, path, body, role = 'operator') => {
  const r = request(app).put(path);
  if (role) r.set('Authorization', authHeader(role));
  return r.send(body);
};

test('PUT /agents/:id/position sets the position (200)', async () => {
  let saved = null;
  const app = appWith({ setPosition: async (id, la, lo) => { saved = [id, la, lo]; return { id, latitude: la, longitude: lo }; } });
  const res = await put(app, '/agents/9/position', { coordinates: '52.370216, 4.895168' });
  assert.equal(res.status, 200);
  assert.deepEqual(saved, [9, 52.370216, 4.895168]);
  assert.equal(res.body.latitude, 52.370216);
});

test('PUT /agents/:id/position with both null clears it (200)', async () => {
  let saved = null;
  const app = appWith({ setPosition: async (id, la, lo) => { saved = [la, lo]; return { id, latitude: la, longitude: lo }; } });
  const res = await put(app, '/agents/9/position', { latitude: null, longitude: null }, 'admin');
  assert.equal(res.status, 200);
  assert.deepEqual(saved, [null, null]);
});

test('PUT /agents/:id/position: 400 on bad input or id', async () => {
  const app = appWith();
  const bad = await put(app, '/agents/9/position', { latitude: 200, longitude: 0 });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.details.latitude);
  assert.equal((await put(app, '/agents/9/position', {})).status, 400);
  assert.equal((await put(app, '/agents/9/position', { coordinates: 'Copenhagen' })).status, 400);
  assert.equal((await put(app, '/agents/abc/position', { latitude: 1, longitude: 1 })).status, 400);
});

test('PUT /agents/:id/position: 401 without a token, 403 for a viewer', async () => {
  const app = appWith();
  assert.equal((await put(app, '/agents/9/position', { latitude: 1, longitude: 1 }, null)).status, 401);
  assert.equal((await put(app, '/agents/9/position', { latitude: 1, longitude: 1 }, 'viewer')).status, 403);
});

test('PUT /agents/:id/position: 404 for an unknown agent, also when it vanishes mid-request', async () => {
  assert.equal((await put(appWith(), '/agents/10/position', { latitude: 1, longitude: 1 })).status, 404);
  const gone = appWith({ setPosition: async () => null });
  assert.equal((await put(gone, '/agents/9/position', { latitude: 1, longitude: 1 })).status, 404);
});

test('PUT /agents/:id/position: 500 when the store fails', async () => {
  const res = await put(appWith({ setPosition: throwingAsync('db down') }), '/agents/9/position', { latitude: 1, longitude: 1 });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

test('an unknown route next to it is 404', async () => {
  assert.equal((await put(appWith(), '/agents/9/positions', { latitude: 1, longitude: 1 })).status, 404);
});

// ---- the path map uses it -----------------------------------------------------

const DO_TRACE = [{
  type: 'traceroute', target: 'us.cnn.com', ts: '2026-09-25T10:00:00Z', ok: true,
  hops: [{ hop: 1, ip: '5.101.110.7', rttMs: 1 }, { hop: 2, ip: '143.244.192.32', rttMs: 1.2 }],
}];
const geoProvider = { lookup: (ip) => (ip.startsWith('5.') ? { country: 'CZ', asn: 14061, asnName: 'DigitalOcean' } : { country: 'CA', asn: 14061, asnName: 'DigitalOcean' }) };
const centroids = createCentroids();

test('GET /api/probes/path measures from the agent position, and stops asking about the cloud', async () => {
  const agentsRepo = makeAgentsRepo({
    findById: async (id) => (id === 9 ? { id, hostname: 'h1', latitude: 52.3702, longitude: 4.8952, location_lat: 55.6761, location_lng: 12.5683 } : null),
  });
  const res = await request(makeApp({ agentsRepo, probeResultsRepo: makeProbeResultsRepo({ findByAgent: async () => DO_TRACE }), geoProvider, centroids }))
    .get('/api/probes/path?agentId=9').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.origin.lat, res.body.origin.lng, res.body.origin.source], [52.3702, 4.8952, 'agent']);
  assert.equal(res.body.nodes[0].lat, 52.3702, 'the path starts at the agent, not its site');
  assert.equal(res.body.nodes[1].lat, 52.3702, 'a 1 ms hop is drawn at the agent');
  assert.equal(res.body.originHint, null, 'an own position answers the cloud hint');
});

test('with only a site position the cloud hint still shows', () => {
  const g = buildPathGraph(DO_TRACE, { geoProvider, centroids, origin: { lat: 55.6761, lng: 12.5683, source: 'site' } });
  assert.equal(g.originHint.provider, 'DigitalOcean');
});
