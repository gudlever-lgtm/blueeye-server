'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Federated sources for the universal search: events (event_cases /
// event_clusters), tickets (local itsm_ticket_ref + live ServiceNow) and IPAM
// (Nautobot prefixes + addresses). One query, answered by our own tables and the
// customer's ITSM/IPAM at the same time, merged into one ranked list.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeLocationsRepo,
  makeEventCasesRepo,
  makeEventClustersRepo,
  makeIntegrationsRepo,
  makeCmdbConfigRepo,
  makeConnectorRegistry,
  makeCmdbConnectorRegistry,
  makeSecretBox,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');
const { createServiceNowConnector } = require('../src/integrations/connectors/serviceNow');
const { createNautobotConnector } = require('../src/integrations/connectors/nautobot');
const { makeTicketSearch, makeIpamSearch } = require('../src/search/externalSources');
const { classify, makeHit, TYPES } = require('../src/search/query');

const AGENTS = [
  { id: 1, hostname: 'fw-aarhus', display_name: 'Firewall Aarhus', status: 'online', location_name: 'Aarhus', last_seen: '2026-07-28T10:00:00.000Z', capabilities: { ips: ['10.1.0.5'] } },
];
const LOCATIONS = [{ id: 7, name: 'Aarhus' }];

const SN = { baseUrl: 'https://acme.service-now.com', authType: 'basic', credentials: { username: 'u', password: 'p' }, config: {} };
const NB = { baseUrl: 'https://nautobot.example.com', authType: 'token', credentials: { token: 't' }, config: {} };

const fetchReturning = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const search = (app, q, role = 'viewer') =>
  request(app).get(`/api/search?q=${encodeURIComponent(q)}`).set('Authorization', authHeader(role));

function appWith(overrides = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => AGENTS }),
    locationsRepo: makeLocationsRepo({ findAll: async () => LOCATIONS }),
    ...overrides,
  });
}

// Seeds an integrations repo with one enabled ServiceNow row whose credentials
// are encrypted the way the real route stores them.
async function integrationsWith(secretBox, rows) {
  const repo = makeIntegrationsRepo();
  for (const r of rows) {
    await repo.create({
      type: r.type, name: r.name, baseUrl: r.baseUrl, authType: r.authType || 'basic',
      credentialsEncrypted: secretBox.encryptJson(r.credentials || { username: 'u', password: 'p' }),
      enabled: r.enabled !== false, config: r.config || {},
    });
  }
  return repo;
}

// ------------------------------------------------------------ query analysis
test('classify always adds the event, ticket and ipam families', () => {
  for (const q of ['aarhus', 'INC0012345', '10.1.0.5', '10.1.', '10.1.0.0/24', '42']) {
    const c = classify(q);
    for (const f of ['event', 'ticket', 'ipam']) assert.ok(c.families.includes(f), `${q} should include ${f}`);
  }
  assert.equal(classify('INC0012345').isTicketRef, true);
  assert.equal(classify('aarhus').isTicketRef, false);
  assert.equal(classify('10.1.').isIpPrefix, true);
  assert.equal(classify('10.1.0.0/24').isIpPrefix, true);
  assert.equal(classify('10.1.0.5').isIpPrefix, false, 'an exact IP is an address, not a prefix');
  assert.equal(classify('42').isIpPrefix, false, 'a bare number is an id/port, not a prefix');
  for (const t of ['event', 'ticket', 'ipam']) assert.ok(TYPES.includes(t));
});

test('makeHit keeps only http(s) urls', () => {
  assert.equal(makeHit({ type: 'ticket', display_name: 'x', target: 't', confidence: 'medium', source: 's', url: 'https://a/b' }).url, 'https://a/b');
  assert.ok(!('url' in makeHit({ type: 'ticket', display_name: 'x', target: 't', confidence: 'medium', source: 's', url: 'javascript:alert(1)' })));
  assert.ok(!('url' in makeHit({ type: 'ticket', display_name: 'x', target: 't', confidence: 'medium', source: 's', url: null })));
});

