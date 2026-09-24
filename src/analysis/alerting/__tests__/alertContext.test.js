'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAlertContext, pathFor, normaliseBase, hostLabel } = require('../alertContext');
const { createDispatcher } = require('../dispatcher');
const { createEmailChannel } = require('../channels/email');
const { createWebhookChannel } = require('../channels/webhook');
const { createSyslogChannel } = require('../channels/syslog');
const { renderMessage } = require('../channels/matrix');

const agentsRepo = (rows) => ({
  calls: 0,
  async findById(id) { this.calls += 1; return rows[id] || null; },
});

// ---- the link and the name ---------------------------------------------------
test('the link points at the most specific record: situation, event, then agent', () => {
  assert.equal(pathFor({ clusterId: 4, eventCaseId: 9, hostId: '12' }), '/situations/4');
  assert.equal(pathFor({ eventCaseId: 9, hostId: '12' }), '/events/9');
  assert.equal(pathFor({ hostId: '12' }), '/agents/12');
  assert.equal(pathFor({ hostId: '3 agents' }), null, 'a cluster host label is not an agent id');
  assert.equal(pathFor(null), null);
});

test('only an absolute http(s) base produces a link', () => {
  assert.equal(normaliseBase('https://blueeye.example.dk/'), 'https://blueeye.example.dk');
  assert.equal(normaliseBase('https://h.example/app//'), 'https://h.example/app');
  assert.equal(normaliseBase('blueeye.local'), null);
  assert.equal(normaliseBase('javascript:alert(1)'), null);
  assert.equal(normaliseBase(''), null);
});

test('enrich names the agent and links to it', async () => {
  const ctx = createAlertContext({ publicUrl: 'https://be.example', agentsRepo: agentsRepo({ 12: { display_name: 'core-sw-1' } }) });
  const out = await ctx.enrich({ hostId: '12', metric: 'probe.loss' });
  assert.deepEqual(out, { hostName: 'core-sw-1', link: 'https://be.example/agents/12' });
});

test('enrich without a public URL still names the agent, with no link', async () => {
  const ctx = createAlertContext({ publicUrl: null, agentsRepo: agentsRepo({ 12: { hostname: 'h12' } }) });
  assert.deepEqual(await ctx.enrich({ hostId: '12' }), { hostName: 'h12', link: null });
});

test('a situation is named by its agents, a few of them', async () => {
  const rows = {};
  for (let i = 1; i <= 7; i += 1) rows[i] = { display_name: `a${i}` };
  const ctx = createAlertContext({ publicUrl: 'https://be.example', agentsRepo: agentsRepo(rows) });
  const out = await ctx.enrich({
    clusterId: 3, hostId: '7 agents',
    evidence: [1, 2, 3, 4, 5, 6, 7, 1].map((h) => ({ host: String(h) })),
  });
  assert.equal(out.link, 'https://be.example/situations/3');
  assert.equal(out.hostName, 'a1, a2, a3, a4, a5 +2');
});

test('a failing agent lookup costs the name, never the alert', async () => {
  const ctx = createAlertContext({ publicUrl: 'https://be.example', agentsRepo: { findById: async () => { throw new Error('db down'); } } });
  assert.deepEqual(await ctx.enrich({ hostId: '5' }), { hostName: null, link: 'https://be.example/agents/5' });
});

test('names are cached briefly, so a burst of alerts is not a burst of queries', async () => {
  const repo = agentsRepo({ 1: { hostname: 'x' } });
  let t = 0;
  const ctx = createAlertContext({ agentsRepo: repo, now: () => t });
  await ctx.enrich({ hostId: '1' });
  await ctx.enrich({ hostId: '1' });
  assert.equal(repo.calls, 1);
  t = 61 * 1000;
  await ctx.enrich({ hostId: '1' });
  assert.equal(repo.calls, 2);
});

test('hostLabel reads "name (#id)", falling back to "host id"', () => {
  assert.equal(hostLabel({ hostId: '12', hostName: 'core' }), 'core (#12)');
  assert.equal(hostLabel({ hostId: '12' }), 'host 12');
  assert.equal(hostLabel({ hostId: '3 agents', hostName: 'a, b, c' }), 'a, b, c');
});

// ---- the dispatcher hands the channels an enriched COPY -------------------------
const CONFIG = { enabled: true, cooldownMs: 60000, channels: { email: { enabled: true, minSeverity: 'WARN' } } };

