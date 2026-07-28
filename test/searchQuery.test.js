'use strict';

// Unit tests for the pure query analysis behind the universal search field
// (src/search/query.js): classification, validation, the confidence ordering and
// deduplication. No DB, no HTTP.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeQuery,
  classify,
  validateQuery,
  compareHits,
  makeHit,
  dedupe,
  MIN_QUERY_LENGTH,
  MAX_QUERY_LENGTH,
} = require('../src/search/query');

// -------------------------------------------------------------- normalizeQuery
test('normalizeQuery trims and collapses whitespace', () => {
  assert.equal(normalizeQuery('  fw-aarhus  '), 'fw-aarhus');
  assert.equal(normalizeQuery('fw   aarhus'), 'fw aarhus');
  assert.equal(normalizeQuery('\t fw \n aarhus '), 'fw aarhus');
});

test('normalizeQuery returns null for nothing usable', () => {
  for (const v of ['', '   ', '\t\n', null, undefined]) {
    assert.equal(normalizeQuery(v), null);
  }
});

// -------------------------------------------------------------------- classify
test('classify recognises an exact IPv4 and IPv6 address', () => {
  assert.ok(classify('192.168.1.1').isIpExact);
  assert.ok(classify('10.0.0.255').isIpExact);
  assert.ok(classify('fe80::1').isIpExact);
  assert.ok(classify('2001:db8::dead:beef').isIpExact);
});

test('classify does NOT treat a partial IP as an address', () => {
  // Exact-only for IP is the spec; a partial is a name-shaped fragment.
  assert.equal(classify('192.168.1.').isIpExact, false);
  assert.equal(classify('192.168').isIpExact, false);
  assert.equal(classify('192.168.1.256').isIpExact, false);
});

test('classify normalises a MAC in every accepted spelling', () => {
  for (const form of ['00:11:22:33:44:55', '00-11-22-33-44-55', '001122334455', '0011.2233.4455', '00:11:22:33:44:55'.toUpperCase()]) {
    const c = classify(form);
    assert.equal(c.isMac, true, `${form} should classify as a MAC`);
    assert.equal(c.mac, '00:11:22:33:44:55', `${form} should normalise identically`);
  }
});

test('classify recognises an agent id and a port from a numeric query', () => {
  const c = classify('443');
  assert.equal(c.isAgentId, true);
  assert.equal(c.agentId, 443);
  assert.equal(c.isPort, true);
  assert.equal(c.port, 443);

  const big = classify('99999');
  assert.equal(big.isAgentId, true, 'still a possible agent id');
  assert.equal(big.isPort, false, 'but out of port range');
});

test('classify always includes the name-shaped families', () => {
  // A hostname/site search is worth trying for literally any query — that is
  // what makes the field accept whatever the technician happens to know.
  const c = classify('anything');
  assert.ok(c.families.includes('host'));
  assert.ok(c.families.includes('site'));
});

test('classify puts identifier families before broad ones', () => {
  const c = classify('192.168.1.1');
  assert.ok(c.families.indexOf('ip') < c.families.indexOf('host'),
    'an exact identifier must be resolved before a broad name scan');
});

test('classify returns null for an unusable query', () => {
  assert.equal(classify(''), null);
  assert.equal(classify('   '), null);
  assert.equal(classify(null), null);
});

// ---------------------------------------------------------------- validateQuery
test('validateQuery enforces the length bounds', () => {
  assert.equal(validateQuery('ab').value, 'ab');
  assert.match(validateQuery('a').error, /at least/);
  assert.match(validateQuery('').error, /required/);
  assert.match(validateQuery('x'.repeat(MAX_QUERY_LENGTH + 1)).error, /at most/);
  assert.equal(validateQuery('x'.repeat(MAX_QUERY_LENGTH)).value.length, MAX_QUERY_LENGTH);
  assert.equal(MIN_QUERY_LENGTH, 2);
});

