'use strict';

// The two-ended half of diagnosis: the reverse test probes BACK to the agent
// that started the session (the return path), never the forward target from
// the far end; and the ECMP facts come from the path over several runs, not
// from counting addresses inside one.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeDiagnoseSessionsRepo, makeProbeResultsRepo, authHeader,
} = require('../test-support/fakes');
const { pickReverseTarget } = require('../src/diagnose/reverseTarget');
const { commonPrefixBits, subnetKey } = require('../src/diagnose/addr');

const ASYM = 'A kan nå B men B kan ikke nå A, svaret kommer aldrig tilbage';
const ECMP = 'Cirka halvdelen af flows fejler, det virker når man prøver igen';

const AGENTS = [
  { id: 1, hostname: 'origin', status: 'online', capabilities: { ips: ['172.17.0.1', '10.1.1.50', '2001:db8::50', '198.51.100.50'] } },
  { id: 2, hostname: 'far', status: 'online', capabilities: { ips: ['10.2.2.60'] } },
  { id: 3, hostname: 'old-agent', status: 'online', capabilities: { sources: ['proc'] } },
];
const agents = () => makeAgentsRepo({
  findAll: async () => AGENTS,
  findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null,
});
const post = (app, path, role, body) => request(app).post(path).set('Authorization', authHeader(role)).send(body);
function commander() {
  const sent = [];
  return { sent, sendCommand: (agentId, command) => { sent.push({ agentId, command }); return 1; } };
}

// --- choosing the address ------------------------------------------------------

test('address helpers: shared prefix and the subnet a link is numbered from', () => {
  assert.equal(commonPrefixBits('10.1.1.50', '10.2.2.60'), 14);
  assert.equal(commonPrefixBits('10.1.1.50', '10.1.1.50'), 32);
  assert.equal(commonPrefixBits('10.1.1.50', '2001:db8::1'), 0);
  assert.equal(commonPrefixBits('2001:db8::1', '2001:db8::2'), 126);
  assert.equal(subnetKey('192.0.2.1'), subnetKey('192.0.2.2'));
  assert.equal(subnetKey('2001:db8:0:1::1'), subnetKey('2001:db8:0:1::ffff'));
  assert.notEqual(subnetKey('2001:db8:0:1::1'), subnetKey('2001:db8:0:2::1'));
  assert.equal(subnetKey('not-an-ip'), null);
});

test('the reverse target is the origin, in the target\'s family and scope, never a container bridge', () => {
  const [origin, peer] = AGENTS;
  const priv = pickReverseTarget({ origin, peer, forwardTarget: '10.2.2.9' });
  assert.equal(priv.address, '10.1.1.50', 'private target → private address, not docker0');
  assert.match(priv.why, /RETURN path/);
  assert.match(priv.why, /10\.1\.1\.50/);
  assert.match(priv.why, /NAT/, 'the limit is stated');

  assert.equal(pickReverseTarget({ origin, peer, forwardTarget: '203.0.113.9' }).address, '198.51.100.50', 'public target → public address');
  assert.equal(pickReverseTarget({ origin, peer, forwardTarget: '2001:db8::9' }).address, '2001:db8::50', 'IPv6 target → IPv6 address');
  // A hostname target is traced as IPv4; without a scope hint the prefix shared
  // with the far end decides.
  assert.equal(pickReverseTarget({ origin, peer, forwardTarget: 'mail.example.com' }).address, '10.1.1.50');
});

test('an origin that never reported its addresses gets NO reverse target, with the reason', () => {
  const r = pickReverseTarget({ origin: AGENTS[2], peer: AGENTS[1], forwardTarget: '10.2.2.9' });
  assert.equal(r.address, null);
  assert.match(r.reason, /capabilities\.ips/);
  // Stored as a JSON string is read too (older driver paths).
  assert.equal(pickReverseTarget({ origin: { id: 9, capabilities: JSON.stringify({ ips: ['10.9.9.9'] }) } }).address, '10.9.9.9');
});

// --- the plan ------------------------------------------------------------------

test('POST /api/diagnose: the reverse tests run on the peer and point at the origin agent', async () => {
  const repo = makeDiagnoseSessionsRepo();
  const app = makeApp({ agentsRepo: agents(), diagnoseSessionsRepo: repo });
  const res = await post(app, '/api/diagnose', 'viewer', { description: ASYM, locale: 'da', agentId: 1, peerAgentId: 2, target: '10.2.2.9' });
  assert.equal(res.status, 201);
  assert.ok(res.body.causes.some((c) => c.id === 'asymmetric_routing'), JSON.stringify(res.body.causes.map((c) => c.id)));
  const reverse = res.body.tests.filter((t) => t.direction === 'reverse');
  assert.ok(reverse.length > 0, 'the plan has reverse tests');
  for (const t of reverse) {
    assert.equal(t.agentId, 2, 'run from the far end');
    assert.equal(t.target, '10.1.1.50', 'aimed back at the origin — not at the forward target');
    assert.match(t.why, /RETURN path/);
  }
  assert.ok(res.body.tests.filter((t) => t.direction === 'forward').every((t) => t.target === '10.2.2.9'));
  assert.deepEqual(res.body.skipped, []);
  // The stored rows carry the per-row target, which is what dispatch and the
  // result correlation read.
  const stored = repo.tests.filter((t) => t.direction === 'reverse');
  assert.ok(stored.length && stored.every((t) => t.target === '10.1.1.50'));
});