// ------------------------------------------------------- ServiceNow tickets
test('serviceNow.searchTickets queries number, short description and correlation id on the configured table', async () => {
  let calledUrl = null;
  const connector = createServiceNowConnector({ fetchImpl: async (url) => { calledUrl = url; return { ok: true, status: 200, json: async () => ({ result: [] }) }; } });
  await connector.searchTickets({ ...SN, config: { table: 'incident' } }, 'fw-aarhus');
  const u = new URL(calledUrl);
  assert.match(u.pathname, /\/api\/now\/table\/incident$/);
  const query = u.searchParams.get('sysparm_query');
  assert.equal(query, 'numberLIKEfw-aarhus^ORshort_descriptionLIKEfw-aarhus^ORcorrelation_idLIKEfw-aarhus^ORDERBYDESCsys_updated_on');
  assert.equal(u.searchParams.get('sysparm_limit'), '10');
});

test('serviceNow.searchTickets strips the query language separators from the term', async () => {
  let calledUrl = null;
  const connector = createServiceNowConnector({ fetchImpl: async (url) => { calledUrl = url; return { ok: true, status: 200, json: async () => ({ result: [] }) }; } });
  await connector.searchTickets(SN, 'x^ORactive=true');
  const query = new URL(calledUrl).searchParams.get('sysparm_query');
  assert.equal(query.split('^OR').length - 1, 3, 'exactly the three OR-ed conditions plus the ORDERBY');
});

test('serviceNow.searchTickets normalises rows and deep-links each one', async () => {
  const connector = createServiceNowConnector({
    fetchImpl: fetchReturning(200, { result: [
      { sys_id: 'abc', number: 'INC0012345', short_description: 'fw-aarhus unreachable', state: '2', priority: '1', sys_updated_on: '2026-08-01 10:11:12' },
      { sys_id: 'def', number: 'INC0012346', short_description: 'x', state: '99', priority: '', sys_updated_on: 'not a date' },
      { sys_id: '', number: 'ignored' },
    ] }),
  });
  const res = await connector.searchTickets(SN, 'INC');
  assert.equal(res.ok, true);
  assert.equal(res.tickets.length, 2);
  assert.deepEqual(res.tickets[0], {
    id: 'abc', number: 'INC0012345', title: 'fw-aarhus unreachable', state: 'In Progress', priority: '1',
    updatedAt: '2026-08-01T10:11:12.000Z',
    url: 'https://acme.service-now.com/nav_to.do?uri=incident.do%3Fsys_id%3Dabc',
  });
  assert.equal(res.tickets[1].state, '99', 'an unknown state is passed through, not invented');
  assert.equal(res.tickets[1].priority, null);
  assert.equal(res.tickets[1].updatedAt, null, 'an unparseable date is undated, not guessed');
});

test('serviceNow.searchTickets surfaces an upstream failure as ok:false', async () => {
  const connector = createServiceNowConnector({ fetchImpl: fetchReturning(500, {}) });
  const res = await connector.searchTickets(SN, 'INC');
  assert.equal(res.ok, false);
  assert.deepEqual(res.tickets, []);
});

// ------------------------------------------------------------ Nautobot IPAM
test('nautobot.searchIpam reads prefixes and ip-addresses and normalises both', async () => {
  const calls = [];
  const connector = createNautobotConnector({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/api/ipam/prefixes/')) {
        return { ok: true, status: 200, json: async () => ({ results: [
          { id: 'p1', prefix: '10.1.0.0/24', description: 'Aarhus office LAN', status: { display: 'Active' }, location: { display: 'Aarhus' }, vrf: null, last_updated: '2026-07-01T00:00:00Z' },
        ] }) };
      }
      return { ok: true, status: 200, json: async () => ({ results: [
        { id: 'a1', address: '10.1.0.5/24', dns_name: 'fw-aarhus.example', status: { display: 'Active' }, vrf: { display: 'CORP' }, last_updated: '2026-07-02T00:00:00Z' },
        { id: '', address: 'dropped' },
      ] }) };
    },
  });
  const res = await connector.searchIpam(NB, '10.1');
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((u) => u.includes('?q=10.1&limit=10')));
  assert.deepEqual(res.ipam, [
    { id: 'p1', kind: 'prefix', address: '10.1.0.0/24', description: 'Aarhus office LAN', status: 'Active', location: 'Aarhus', vrf: null, dnsName: null, updatedAt: '2026-07-01T00:00:00Z', url: 'https://nautobot.example.com/ipam/prefixes/p1/' },
    { id: 'a1', kind: 'ip', address: '10.1.0.5/24', description: null, status: 'Active', location: null, vrf: 'CORP', dnsName: 'fw-aarhus.example', updatedAt: '2026-07-02T00:00:00Z', url: 'https://nautobot.example.com/ipam/ip-addresses/a1/' },
  ]);
});