test('the dispatcher passes hostName and link to the channels', async () => {
  const seen = [];
  const d = createDispatcher({
    config: CONFIG,
    channels: { email: { send: async (s) => { seen.push(s); return { ok: true }; } } },
    enrich: async () => ({ hostName: 'core', link: 'https://be/agents/1' }),
  });
  const finding = { id: 'f', hostId: '1', metric: 'm', kind: 'ANOMALY', severity: 'CRIT' };
  await d.dispatch(finding);
  assert.equal(seen[0].hostName, 'core');
  assert.equal(seen[0].link, 'https://be/agents/1');
  assert.equal(finding.link, undefined, 'the caller\'s finding was mutated');
});

test('an enrich that throws still sends the alert', async () => {
  const seen = [];
  const d = createDispatcher({
    config: CONFIG,
    channels: { email: { send: async (s) => { seen.push(s); return { ok: true }; } } },
    enrich: async () => { throw new Error('boom'); },
  });
  const r = await d.dispatch({ id: 'f', hostId: '1', metric: 'm', kind: 'ANOMALY', severity: 'CRIT' });
  assert.equal(r.dispatched, true);
  assert.equal(seen.length, 1);
});

test('cluster lifecycle alerts are enriched too', async () => {
  const seen = [];
  const d = createDispatcher({
    config: CONFIG,
    channels: { email: { send: async (s) => { seen.push(s); return { ok: true }; } } },
    enrich: async (s) => ({ hostName: 'a, b', link: `https://be/situations/${s.clusterId}` }),
  });
  await d.dispatchClusterEvent({ clusterId: 8, severity: 'CRIT', metric: 'event_cluster' }, { memberFindingIds: [] }, { kind: 'opened' });
  assert.equal(seen[0].link, 'https://be/situations/8');
  assert.equal(seen[0].clusterEvent, 'opened');
});

// ---- each channel carries them ----------------------------------------------
const ENRICHED = {
  id: 'f1', hostId: '12', hostName: 'core-sw-1', link: 'https://be.example/events/9',
  metric: 'probe.loss', severity: 'CRIT', kind: 'ANOMALY', explanation: 'loss up', createdAt: new Date('2026-01-01T00:00:00Z'),
};

test('email: the subject names the agent and the body opens with the link', async () => {
  const sent = [];
  const ch = createEmailChannel({ config: { from: 'a@b', to: 'ops@b' }, transport: { sendMail: async (m) => { sent.push(m); } } });
  await ch.send(ENRICHED, null);
  assert.equal(sent[0].subject, '[BlueEyes CRIT] probe.loss on core-sw-1 (#12)');
  assert.match(sent[0].text, /Open in BlueEyes: https:\/\/be\.example\/events\/9/);
});

test('email without a name keeps the old "host N" wording', async () => {
  const sent = [];
  const ch = createEmailChannel({ config: { from: 'a@b', to: 'ops@b' }, transport: { sendMail: async (m) => { sent.push(m); } } });
  await ch.send({ hostId: '12', metric: 'cpu', severity: 'WARN' }, null);
  assert.match(sent[0].subject, /cpu on host 12$/);
  assert.doesNotMatch(sent[0].text, /Open in BlueEyes/);
});

test('webhook: link and hostName ride at the top level', async () => {
  let body = null;
  const ch = createWebhookChannel({ config: { url: 'https://hook/x' }, fetchImpl: async (u, o) => { body = JSON.parse(o.body); return { ok: true, status: 200 }; } });
  await ch.send(ENRICHED, null);
  assert.equal(body.link, 'https://be.example/events/9');
  assert.equal(body.hostName, 'core-sw-1');
});

test('syslog: the line names the agent and carries the link', async () => {
  const sent = [];
  const ch = createSyslogChannel({ config: { host: 'log', port: 514 }, send: async (buf) => { sent.push(buf.toString()); } });
  await ch.send(ENRICHED);
  assert.match(sent[0], /agent="core-sw-1"/);
  assert.match(sent[0], /link=https:\/\/be\.example\/events\/9/);
});

test('matrix: the headline names the agent, the formatted body links', () => {
  const { body, formatted } = renderMessage(ENRICHED, null);
  assert.match(body, /probe\.loss on core-sw-1 \(#12\)/);
  assert.match(body, /Open in BlueEyes: https:\/\/be\.example\/events\/9/);
  assert.match(formatted, /<a href="https:\/\/be\.example\/events\/9">Open in BlueEyes<\/a>/);
});

test('matrix: a link that is not http(s) is not rendered', () => {
  const { formatted } = renderMessage({ ...ENRICHED, link: 'javascript:alert(1)' }, null);
  assert.doesNotMatch(formatted, /<a /);
});
