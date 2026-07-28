'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// API tests for the universal search field (Fase 1).
//
// GET /api/search?q=&limit=  viewer+
//
// The response shape changed here: the old endpoint returned three fixed buckets
// ({ agents, locations, flows }); it now returns one ranked `hits` list where
// every hit carries its type, its SOURCE and its LAST_SEEN. That is the point of
// the rewrite — a technician has to be able to tell an answer built on
// yesterday's data from one built on three-week-old data before acting on it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeLocationsRepo,
  makeFlowsRepo,
  makeArpEntriesRepo,
  makeDiscoveredDevicesRepo,
  makeLldpNeighborsRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');
const { createFlowsRepository } = require('../src/repositories/flowsRepository');

const AGENTS = [
  {
    id: 1,
    hostname: 'fw-aarhus',
    display_name: 'Firewall Aarhus',
    status: 'online',
    location_name: 'Aarhus',
    last_seen: '2026-07-28T10:00:00.000Z',
    capabilities: { ips: ['10.1.0.5'] },
  },
  {
    id: 2,
    hostname: 'gw-odense',
    display_name: null,
    status: 'offline',
    location_name: 'Odense',
    last_seen: '2026-07-20T10:00:00.000Z',
    capabilities: { ips: ['10.2.0.5'] },
  },
];

const LOCATIONS = [{ id: 7, name: 'Aarhus' }, { id: 8, name: 'Odense' }];

function appWith(overrides = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => AGENTS }),
    locationsRepo: makeLocationsRepo({ findAll: async () => LOCATIONS }),
    ...overrides,
  });
}

const search = (app, q, role = 'viewer', extra = '') =>
  request(app).get(`/api/search?q=${encodeURIComponent(q)}${extra}`).set('Authorization', authHeader(role));

// Seeds an ARP fake with one binding on agent 1.
async function arpWith(entries = [{ ip: '10.1.0.50', mac: '00:11:22:33:44:55', interface: 'eth0' }]) {
  const repo = makeArpEntriesRepo();
  await repo.upsertMany(1, entries, { source: 'capabilities', at: new Date('2026-07-27T08:00:00Z') });
  return repo;
}

// ------------------------------------------------------------------ auth / 400
test('GET /api/search returns 401 without a token', async () => {
  assert.equal((await request(appWith()).get('/api/search?q=aarhus')).status, 401);
});

test('viewer, operator and admin may all search', async () => {
  for (const role of ['viewer', 'operator', 'admin']) {
    assert.equal((await search(appWith(), 'aarhus', role)).status, 200, `${role} should be allowed`);
  }
});

test('GET /api/search returns 400 for a missing, empty or too-short q', async () => {
  const app = appWith();
  assert.equal((await request(app).get('/api/search').set('Authorization', authHeader('viewer'))).status, 400);
  assert.equal((await search(app, '')).status, 400);
  assert.equal((await search(app, '   ')).status, 400);
  const short = await search(app, 'a');
  assert.equal(short.status, 400);
  assert.match(short.body.error, /at least 2 characters/);
});

test('GET /api/search returns 400 for an over-long q', async () => {
  const res = await search(appWith(), 'x'.repeat(65));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at most 64 characters/);
});

test('GET /api/search returns 400 for an out-of-range limit', async () => {
  const app = appWith();
  for (const limit of ['0', '-1', '101', 'abc', '1.5']) {
    const res = await search(app, 'aarhus', 'viewer', `&limit=${limit}`);
    assert.equal(res.status, 400, `limit=${limit} should be rejected`);
  }
  assert.equal((await search(app, 'aarhus', 'viewer', '&limit=5')).status, 200);
});

// ------------------------------------------------------------------- 200 shape
test('every hit carries type, display_name, target, confidence, source and last_seen', async () => {
  const res = await search(appWith(), 'aarhus');
  assert.equal(res.status, 200);
  assert.ok(res.body.hits.length > 0);
  for (const hit of res.body.hits) {
    for (const key of ['type', 'display_name', 'target', 'confidence', 'source']) {
      assert.ok(hit[key], `hit is missing ${key}: ${JSON.stringify(hit)}`);
    }
    // last_seen must be PRESENT on every hit — null is a valid, meaningful value
    // ("we cannot date this"), but the key going missing would let the UI silently
    // omit the freshness the technician is supposed to judge.
    assert.ok('last_seen' in hit, 'hit is missing last_seen');
  }
});