test('nautobot.searchIpam tolerates one of the two reads failing', async () => {
  const connector = createNautobotConnector({
    fetchImpl: async (url) => (url.includes('/prefixes/')
      ? { ok: false, status: 500, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ results: [{ id: 'a1', address: '10.1.0.5/24' }] }) }),
  });
  const res = await connector.searchIpam(NB, '10.1.0.5');
  assert.equal(res.ok, true);
  assert.equal(res.ipam.length, 1);
  assert.equal(res.ipam[0].kind, 'ip');
});

test('nautobot.searchIpam is ok:false only when both reads fail', async () => {
  const connector = createNautobotConnector({ fetchImpl: fetchReturning(503, {}) });
  const res = await connector.searchIpam(NB, '10.1');
  assert.equal(res.ok, false);
  assert.deepEqual(res.ipam, []);
});

// ------------------------------------------------------------------ thunks
test('makeTicketSearch returns null without its deps and [] with no ITSM configured', async () => {
  assert.equal(makeTicketSearch({}), null);
  const secretBox = makeSecretBox();
  const thunk = makeTicketSearch({ integrationsRepo: makeIntegrationsRepo(), registry: makeConnectorRegistry(), secretBox });
  assert.deepEqual(await thunk('INC'), []);
});

test('makeTicketSearch decrypts at call time, asks every enabled ServiceNow and tags each ticket', async () => {
  const secretBox = makeSecretBox();
  const seenAuth = [];
  const registry = makeConnectorRegistry({
    fetchImpl: async (url, init) => {
      seenAuth.push(init.headers.Authorization);
      const who = url.includes('one.service-now') ? 'one' : 'two';
      return { ok: true, status: 200, json: async () => ({ result: [{ sys_id: who, number: `INC-${who}`, short_description: 's', state: '1', sys_updated_on: '2026-08-01 00:00:00' }] }) };
    },
  });
  const integrationsRepo = await integrationsWith(secretBox, [
    { type: 'servicenow', name: 'SN one', baseUrl: 'https://one.service-now.com', credentials: { username: 'a', password: 'b' } },
    { type: 'servicenow', name: 'SN two', baseUrl: 'https://two.service-now.com', credentials: { username: 'c', password: 'd' } },
    { type: 'servicenow', name: 'SN off', baseUrl: 'https://off.service-now.com', enabled: false },
    { type: 'webhook', name: 'hook', baseUrl: 'https://hook.example.com', authType: 'none' },
  ]);
  const thunk = makeTicketSearch({ integrationsRepo, registry, secretBox });
  const tickets = await thunk('INC');
  assert.equal(tickets.length, 2, 'only the two ENABLED ServiceNow rows are asked');
  assert.deepEqual(tickets.map((t) => t.integrationName).sort(), ['SN one', 'SN two']);
  assert.ok(tickets.every((t) => t.source === 'servicenow' && Number.isInteger(t.integrationId)));
  assert.deepEqual(seenAuth.sort(), [
    `Basic ${Buffer.from('a:b').toString('base64')}`,
    `Basic ${Buffer.from('c:d').toString('base64')}`,
  ].sort(), 'each target is called with ITS OWN decrypted credentials');
});

test('makeTicketSearch drops one dead target and still answers; throws only when all are dead', async () => {
  const secretBox = makeSecretBox();
  const registry = makeConnectorRegistry({
    fetchImpl: async (url) => (url.includes('dead.')
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ result: [{ sys_id: 'x', number: 'INC1', short_description: 's' }] }) }),
  });
  const integrationsRepo = await integrationsWith(secretBox, [
    { type: 'servicenow', name: 'dead', baseUrl: 'https://dead.service-now.com' },
    { type: 'servicenow', name: 'alive', baseUrl: 'https://alive.service-now.com' },
  ]);
  const tickets = await makeTicketSearch({ integrationsRepo, registry, secretBox })('INC');
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].integrationName, 'alive');

  const allDead = await integrationsWith(secretBox, [{ type: 'servicenow', name: 'dead', baseUrl: 'https://dead.service-now.com' }]);
  await assert.rejects(makeTicketSearch({ integrationsRepo: allDead, registry, secretBox })('INC'));
});

