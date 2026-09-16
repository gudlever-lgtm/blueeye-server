'use strict';

// The MTU probes' data on its way through the server: what the spec validator
// accepts, what the result validator stores, and the one place a diagnostic
// probe must NOT be counted.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateProbeSpec, validateProbeResults, PROBE_TYPES } = require('../src/validation/probeValidation');
const { toRow, fromRow } = require('../src/repositories/probeResultsRepository');

const errsOf = (r) => Object.keys(r.errors || {});
const one = (r) => validateProbeResults({ results: [r] });

// --- the spec ----------------------------------------------------------------

test('path_mtu is a probe type the server knows about', () => {
  assert.ok(PROBE_TYPES.includes('path_mtu'));
});

test('a ping can ask for several payload sizes with don\'t-fragment set', () => {
  const { value } = validateProbeSpec({ type: 'ping', host: 'h.example.com', sizes: [1472, 64, 64], df: true, count: 4 });
  assert.deepEqual(value.sizes, [64, 1472], 'deduped and ascending, so the smallest is the baseline');
  assert.equal(value.df, true);
  assert.equal(value.count, 4);
});

test('a ping with no sizes is exactly what it always was', () => {
  const { value } = validateProbeSpec({ type: 'ping', host: 'h', count: 4 });
  assert.equal(value.sizes, undefined);
  assert.equal(value.df, undefined);
});

test('a size sweep is bounded in both count and payload', () => {
  assert.ok(errsOf(validateProbeSpec({ type: 'ping', host: 'h', sizes: [] })).includes('sizes'));
  assert.ok(errsOf(validateProbeSpec({ type: 'ping', host: 'h', sizes: 'big' })).includes('sizes'));
  assert.ok(errsOf(validateProbeSpec({ type: 'ping', host: 'h', sizes: [1, 2, 3, 4, 5, 6, 7] })).includes('sizes'));
  assert.ok(errsOf(validateProbeSpec({ type: 'ping', host: 'h', sizes: [-1] })).includes('sizes'));
  assert.ok(errsOf(validateProbeSpec({ type: 'ping', host: 'h', sizes: [99999999] })).includes('sizes'));
  assert.ok(errsOf(validateProbeSpec({ type: 'ping', host: 'h', sizes: [1.5] })).includes('sizes'));
});

test('path_mtu takes search bounds and an opt-in per-hop walk', () => {
  const { value } = validateProbeSpec({ type: 'path_mtu', host: 'h', low: 548, high: 1472, perHop: true, maxHops: 20 });
  assert.deepEqual(value, { type: 'path_mtu', host: 'h', high: 1472, low: 548, perHop: true, maxHops: 20 });
  // A floor above the ceiling is a typo, not a search.
  assert.ok(errsOf(validateProbeSpec({ type: 'path_mtu', host: 'h', low: 2000, high: 1472 })).includes('low'));
  assert.ok(errsOf(validateProbeSpec({ type: 'path_mtu', host: 'h', maxHops: 99 })).includes('maxHops'));
  assert.ok(errsOf(validateProbeSpec({ type: 'path_mtu', host: 'h', high: 0 })).includes('high'));
});

test('a path_mtu target can never be read as a command-line flag', () => {
  for (const bad of ['-rf', '--flood', 'a b', 'a;id', '']) {
    assert.ok(errsOf(validateProbeSpec({ type: 'path_mtu', host: bad })).includes('host'), bad);
  }
});

// --- the results -------------------------------------------------------------

test('a ping sweep is stored per size, with the unmeasured ones flagged', () => {
  const { value } = one({
    type: 'ping', target: 'h', ok: true, lossPct: 0, rttMs: 5, df: true,
    sizes: [
      { bytes: 64, sent: 4, recv: 4, lossPct: 0, rttMs: 5, measured: true },
      { bytes: 1472, sent: 4, recv: 0, lossPct: 100, measured: true, mtuHint: 1400 },
      { bytes: 9000, sent: 4, recv: 0, lossPct: 100, measured: false, error: 'payload exceeds the local interface MTU' },
    ],
  });
  const r = value.results[0];
  assert.equal(r.df, true);
  assert.equal(r.sizes.length, 3);
  assert.equal(r.sizes[1].mtuHint, 1400);
  assert.equal(r.sizes[2].measured, false);
  assert.ok(r.sizes[2].error.length);
});

test('a hostile or oversized sizes array is refused rather than truncated silently', () => {
  assert.ok(errsOf(one({ type: 'ping', target: 'h', sizes: 'lots' })).length);
  assert.ok(errsOf(one({ type: 'ping', target: 'h', sizes: new Array(9).fill({ bytes: 1 }) })).length);
});

test('path_mtu collapses into one stored object, and its hops stay out of the traceroute column', () => {
  const { value } = one({
    type: 'path_mtu', target: 'h', ok: true,
    pathMtu: 1400, blackholeDetected: true, recommendedMss: 1360, mtuDropAtHop: 3,
    low: 548, high: 1472, overheadBytes: 28,
    probes: [{ bytes: 548, packetBytes: 576, ok: true }, { bytes: 1472, packetBytes: 1500, ok: false }],
    hops: [
      { hop: 1, ip: '10.0.0.1', respondsSmall: true, okAtLarge: true },
      { hop: 2, ip: '10.0.0.2', respondsSmall: true, okAtLarge: false },
      { hop: 3, ip: '10.0.0.3', respondsSmall: false, okAtLarge: null },
    ],
  });
  const r = value.results[0];
  assert.equal(r.mtu.pathMtu, 1400);
  assert.equal(r.mtu.blackholeDetected, true);
  assert.equal(r.mtu.recommendedMss, 1360);
  assert.equal(r.mtu.mtuDropAtHop, 3);
  assert.equal(r.mtu.probes.length, 2);
  // A hop that never answered a small packet was never asked the large one.
  assert.equal(r.mtu.hops[2].okAtLarge, null);
  assert.equal(r.mtu.hops[1].okAtLarge, false);
  // Per-hop MTU reachability is not per-hop latency, so it does not go in `hops`.
  assert.equal(r.hops, null);
});

test('a blackhole is only claimed by a run that got far enough to have an opinion', () => {
  const { value } = one({ type: 'path_mtu', target: 'h', ok: false, blackholeDetected: false, error: 'no answer' });
  assert.equal(value.results[0].mtu.pathMtu, null);
  assert.equal(value.results[0].mtu.blackholeDetected, false);
  // and facts.js is what refuses to hand that to a rule — see diagnoseRules.
});

test('the new columns round-trip through the repository mapper', () => {
  const sizes = [{ bytes: 64, lossPct: 0, measured: true }];
  const mtu = { pathMtu: 1400, blackholeDetected: true, probes: [], hops: [] };
  const row = toRow(7, { type: 'ping', target: 'h', ok: true, ts: new Date(0), sizes, mtu });
  const back = fromRow({
    id: 1, agent_id: 7, ts: new Date(0), type: 'ping', target: 'h', ok: 1,
    sizes: row[16], mtu: row[17],
  });
  assert.deepEqual(back.sizes, sizes);
  assert.deepEqual(back.mtu, mtu);
});

test('an old agent\'s result leaves the new columns null rather than defaulting them', () => {
  // The normal case for weeks while a fleet updates. "Absent" must not read as
  // "measured and fine".
  const { value } = one({ type: 'ping', target: 'h', ok: true, lossPct: 0 });
  assert.equal(value.results[0].sizes, null);
  assert.equal(value.results[0].mtu, null);
  const row = toRow(1, value.results[0]);
  assert.equal(row[16], null);
  assert.equal(row[17], null);
});