// --------------------------------------------------------------- host resolver
test('hostname matches on exact, prefix and substring — never exact-only', async () => {
  const app = appWith();

  const exact = await search(app, 'fw-aarhus');
  assert.equal(exact.body.hits.find((h) => h.type === 'host').confidence, 'exact');

  const prefix = await search(app, 'fw-');
  assert.ok(prefix.body.hits.some((h) => h.type === 'host' && h.confidence === 'high'));

  const substring = await search(app, 'odense');
  const hit = substring.body.hits.find((h) => h.type === 'host');
  assert.ok(hit, 'a substring must still match');
  assert.equal(hit.target, 'agent:2');
});

test('an agent with no display_name falls back to its hostname', async () => {
  const res = await search(appWith(), 'gw-odense');
  assert.equal(res.body.hits.find((h) => h.type === 'host').display_name, 'gw-odense');
});

// ----------------------------------------------------------------- agent id
test('a numeric query resolves an agent id exactly', async () => {
  const res = await search(appWith(), '2');
  // "2" is too short to pass validation, so use a real id path instead.
  assert.equal(res.status, 400);

  const app = appWith({ agentsRepo: makeAgentsRepo({ findAll: async () => [{ ...AGENTS[0], id: 42 }] }) });
  const ok = await search(app, '42');
  assert.equal(ok.status, 200);
  const hit = ok.body.hits.find((h) => h.source === 'agents.id');
  assert.ok(hit, 'expected an agent-id hit');
  assert.equal(hit.confidence, 'exact');
  assert.equal(hit.target, 'agent:42');
});

// ---------------------------------------------------------------- site resolver
test('a site name resolves to its location', async () => {
  const res = await search(appWith(), 'Aarhus');
  const hit = res.body.hits.find((h) => h.type === 'site');
  assert.ok(hit);
  assert.equal(hit.target, 'location:7');
  assert.equal(hit.confidence, 'exact');
  // Locations carry no timestamp; null is the honest answer, not a faked date.
  assert.equal(hit.last_seen, null);
});

// ------------------------------------------------------------------ IP resolver
test('an exact IP resolves to the agent that owns it', async () => {
  const res = await search(appWith(), '10.1.0.5');
  const hit = res.body.hits.find((h) => h.source === 'agents.capabilities.ips');
  assert.ok(hit);
  assert.equal(hit.confidence, 'exact');
  assert.equal(hit.target, 'agent:1');
});

test('an IP resolves through the ARP table with its own source and last_seen', async () => {
  const res = await search(appWith({ arpEntriesRepo: await arpWith() }), '10.1.0.50');
  const hit = res.body.hits.find((h) => h.type === 'ip' && h.source.startsWith('arp_entries'));
  assert.ok(hit, 'expected an ARP-sourced hit');
  assert.equal(hit.confidence, 'exact');
  assert.match(hit.display_name, /00:11:22:33:44:55/);
  assert.equal(hit.last_seen, '2026-07-27T08:00:00.000Z');
});

test('an IP merely seen in traffic ranks below one that is owned', async () => {
  const flowsRepo = makeFlowsRepo({ agentIdsForIp: async ({ ip }) => (ip === '10.1.0.5' ? [2] : []) });
  const res = await search(appWith({ flowsRepo }), '10.1.0.5');
  const owned = res.body.hits.findIndex((h) => h.source === 'agents.capabilities.ips');
  const seen = res.body.hits.findIndex((h) => h.source === 'flow_records');
  assert.ok(owned !== -1 && seen !== -1, 'expected both kinds of hit');
  assert.ok(owned < seen, 'an owned address must outrank one merely observed in transit');
});

test('a partial IP is not treated as an address', async () => {
  // "192.168.1." is a prefix of a name-shaped field, not an address — the spec
  // is explicit that IP matches exactly.
  const res = await search(appWith(), '192.168.1.');
  assert.equal(res.status, 200);
  assert.equal(res.body.hits.filter((h) => h.type === 'ip').length, 0);
});