test('makeIpamSearch consults the CMDB config AND integrations, deduped on base url', async () => {
  const secretBox = makeSecretBox();
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ results: [{ id: new URL(url).host, prefix: '10.0.0.0/8' }] }) }; };
  const cmdbConfigRepo = makeCmdbConfigRepo({ row: {
    id: 1, type: 'nautobot', base_url: 'https://nb.example.com/', auth_type: 'token', enabled: true,
    credentials_encrypted: secretBox.encryptJson({ token: 't' }),
  } });
  const integrationsRepo = await integrationsWith(secretBox, [
    { type: 'nautobot', name: 'same box', baseUrl: 'https://nb.example.com', authType: 'token', credentials: { token: 't' } },
    { type: 'nautobot', name: 'other box', baseUrl: 'https://nb2.example.com', authType: 'token', credentials: { token: 't2' } },
    { type: 'servicenow', name: 'not ipam', baseUrl: 'https://sn.example.com' },
  ]);
  const thunk = makeIpamSearch({
    cmdbConfigRepo, cmdbRegistry: makeCmdbConnectorRegistry({ fetchImpl }),
    integrationsRepo, registry: makeConnectorRegistry({ fetchImpl }), secretBox,
  });
  const rows = await thunk('10.');
  const hosts = new Set(calls.map((u) => new URL(u).host));
  assert.deepEqual([...hosts].sort(), ['nb.example.com', 'nb2.example.com'], 'the CMDB Nautobot and the identical integration row are asked ONCE');
  assert.equal(rows.length, 4, 'two targets × (prefixes + addresses)');
  assert.ok(rows.every((r) => r.source === 'nautobot'));
});

test('makeIpamSearch returns null without any source and [] when nothing is enabled', async () => {
  assert.equal(makeIpamSearch({ secretBox: makeSecretBox() }), null);
  assert.equal(makeIpamSearch({}), null);
  const thunk = makeIpamSearch({ cmdbConfigRepo: makeCmdbConfigRepo(), cmdbRegistry: makeCmdbConnectorRegistry(), secretBox: makeSecretBox() });
  assert.deepEqual(await thunk('10.'), []);
});

// ------------------------------------------------------------------ API: events
async function eventsFixture() {
  const eventCasesRepo = makeEventCasesRepo({ devices: { 1: { agentName: 'Firewall Aarhus', agentHostname: 'fw-aarhus', locationId: 7, locationName: 'Aarhus' } } });
  await eventCasesRepo.create({ host_id: '1', title: 'Latency spike on eth0', severity: 'WARN', first_event_at: '2026-08-01T08:00:00Z', last_event_at: '2026-08-01T09:00:00Z' });
  await eventCasesRepo.create({ host_id: '1', title: 'Packet loss to core', severity: 'CRIT', status: 'resolved', first_event_at: '2026-07-01T08:00:00Z', last_event_at: '2026-07-01T09:00:00Z' });
  await eventCasesRepo.create({ host_id: '9', title: 'Unrelated elsewhere', severity: 'INFO', first_event_at: '2026-08-02T08:00:00Z', last_event_at: '2026-08-02T09:00:00Z' });
  const eventClustersRepo = makeEventClustersRepo();
  const cid = await eventClustersRepo.create({ confidence: 'high', suspectedCommonCause: 'Upstream ISP outage', detectedAt: '2026-08-03T08:00:00Z', memberFindingIds: [1, 2] });
  await eventClustersRepo.setItsmRef(cid, { ticketRef: 'INC0012345', integrationId: 1 });
  return { eventCasesRepo, eventClustersRepo };
}

test('an event is found by title (prefix beats substring) and by id', async () => {
  const app = appWith(await eventsFixture());

  const prefix = await search(app, 'latency');
  assert.equal(prefix.status, 200);
  const hit = prefix.body.hits.find((h) => h.type === 'event');
  assert.ok(hit);
  assert.equal(hit.confidence, 'high');
  assert.equal(hit.target, 'event:1');
  assert.equal(hit.source, 'event_cases');
  assert.equal(hit.last_seen, '2026-08-01T09:00:00.000Z');
  assert.match(hit.detail, /WARN · open · Firewall Aarhus · Aarhus/);

  const sub = await search(app, 'core');
  assert.equal(sub.body.hits.find((h) => h.type === 'event' && h.target === 'event:2').confidence, 'medium');

  // Queries are at least 2 characters; "02" is still the numeric id 2.
  const byId = await search(app, '02');
  assert.equal(byId.status, 200);
  assert.equal(byId.body.hits.find((h) => h.type === 'event' && h.target === 'event:2').confidence, 'exact');
});

