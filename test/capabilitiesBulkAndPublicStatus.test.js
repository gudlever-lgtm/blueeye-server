'use strict';

// Two audit fixes on the agent-facing edge:
//  - the ingest tables in a capabilities report (arp / connections / lldp) are
//    bounded by COUNT, not by the 64 KB metadata cap, and never stored in
//    agents.capabilities — a busy ARP table no longer 400s the whole report;
//  - the public build-status route no longer relays the build's error text.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeArpEntriesRepo,
} = require('../test-support/fakes');
const { validateCapabilities } = require('../src/validation/agentValidation');
const { capabilitiesForStorage, BULK_CAPABILITY_LIMITS } = require('../src/lib/agentCapabilities');
const { publicBinaryStatus } = require('../src/routes/enroll');

const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

function arpRows(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, mac: `02:00:00:${((i >> 16) & 255).toString(16).padStart(2, '0')}:${((i >> 8) & 255).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`, interface: 'eth0' });
  }
  return out;
}

test('a 2000-entry ARP table (over 64 KB) is accepted and ingested, not a 400', async () => {
  const arpEntriesRepo = makeArpEntriesRepo();
  let stored = null;
  const agentsRepo = makeAgentsRepo({
    setCapabilities: async (id, caps) => { stored = caps; return { id, capabilities: caps }; },
  });
  const app = makeApp({ arpEntriesRepo, agentsRepo, agentTokensRepo: agentToken() });
  const arp = arpRows(2000);
  assert.ok(Buffer.byteLength(JSON.stringify(arp)) > 65535, 'fixture must exceed the old cap');

  const res = await request(app)
    .post('/agents/me/capabilities')
    .set('Authorization', 'Bearer agent-tok')
    .send({ capabilities: { sources: ['proc'], arp } });

  assert.equal(res.status, 200);
  assert.equal(arpEntriesRepo.rows.length, 2000);
  assert.deepEqual(stored, { sources: ['proc'] }, 'the ingest table is not persisted in agents.capabilities');
});

test('the metadata itself is still capped at 64 KB', () => {
  const errors = {};
  const out = validateCapabilities({ sources: ['proc'], note: 'x'.repeat(70000) }, errors);
  assert.equal(out, undefined);
  assert.match(errors.capabilities, /too large/);
});

test('an ingest table over its bound, or not an array, is dropped rather than refused', () => {
  const errors = {};
  const out = validateCapabilities({
    sources: ['proc'],
    arp: new Array(BULK_CAPABILITY_LIMITS.arp + 1).fill({ ip: '10.0.0.1', mac: '02:00:00:00:00:01' }),
    connections: 'nope',
    lldp: [{ localPort: 'eth0', remoteChassisId: 'aa:bb:cc:dd:ee:ff' }],
  }, errors);
  assert.equal(errors.capabilities, undefined);
  assert.equal(out.arp, undefined);
  assert.equal(out.connections, undefined);
  assert.equal(out.lldp.length, 1, 'a valid table survives for the route to ingest');
  assert.deepEqual(capabilitiesForStorage(out), { sources: ['proc'] });
});

test('publicBinaryStatus replaces every error text but keeps the shape', () => {
  const raw = {
    ready: true,
    topError: 'pkg not found in /var/cache/blueeye/pkg',
    arches: {
      'linux-x64': { built: true, sizeMb: 40, sha256: 'ab' },
      'linux-arm64': { built: false, status: 'error', error: 'ENOENT /var/cache/blueeye/x: stderr tail…' },
      'win-x64': { built: false, status: 'building', error: null },
    },
  };
  const out = publicBinaryStatus(raw);
  assert.equal(out.ready, true);
  assert.doesNotMatch(JSON.stringify(out), /var\/cache|ENOENT|stderr/);
  assert.match(out.topError, /server log/);
  assert.match(out.arches['linux-arm64'].error, /server log/);
  assert.equal(out.arches['linux-arm64'].status, 'error');
  assert.equal(out.arches['win-x64'].error, null);
  assert.deepEqual(out.arches['linux-x64'], raw.arches['linux-x64']);
  assert.deepEqual(publicBinaryStatus(null), { topError: null, arches: {} });
});

test('GET /enroll/agent-binary-status does not leak the build error text', async () => {
  const binaryStore = {
    status: () => ({ ready: true, topError: null, arches: { 'linux-x64': { built: false, status: 'error', error: 'spawn /opt/secret/path/pkg ENOENT' } } }),
    available: () => false,
    get: () => null,
  };
  const app = makeApp({ agentBinaryStore: binaryStore });
  const res = await request(app).get('/enroll/agent-binary-status');
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, true);
  assert.equal(res.body.arches['linux-x64'].status, 'error');
  assert.doesNotMatch(JSON.stringify(res.body), /secret|ENOENT/);
});