test('validateQuery normalises before measuring length', () => {
  assert.match(validateQuery('  a  ').error, /at least/, 'padding must not count toward the minimum');
});

// ----------------------------------------------------------------- compareHits
const hit = (over) => makeHit({
  type: 'host', display_name: 'x', target: 't', confidence: 'high', source: 's', ...over,
});

test('compareHits ranks by confidence first', () => {
  const sorted = [
    hit({ confidence: 'medium', target: 'm' }),
    hit({ confidence: 'exact', target: 'e' }),
    hit({ confidence: 'low', target: 'l' }),
    hit({ confidence: 'high', target: 'h' }),
  ].sort(compareHits);
  assert.deepEqual(sorted.map((h) => h.confidence), ['exact', 'high', 'medium', 'low']);
});

test('compareHits ranks by last_seen descending within a confidence tier', () => {
  const sorted = [
    hit({ target: 'old', last_seen: '2026-01-01T00:00:00Z' }),
    hit({ target: 'new', last_seen: '2026-07-28T00:00:00Z' }),
    hit({ target: 'mid', last_seen: '2026-05-01T00:00:00Z' }),
  ].sort(compareHits);
  assert.deepEqual(sorted.map((h) => h.target), ['new', 'mid', 'old']);
});

test('compareHits sorts an undated hit last within its tier', () => {
  // An answer we cannot date cannot claim to be current.
  const sorted = [
    hit({ target: 'undated', last_seen: null }),
    hit({ target: 'dated', last_seen: '2026-01-01T00:00:00Z' }),
  ].sort(compareHits);
  assert.deepEqual(sorted.map((h) => h.target), ['dated', 'undated']);
});

test('compareHits falls back to display name for a stable order', () => {
  const sorted = [
    hit({ target: 'b', display_name: 'beta', last_seen: null }),
    hit({ target: 'a', display_name: 'alpha', last_seen: null }),
  ].sort(compareHits);
  assert.deepEqual(sorted.map((h) => h.display_name), ['alpha', 'beta']);
});

// ---------------------------------------------------------------------- makeHit
test('makeHit always emits last_seen, defaulting to null', () => {
  const h = makeHit({ type: 'host', display_name: 'x', target: 't', confidence: 'high', source: 's' });
  assert.ok('last_seen' in h);
  assert.equal(h.last_seen, null);
  assert.ok(!('detail' in h), 'detail is omitted rather than emitted as null');
});

// ----------------------------------------------------------------------- dedupe
test('dedupe keeps the best hit per (type, target)', () => {
  // The same agent is legitimately found via its hostname, its ARP entry and its
  // flows; the technician wants one row, at the strongest confidence.
  const deduped = dedupe([
    hit({ target: 'agent:1', confidence: 'medium', source: 'flow_records' }),
    hit({ target: 'agent:1', confidence: 'exact', source: 'arp_entries' }),
    hit({ target: 'agent:2', confidence: 'high', source: 'agents' }),
  ]);
  assert.equal(deduped.length, 2);
  const first = deduped.find((h) => h.target === 'agent:1');
  assert.equal(first.confidence, 'exact');
  assert.equal(first.source, 'arp_entries');
});

test('dedupe keeps hits of different types that share a target', () => {
  // "this IP is on agent 1" and "agent 1 matched your hostname" are two answers
  // to two questions, and collapsing them would hide one.
  const deduped = dedupe([
    hit({ type: 'ip', target: 'agent:1' }),
    hit({ type: 'host', target: 'agent:1' }),
  ]);
  assert.equal(deduped.length, 2);
});

test('dedupe prefers the fresher hit at equal confidence', () => {
  const deduped = dedupe([
    hit({ target: 'agent:1', confidence: 'high', last_seen: '2026-01-01T00:00:00Z', source: 'stale' }),
    hit({ target: 'agent:1', confidence: 'high', last_seen: '2026-07-28T00:00:00Z', source: 'fresh' }),
  ]);
  assert.equal(deduped[0].source, 'fresh');
});