test('a device name finds its OPEN events only', async () => {
  const app = appWith(await eventsFixture());
  const res = await search(app, 'fw-aarhus');
  const events = res.body.hits.filter((h) => h.type === 'event');
  assert.deepEqual(events.map((h) => h.target), ['event:1'], 'the resolved case on the same device is not listed');
  assert.equal(events[0].source, 'event_cases (open on this device)');
  // The host hit itself still comes first.
  assert.equal(res.body.hits[0].type, 'host');
});

test('a situation is found by its suspected cause, and its ticket ref lands on it', async () => {
  const app = appWith(await eventsFixture());

  const cause = await search(app, 'upstream');
  const cl = cause.body.hits.find((h) => h.target === 'cluster:1' && h.type === 'event');
  assert.ok(cl);
  assert.equal(cl.confidence, 'high');
  assert.equal(cl.source, 'event_clusters');
  assert.match(cl.detail, /INC0012345/);

  const ref = await search(app, 'INC0012345');
  const tk = ref.body.hits.find((h) => h.type === 'ticket');
  assert.ok(tk);
  assert.equal(tk.confidence, 'exact');
  assert.equal(tk.target, 'cluster:1');
  assert.equal(tk.source, 'event_clusters.itsm_ticket_ref');
  assert.ok(!('url' in tk), 'a local hit has a screen, not a link');

  const partial = await search(app, 'inc00');
  assert.equal(partial.body.hits.find((h) => h.type === 'ticket').confidence, 'high');
});

test('a failing events repo degrades to partial, never a 500', async () => {
  const res = await search(appWith({ eventCasesRepo: makeEventCasesRepo({ list: throwingAsync('db gone') }) }), 'latency');
  assert.equal(res.status, 200);
  assert.equal(res.body.partial, true);
  assert.deepEqual(res.body.failedSources, ['event']);
});

// ---------------------------------------------------------------- API: tickets
test('a ServiceNow ticket is a deep-linked hit that names its integration', async () => {
  const secretBox = makeSecretBox();
  const connectorRegistry = makeConnectorRegistry({
    fetchImpl: fetchReturning(200, { result: [
      { sys_id: 'abc', number: 'INC0099999', short_description: 'fw-aarhus down', state: '2', priority: '1', sys_updated_on: '2026-08-01 10:11:12' },
    ] }),
  });
  const integrationsRepo = await integrationsWith(secretBox, [{ type: 'servicenow', name: 'Acme SN', baseUrl: 'https://acme.service-now.com' }]);
  const app = appWith({ secretBox, connectorRegistry, integrationsRepo });

  const exact = await search(app, 'INC0099999');
  assert.equal(exact.status, 200);
  const hit = exact.body.hits.find((h) => h.type === 'ticket');
  assert.ok(hit);
  assert.equal(hit.confidence, 'exact');
  assert.equal(hit.display_name, 'INC0099999 — fw-aarhus down');
  assert.equal(hit.target, 'ticket:1:abc');
  assert.equal(hit.source, 'itsm:servicenow (Acme SN)');
  assert.equal(hit.last_seen, '2026-08-01T10:11:12.000Z');
  assert.equal(hit.detail, 'In Progress · P1');
  assert.equal(hit.url, 'https://acme.service-now.com/nav_to.do?uri=incident.do%3Fsys_id%3Dabc');

  const byWords = await search(app, 'fw-aarhus');
  assert.equal(byWords.body.hits.find((h) => h.type === 'ticket').confidence, 'medium');
});

