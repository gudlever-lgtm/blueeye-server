'use strict';

// New-peer detection (src/analysis/newPeerDetector.js) over known_peers
// (migration 142): an ASN or a country a site has never reached before. The
// first detector in the product that answers "has this ever happened" rather
// than "is this number unusual".

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createNewPeerDetector, loadNewPeerConfig, groupPeers } = require('../src/analysis/newPeerDetector');
const { makeFlowsRepo, makeKnownPeersRepo } = require('../test-support/fakes');

const HOUR = 60 * 60 * 1000;

function sink() {
  const emitted = [];
  return { emitted, emit: async (f) => { emitted.push(f); return f; } };
}

function row(over = {}) {
  return {
    agentId: 7,
    asn: 15169,
    asnName: 'Google LLC',
    country: 'IE',
    bytes: 4096,
    flowCount: 3,
    firstSeen: new Date('2026-09-30T09:10:00Z'),
    lastSeen: new Date('2026-09-30T09:55:00Z'),
    srcIp: '10.0.0.20',
    extIp: '142.250.74.14',
    ...over,
  };
}

// Two agents: 7 at site 3, 9 with no site at all.
const AGENTS = [
  { id: 7, location_id: 3, hostname: 'srv-app-1' },
  { id: 9, location_id: null, hostname: 'edge-probe' },
];

function build({ rows = [rowDefault()], peers = makeKnownPeersRepo(), env = {}, now = '2026-09-30T10:05:00Z' } = {}) {
  const s = sink();
  const d = createNewPeerDetector({
    flowsRepo: makeFlowsRepo({ externalPeersSince: async () => rows }),
    knownPeersRepo: peers,
    agentsRepo: { findAll: async () => AGENTS },
    locationsRepo: { findById: async (id) => (id === 3 ? { id: 3, name: 'Aarhus HQ' } : null) },
    findingSink: s,
    config: loadNewPeerConfig(env),
    now: () => new Date(now),
  });
  return { d, s, peers };
}
function rowDefault() { return row(); }

test('groupPeers: one entry per (scope, kind, key), heaviest conversation wins the evidence', () => {
  const scopeOf = (id) => (id === 7 ? 'site:3' : (id === 9 ? 'agent:9' : null));
  const grouped = groupPeers([
    row({ bytes: 100, srcIp: '10.0.0.1' }),
    row({ bytes: 900, srcIp: '10.0.0.2' }),
    row({ agentId: 9, asn: 64500, asnName: 'Example', country: 'DK' }),
    row({ agentId: 404 }), // an agent nothing knows about
  ], scopeOf);

  assert.deepEqual([...grouped.keys()].sort(), ['agent:9', 'site:3']);
  const site = grouped.get('site:3');
  assert.deepEqual([...site.keys()].sort(), ['asn|15169', 'country|IE']);
  assert.equal(site.get('asn|15169').srcIp, '10.0.0.2', 'the lighter conversation supplied the evidence');
  assert.equal(site.get('asn|15169').flowCount, 6, 'flows were not summed across rows');

  // Either kind can be switched off; a row under the byte floor is skipped.
  assert.equal([...groupPeers([row()], scopeOf, { country: false }).get('site:3').keys()].length, 1);
  assert.equal(groupPeers([row({ bytes: 0 })], scopeOf, { minBytes: 1 }).size, 0);
});

test('a warming-up scope learns silently, and raises once its memory is old enough', async () => {
  const peers = makeKnownPeersRepo();
  const first = build({ peers });
  await first.d.run();
  assert.equal(first.s.emitted.length, 0, 'the first run alarmed on every network it had never seen');
  assert.equal(peers.rows.get('site:3').size, 2, 'the first run learned nothing');

  // An hour later, still inside the 24-hour warm-up: a genuinely new country
  // is still not raised.
  const warming = build({
    peers, rows: [row({ country: 'RU', asn: 64512, asnName: 'Example AS' })], now: '2026-09-30T11:05:00Z',
  });
  await warming.d.run();
  assert.equal(warming.s.emitted.length, 0);

  // Two days later the memory is warm.
  const warm = build({
    peers, rows: [row({ country: 'BR', asn: 64513, asnName: 'Other AS' })], now: '2026-10-02T11:05:00Z',
  });
  const out = await warm.d.run();
  assert.equal(out.raised, 2, 'a new ASN and a new country in one hour is two findings');

  const country = warm.s.emitted.find((f) => f.metric === 'peer.new_country');
  assert.equal(country.severity, 'WARN');
  assert.equal(country.hostId, '7');
  assert.equal(country.evidence[0].target, 'BR');
  assert.match(country.explanation, /Aarhus HQ \(site:3\)/, 'the site is not named in plain language');
  assert.match(country.explanation, /New is not the same as wrong/, 'the explanation claims a verdict');

  const asn = warm.s.emitted.find((f) => f.metric === 'peer.new_asn');
  assert.equal(asn.severity, 'INFO', 'a new ASN pages by default');
  assert.match(asn.explanation, /AS64513 \(Other AS\)/);
  assert.equal(asn.evidence[0].labels.srcIp, '10.0.0.20', 'the internal address that did it is missing');
});