test('POST /api/diagnose: without an origin address the reverse tests are skipped, and say why', async () => {
  const repo = makeDiagnoseSessionsRepo();
  const app = makeApp({ agentsRepo: agents(), diagnoseSessionsRepo: repo });
  const res = await post(app, '/api/diagnose', 'viewer', { description: ASYM, agentId: 3, peerAgentId: 2, target: '10.2.2.9' });
  assert.equal(res.status, 201);
  assert.equal(res.body.tests.filter((t) => t.direction === 'reverse').length, 0, 'nothing is aimed at the wrong target');
  assert.ok(res.body.skipped.length > 0);
  assert.ok(res.body.skipped.every((s) => s.direction === 'reverse' && /capabilities\.ips/.test(s.reason)));
  assert.equal(repo.tests.filter((t) => t.direction === 'reverse').length, 0);
});

test('running dispatches the reverse probe to the peer with the origin as host', async () => {
  const hub = commander();
  const app = makeApp({ agentsRepo: agents(), agentCommander: hub });
  const created = await post(app, '/api/diagnose', 'operator', { description: ASYM, agentId: 1, peerAgentId: 2, target: '10.2.2.9' });
  const res = await post(app, `/api/diagnose/${created.body.sessionId}/run`, 'operator', {});
  assert.equal(res.status, 202);
  const toPeer = hub.sent.filter((s) => s.agentId === 2);
  assert.ok(toPeer.length > 0);
  assert.ok(toPeer.every((s) => s.command.probe.host === '10.1.1.50'), JSON.stringify(toPeer));
});

// --- evaluating ECMP from the recent runs -----------------------------------------

const hops = (mid) => JSON.stringify([
  { hop: 1, ip: '10.0.0.1', rttMs: 1, lossPct: 0 },
  { hop: 2, ip: mid, rttMs: 8, lossPct: 0 },
  { hop: 3, ip: '93.184.216.34', rttMs: 12, lossPct: 0 },
]);

async function evaluateEcmp(probeResultsRepo) {
  const now = Date.now();
  const repo = makeDiagnoseSessionsRepo({
    probeRows: [
      { id: 21, agent_id: 1, type: 'traceroute', target: '93.184.216.34', ts: new Date(now + 1000), ok: 1, loss_pct: 0, hops: hops('203.0.113.10') },
      { id: 22, agent_id: 1, type: 'ping', target: '93.184.216.34', ts: new Date(now + 1500), ok: 1, loss_pct: 40, rtt_ms: 12 },
    ],
  });
  const app = makeApp({ agentsRepo: agents(), agentCommander: commander(), diagnoseSessionsRepo: repo, probeResultsRepo });
  const created = await post(app, '/api/diagnose', 'operator', { description: ECMP, agentId: 1, target: '93.184.216.34' });
  assert.equal(created.status, 201);
  await post(app, `/api/diagnose/${created.body.sessionId}/run`, 'operator', {});
  return post(app, `/api/diagnose/${created.body.sessionId}/evaluate`, 'operator', {});
}

test('evaluate: branches seen in the earlier runs confirm ECMP instead of ruling it out', async () => {
  const asked = [];
  const probeResultsRepo = makeProbeResultsRepo({
    recentRuns: async (q) => {
      asked.push(q);
      return [
        { id: 20, type: 'traceroute', target: q.target, lossPct: 0, hops: JSON.parse(hops('203.0.113.20')) },
        { id: 19, type: 'traceroute', target: q.target, lossPct: 0, hops: JSON.parse(hops('203.0.113.10')) },
      ];
    },
  });
  const res = await evaluateEcmp(probeResultsRepo);
  assert.equal(res.status, 200);
  assert.equal(asked[0].agentId, 1);
  assert.equal(asked[0].type, 'traceroute');
  assert.ok(asked[0].before instanceof Date && asked[0].from instanceof Date, 'the history is bounded at both ends');
  assert.equal(res.body.facts.traceroute.branch_count, 2);
  const ecmp = res.body.causes.find((c) => c.playbookId === 'ecmp_member_link');
  assert.equal(ecmp.verdict, 'confirmed');
});

test('evaluate: a failing history read degrades to this run alone, not to a 500', async () => {
  const probeResultsRepo = makeProbeResultsRepo({ recentRuns: async () => { throw new Error('db down'); } });
  const res = await evaluateEcmp(probeResultsRepo);
  assert.equal(res.status, 200);
  // One run, one address per hop, no member lists: not measured, so not "1".
  assert.equal(res.body.facts.traceroute.branch_count, undefined);
});