test('a dead ITSM is a failed source, the local answers still come back', async () => {
  const secretBox = makeSecretBox();
  const connectorRegistry = makeConnectorRegistry({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const integrationsRepo = await integrationsWith(secretBox, [{ type: 'servicenow', name: 'SN', baseUrl: 'https://acme.service-now.com' }]);
  const res = await search(appWith({ secretBox, connectorRegistry, integrationsRepo }), 'aarhus');
  assert.equal(res.status, 200);
  assert.equal(res.body.partial, true);
  assert.deepEqual(res.body.failedSources, ['itsm']);
  assert.ok(res.body.hits.some((h) => h.type === 'host'));
  assert.ok(res.body.hits.some((h) => h.type === 'site'));
});

test('with no ITSM configured the ticket source is neither failed nor present', async () => {
  const res = await search(appWith(), 'INC0012345');
  assert.equal(res.status, 200);
  assert.equal(res.body.partial, false);
  assert.equal(res.body.hits.filter((h) => h.type === 'ticket').length, 0);
});

// ------------------------------------------------------------------ API: IPAM
function nautobotRegistry(overrides = {}) {
  const fetchImpl = overrides.fetchImpl || (async (url) => ({
    ok: true, status: 200,
    json: async () => (url.includes('/prefixes/')
      ? { results: [{ id: 'p1', prefix: '10.1.0.0/24', description: 'Aarhus office LAN', status: { display: 'Active' }, location: { display: 'Aarhus' }, last_updated: '2026-07-01T00:00:00Z' }] }
      : { results: [{ id: 'a1', address: '10.1.0.5/24', dns_name: 'fw-aarhus.example', status: { display: 'Active' }, vrf: { display: 'CORP' }, last_updated: '2026-07-02T00:00:00Z' }] }),
  }));
  return { cmdbConnectorRegistry: makeCmdbConnectorRegistry({ fetchImpl }), connectorRegistry: makeConnectorRegistry({ fetchImpl }) };
}

function nautobotCmdb(secretBox) {
  return makeCmdbConfigRepo({ row: {
    id: 1, type: 'nautobot', base_url: 'https://nb.example.com', auth_type: 'token', enabled: true,
    credentials_encrypted: secretBox.encryptJson({ token: 't' }),
  } });
}

test('a partial IP finds the IPAM prefix (high) and the address (exact on the bare IP)', async () => {
  const secretBox = makeSecretBox();
  const app = appWith({ secretBox, cmdbConfigRepo: nautobotCmdb(secretBox), ...nautobotRegistry() });

  const prefix = await search(app, '10.1.');
  assert.equal(prefix.status, 200);
  const ipam = prefix.body.hits.filter((h) => h.type === 'ipam');
  assert.equal(ipam.length, 2);
  const p = ipam.find((h) => h.target === 'ipam:prefix:p1');
  assert.equal(p.confidence, 'high');
  assert.equal(p.display_name, '10.1.0.0/24 — Aarhus office LAN');
  assert.equal(p.source, 'ipam:nautobot');
  assert.equal(p.detail, 'prefix · Active · Aarhus');
  assert.equal(p.url, 'https://nb.example.com/ipam/prefixes/p1/');
  assert.equal(p.last_seen, '2026-07-01T00:00:00Z');

  const exact = await search(app, '10.1.0.5');
  const a = exact.body.hits.find((h) => h.target === 'ipam:ip:a1');
  assert.equal(a.confidence, 'exact', '10.1.0.5 against the address row 10.1.0.5/24 is the same host');
  assert.equal(a.display_name, '10.1.0.5/24 — fw-aarhus.example');
  assert.equal(a.detail, 'address · Active · VRF CORP');
  // The exact local IP answer still ranks first.
  assert.equal(exact.body.hits[0].type, 'ip');
});

test('a dead IPAM is a failed source named ipam', async () => {
  const secretBox = makeSecretBox();
  const app = appWith({
    secretBox,
    cmdbConfigRepo: nautobotCmdb(secretBox),
    ...nautobotRegistry({ fetchImpl: fetchReturning(503, {}) }),
  });
  const res = await search(app, '10.1.');
  assert.equal(res.status, 200);
  assert.equal(res.body.partial, true);
  assert.deepEqual(res.body.failedSources, ['ipam']);
});

test('the search endpoint still 401s, 400s and 500s the same way with federated sources wired', async () => {
  const secretBox = makeSecretBox();
  const app = appWith({ secretBox, cmdbConfigRepo: nautobotCmdb(secretBox), ...nautobotRegistry(), ...(await eventsFixture()) });
  assert.equal((await request(app).get('/api/search?q=INC0012345')).status, 401);
  assert.equal((await search(app, 'a')).status, 400);
  assert.equal((await request(app).get('/api/search/nope').set('Authorization', authHeader('viewer'))).status, 404);
  const fatal = appWith({ agentsRepo: makeAgentsRepo({ findAll: throwingAsync() }), ...(await eventsFixture()) });
  assert.equal((await search(fatal, 'latency')).status, 500);
});