test('a peer the memory already holds is never new again', async () => {
  const peers = makeKnownPeersRepo();
  await peers.touchMany('site:3', [{ kind: 'asn', key: '15169' }, { kind: 'country', key: 'IE' }], new Date('2026-09-01T00:00:00Z'));
  const { d, s } = build({ peers });
  const out = await d.run();
  assert.equal(out.raised, 0);
  assert.equal(s.emitted.length, 0);
});

test('an agent with no site is its own scope', async () => {
  const peers = makeKnownPeersRepo();
  await peers.touchMany('agent:9', [{ kind: 'asn', key: '1' }], new Date('2026-09-01T00:00:00Z'));
  const { d, s } = build({ peers, rows: [row({ agentId: 9, asn: 64500, asnName: 'Edge', country: 'NO' })] });
  await d.run();
  assert.equal(s.emitted.length, 2);
  assert.ok(s.emitted.every((f) => f.evidence[0].labels.scope === 'agent:9'));
  assert.match(s.emitted[0].explanation, /agent:9/);
});

test('a provider change is one summary, not fifty findings — and countries survive the cap', async () => {
  const peers = makeKnownPeersRepo();
  await peers.touchMany('site:3', [{ kind: 'asn', key: '1' }], new Date('2026-09-01T00:00:00Z'));
  const rows = Array.from({ length: 30 }, (_, i) => row({ asn: 70000 + i, asnName: `AS${70000 + i}`, country: 'IE' }));
  rows.push(row({ asn: 70000, country: 'ZA' }));
  const { d, s } = build({ peers, rows, env: { NEW_PEER_MAX_PER_SCOPE: '3' } });
  const out = await d.run();

  assert.equal(out.raised, 4, 'three findings plus one summary');
  assert.ok(s.emitted.some((f) => f.metric === 'peer.new_country'), 'the country was dropped for ASNs');
  const summary = s.emitted.find((f) => f.evidence[0].labels.summary);
  assert.ok(summary, 'nothing said the rest existed');
  assert.match(summary.explanation, /NEW_PEER_MAX_PER_SCOPE/);
  assert.ok(summary.observed >= 25);
});

test('the memory is written even when the read fails, and nothing is called new', async () => {
  const peers = makeKnownPeersRepo();
  await peers.touchMany('site:3', [{ kind: 'asn', key: '1' }], new Date('2026-09-01T00:00:00Z'));
  peers.knownPeers = async () => { throw new Error('db down'); };
  const { d, s } = build({ peers });
  const out = await d.run();
  assert.equal(out.raised, 0, 'an unreadable memory made everything new');
  assert.ok(peers.rows.get('site:3').has('asn|15169'), 'the sighting was not recorded');
  assert.equal(s.emitted.length, 0);
});

test('off by flag, off by kind, off without a licence, and a broken repo never throws', async () => {
  const peers = makeKnownPeersRepo();
  await peers.touchMany('site:3', [{ kind: 'asn', key: '1' }], new Date('2026-09-01T00:00:00Z'));

  assert.equal(await build({ peers, env: { NEW_PEER_ALERTS_ENABLED: 'false' } }).d.run(), null);

  const noAsn = build({ peers, env: { NEW_PEER_ASN_ENABLED: 'false' } });
  await noAsn.d.run();
  assert.deepEqual(noAsn.s.emitted.map((f) => f.metric), ['peer.new_country']);

  const unlicensed = createNewPeerDetector({
    flowsRepo: makeFlowsRepo(), knownPeersRepo: peers, agentsRepo: { findAll: async () => AGENTS },
    findingSink: sink(), licensed: () => false, config: loadNewPeerConfig({}),
  });
  assert.equal(await unlicensed.run(), null);

  const broken = createNewPeerDetector({
    flowsRepo: makeFlowsRepo({ externalPeersSince: async () => { throw new Error('db down'); } }),
    knownPeersRepo: peers,
    agentsRepo: { findAll: async () => AGENTS },
    findingSink: sink(),
    config: loadNewPeerConfig({}),
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  });
  assert.equal(await broken.run(), null);
});

test('the hour scored is the previous COMPLETE one', async () => {
  const peers = makeKnownPeersRepo();
  let asked = null;
  const d = createNewPeerDetector({
    flowsRepo: makeFlowsRepo({ externalPeersSince: async (a) => { asked = a; return []; } }),
    knownPeersRepo: peers,
    agentsRepo: { findAll: async () => AGENTS },
    findingSink: sink(),
    config: loadNewPeerConfig({}),
    now: () => new Date('2026-09-30T10:37:12Z'),
  });
  await d.run();
  assert.equal(asked.from.toISOString(), '2026-09-30T09:00:00.000Z');
  assert.equal(asked.to.toISOString(), '2026-09-30T10:00:00.000Z');
  assert.equal(asked.to.getTime() - asked.from.getTime(), HOUR);
});