// ----------------------------------------------------------------- MAC resolver
test('the same MAC in three formats produces the same hit', async () => {
  const arpEntriesRepo = await arpWith();
  const app = appWith({ arpEntriesRepo });

  const forms = ['00:11:22:33:44:55', '00-11-22-33-44-55', '001122334455', '0011.2233.4455', '00:11:22:33:44:55'.toUpperCase()];
  const results = [];
  for (const form of forms) {
    const res = await search(app, form);
    assert.equal(res.status, 200, `${form} should search`);
    const hit = res.body.hits.find((h) => h.type === 'mac');
    assert.ok(hit, `${form} should resolve the MAC`);
    results.push(hit);
  }
  // Identical target, display name and confidence across every spelling.
  for (const hit of results.slice(1)) {
    assert.equal(hit.target, results[0].target);
    assert.equal(hit.display_name, results[0].display_name);
    assert.equal(hit.confidence, results[0].confidence);
  }
});

test('a MAC hit reports the ARP source and its freshness', async () => {
  const res = await search(appWith({ arpEntriesRepo: await arpWith() }), '00:11:22:33:44:55');
  const hit = res.body.hits.find((h) => h.type === 'mac');
  assert.match(hit.source, /^arp_entries/);
  assert.equal(hit.last_seen, '2026-07-27T08:00:00.000Z');
  assert.match(hit.detail, /seen by Firewall Aarhus/);
  assert.match(hit.detail, /on eth0/);
});

test('a MAC matching only an LLDP chassis id is reported at LOW confidence', async () => {
  // An LLDP chassis id identifies a switch, not the client being looked for.
  // Returning it as a confident answer would send the technician to the wrong box.
  const lldpNeighborsRepo = makeLldpNeighborsRepo({
    listAll: async () => [{
      local_agent_id: 1,
      local_chassis_id: '00:aa:bb:cc:dd:01',
      remote_chassis_id: 'other',
      last_seen: '2026-07-26T00:00:00.000Z',
    }],
  });
  const res = await search(appWith({ lldpNeighborsRepo, arpEntriesRepo: makeArpEntriesRepo() }), '00:aa:bb:cc:dd:01');
  const hit = res.body.hits.find((h) => h.type === 'mac');
  assert.ok(hit);
  assert.equal(hit.confidence, 'low');
  assert.equal(hit.source, 'lldp_neighbors');
  assert.match(hit.display_name, /LLDP chassis/);
});

// -------------------------------------------------------------- service resolver
test('a port resolves to its well-known service name', async () => {
  const res = await search(appWith(), '443');
  const hit = res.body.hits.find((h) => h.type === 'service');
  assert.ok(hit);
  assert.match(hit.display_name, /HTTPS/);
  assert.equal(hit.confidence, 'exact');
});

test('a service name resolves to the port it conventionally runs on', async () => {
  const res = await search(appWith(), 'https');
  const hit = res.body.hits.find((h) => h.type === 'service');
  assert.ok(hit);
  assert.match(hit.display_name, /443/);
});

// ------------------------------------------------------------- device resolver
test('a discovered (unmonitored) device is searchable by IP and rDNS name', async () => {
  const discoveredDevicesRepo = makeDiscoveredDevicesRepo();
  await discoveredDevicesRepo.upsertCandidate({ ip: '10.9.9.9', hostname: 'printer-3f', seenAt: new Date('2026-07-25T00:00:00Z') });

  const byIp = await search(appWith({ discoveredDevicesRepo }), '10.9.9.9');
  const ipHit = byIp.body.hits.find((h) => h.type === 'device');
  assert.ok(ipHit, 'expected the discovered device by IP');
  assert.equal(ipHit.confidence, 'exact');
  assert.equal(ipHit.source, 'discovered_devices');

  const byName = await search(appWith({ discoveredDevicesRepo }), 'printer');
  assert.ok(byName.body.hits.some((h) => h.type === 'device'));
});

// ---------------------------------------------------------------- empty result
test('a query that matches nothing is 200 with an empty list, not 404', async () => {
  const res = await search(appWith(), 'zzzznotathing');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.hits, []);
  assert.equal(res.body.total, 0);
  assert.equal(res.body.partial, false);
});

// ------------------------------------------------------------------- ordering
test('results are ordered by confidence, then by last_seen descending', async () => {
  const agentsRepo = makeAgentsRepo({
    findAll: async () => [
      { id: 1, hostname: 'sw-core-old', display_name: null, last_seen: '2026-01-01T00:00:00.000Z', capabilities: {} },
      { id: 2, hostname: 'sw-core-new', display_name: null, last_seen: '2026-07-28T00:00:00.000Z', capabilities: {} },
      { id: 3, hostname: 'edge-sw-core', display_name: null, last_seen: '2026-07-27T00:00:00.000Z', capabilities: {} },
    ],
  });
  const res = await search(appWith({ agentsRepo }), 'sw-core');
  const hosts = res.body.hits.filter((h) => h.type === 'host');

  // The two prefix matches (high) come before the substring match (medium)...
  assert.deepEqual(hosts.map((h) => h.confidence), ['high', 'high', 'medium']);
  // ...and within the prefix tier, the freshest agent wins.
  assert.deepEqual(hosts.slice(0, 2).map((h) => h.target), ['agent:2', 'agent:1']);
});

