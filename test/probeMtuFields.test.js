'use strict';

// The MTU probes' data on its way through the server: what the spec validator
// accepts, what the result validator stores, and the one place a diagnostic
// probe must NOT be counted.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateProbeSpec, validateProbeResults, PROBE_TYPES } = require('../src/validation/probeValidation');
const { toRow, fromRow, COLUMNS } = require('../src/repositories/probeResultsRepository');

const errsOf = (r) => Object.keys(r.errors || {});
const one = (r) => validateProbeResults({ results: [r] });

// --- the spec ----------------------------------------------------------------

// The path_mtu SPEC — its bounds, its hostile-target guard — belongs to the
// probe's own suite (test/pathMtuApi.test.js). What this file covers is the
// ping size sweep, and the seam where a stored path_mtu row becomes something
// the diagnosis can reason about.
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

test('a path_mtu row lands in the mtu block, with its hops in the ordinary hops column', () => {
  // The storage shape is main's (migration 096): camelCase inside `mtu`, and
  // the per-hop numbers riding in the SAME `hops` column the traceroute probes
  // use, with the latency fields null and maxMtu/status filled in.
  const { value } = one({
    type: 'path_mtu', target: 'h', ok: true,
    path_mtu: 1400, blackhole_detected: true, icmp_frag_needed_seen: false,
    mtu_drop_at_hop: 3, recommended_mss: 1360, mss_supported: true, mss_observed: 1460,
    hops: [
      { hop: 1, ip: '10.0.0.1', max_mtu: 1500, status: 'ok' },
      { hop: 2, ip: '10.0.0.2', max_mtu: null, status: 'no_response' },
      { hop: 3, ip: '10.0.0.3', max_mtu: 1400, status: 'blackhole' },
    ],
  });
  const r = value.results[0];
  assert.equal(r.mtu.pathMtu, 1400);
  assert.equal(r.mtu.blackholeDetected, true);
  assert.equal(r.mtu.recommendedMss, 1360);
  assert.equal(r.mtu.mssObserved, 1460);
  assert.deepEqual(r.hops.map((h) => h.status), ['ok', 'no_response', 'blackhole']);
  assert.equal(r.hops[0].maxMtu, 1500);
  // The latency fields are null on a path_mtu hop, and that is the point of one
  // hop shape rather than two.
  assert.equal(r.hops[0].rttMs, null);
});

test('the diagnosis reads that row without needing to know how it was stored', () => {
  const { buildFacts } = require('../src/diagnose/facts');
  const { value } = one({
    type: 'path_mtu', target: 'h', ok: true,
    path_mtu: 1400, blackhole_detected: true, mss_supported: true, mss_observed: 1460,
    hops: [{ hop: 3, ip: '10.0.0.3', max_mtu: 1400, status: 'blackhole' }],
  });
  const f = buildFacts({ results: [{ type: 'path_mtu', ok: true, mtu: value.results[0].mtu, hops: value.results[0].hops }] });
  assert.equal(f.path_mtu.path_mtu, 1400);
  assert.equal(f.path_mtu.blackhole_detected, true);
  assert.equal(f.path_mtu.mtu_drop_at_hop, 3);
  assert.equal(f.path_mtu.mss_exceeds_path, true);
});

test('the new columns round-trip through the repository mapper', () => {
  const sizes = [{ bytes: 64, lossPct: 0, measured: true }];
  const mtu = { pathMtu: 1400, blackholeDetected: true };
  const row = toRow(7, { type: 'ping', target: 'h', ok: true, ts: new Date(0), sizes, mtu });
  const mtuIdx = COLUMNS.indexOf('mtu');
  const sizesIdx = COLUMNS.indexOf('sizes');
  assert.ok(mtuIdx >= 0 && sizesIdx >= 0, 'both JSON columns are in the insert list');
  const back = fromRow({
    id: 1, agent_id: 7, ts: new Date(0), type: 'ping', target: 'h', ok: 1,
    sizes: row[sizesIdx], mtu: row[mtuIdx],
  });
  assert.deepEqual(back.sizes, sizes);
  assert.deepEqual(back.mtu, mtu);
});

test('an old agent\'s result leaves the sweep column null rather than defaulting it', () => {
  // The normal case for weeks while a fleet updates. "Absent" must not read as
  // "measured and fine".
  const { value } = one({ type: 'ping', target: 'h', ok: true, lossPct: 0 });
  assert.equal(value.results[0].sizes, null);
  assert.equal(value.results[0].mtu, null);
  const row = toRow(1, value.results[0]);
  assert.equal(row[COLUMNS.indexOf('sizes')], null);
  assert.equal(row[COLUMNS.indexOf('mtu')], null);
});