test('a hit with no last_seen sorts last within its confidence tier', async () => {
  const agentsRepo = makeAgentsRepo({
    findAll: async () => [
      { id: 1, hostname: 'core-a', display_name: null, last_seen: null, capabilities: {} },
      { id: 2, hostname: 'core-b', display_name: null, last_seen: '2026-07-28T00:00:00.000Z', capabilities: {} },
    ],
  });
  const res = await search(appWith({ agentsRepo }), 'core-');
  const hosts = res.body.hits.filter((h) => h.type === 'host');
  assert.deepEqual(hosts.map((h) => h.target), ['agent:2', 'agent:1']);
});

// --------------------------------------------------------------------- limit
test('limit caps the returned hits and truncated reports the overflow', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, hostname: `node-${String(i).padStart(2, '0')}`, display_name: null,
    last_seen: '2026-07-28T00:00:00.000Z', capabilities: {},
  }));
  const app = appWith({ agentsRepo: makeAgentsRepo({ findAll: async () => many }) });

  const res = await search(app, 'node-', 'viewer', '&limit=5');
  assert.equal(res.body.hits.length, 5);
  assert.equal(res.body.total, 30);
  assert.equal(res.body.truncated, true);
});

// ------------------------------------------------------------ partial failure
test('one failing resolver degrades to partial rather than failing the search', async () => {
  // A dead CMDB or ARP table must not blank the field mid-incident — the local
  // answers are still worth serving.
  const arpEntriesRepo = makeArpEntriesRepo({ findByMac: throwingAsync('arp table unavailable') });
  const res = await search(appWith({ arpEntriesRepo }), '00:11:22:33:44:55');

  assert.equal(res.status, 200);
  assert.equal(res.body.partial, true);
  assert.deepEqual(res.body.failedSources, ['mac']);
});

test('GET /api/search returns 500 when the agent list itself fails', async () => {
  // Loading agents happens BEFORE the fan-out and every resolver depends on it,
  // so this one is genuinely fatal rather than partial.
  const agentsRepo = makeAgentsRepo({ findAll: throwingAsync() });
  const res = await search(appWith({ agentsRepo }), 'aarhus');

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  assert.ok(!/at Object|at async|\.js:\d+:\d+/.test(JSON.stringify(res.body)), 'must not leak a stack trace');
});

test('GET /api/search 500 hides the underlying message in production', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const agentsRepo = makeAgentsRepo({ findAll: throwingAsync() });
    const res = await search(appWith({ agentsRepo }), 'aarhus');
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Internal Server Error' });
  } finally {
    process.env.NODE_ENV = prev;
  }
});

// ------------------------------------------------------------- user resolver
test('the username resolver is present but empty, and says so', async () => {
  // No end-user identity source exists in this product (see the Fase 0 audit),
  // so the resolver returns nothing and the response NAMES it as unresolved.
  // Silently returning zero results would let the technician conclude their
  // search term was wrong rather than that we cannot answer that question.
  const res = await search(appWith(), 'lars');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.unresolved, ['user']);
  assert.equal(res.body.hits.filter((h) => h.type === 'user').length, 0);
});

// -------------------------------------------------------------- repository unit
test('flowsRepository.agentIdsForIp binds the IP and windows the query', async () => {
  const queries = [];
  const pool = { async query(sql, params) { queries.push({ sql, params }); return [[{ agent_id: 5 }, { agent_id: 5 }, { agent_id: 6 }]]; } };
  const repo = createFlowsRepository({ pool });
  const ids = await repo.agentIdsForIp({ ip: '10.0.0.1', since: new Date('2026-06-01'), until: new Date('2026-06-02') });
  assert.deepEqual(ids, [5, 6]); // de-duplicated
  assert.match(queries[0].sql, /src_ip = \? OR dst_ip = \? OR ext_ip = \?/);
  assert.ok(!queries[0].sql.includes('10.0.0.1') && queries[0].params.includes('10.0.0.1'));
});
