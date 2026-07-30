'use strict';

// Unit tests for src/changes/indications.js — the metric → condition-family map
// behind the feed's "what does this indicate?" line. Pure: no DB, no clock.
//
// The contract that matters here is the NEGATIVE one: an unrecognised metric must
// return null so the UI offers no interpretation, rather than confidently
// offering the wrong one. Metrics are minted by whatever an agent reports, so
// "unknown" is a permanent, expected case — not an error.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { metricFamily, FAMILY_KEYS } = require('../src/changes/indications');

test('the metrics this codebase actually emits all classify', () => {
  const expected = {
    'probe.latency': 'latency',
    'app.latency': 'latency',
    'transaction.latency': 'latency',
    'io.await': 'latency',
    latency: 'latency',
    'probe.loss': 'loss',
    drop: 'loss',
    'probe.cert': 'certificate',
    cert: 'certificate',
    'probe.aspath': 'routing',
    aspath: 'routing',
    clock: 'clock',
    'if.errors': 'interface',
    interface: 'interface',
    throughput: 'saturation',
    'flow.volume': 'saturation',
    cpu: 'resources',
    mem: 'resources',
    disk: 'resources',
    flatline: 'flatline',
    uptime: 'availability',
    connection: 'connections',
    'transaction.fail': 'transaction',
    'transaction.deviation': 'transaction',
  };
  for (const [metric, family] of Object.entries(expected)) {
    assert.equal(metricFamily(metric), family, `${metric} should read as ${family}`);
  }
});

test('a metric we do not recognise yields no interpretation rather than a wrong one', () => {
  assert.equal(metricFamily('quux_gauge_17'), null);
  assert.equal(metricFamily(''), null);
  assert.equal(metricFamily(null), null);
  assert.equal(metricFamily(undefined), null);
});

test('classification is case-insensitive', () => {
  assert.equal(metricFamily('PROBE.LATENCY'), 'latency');
  assert.equal(metricFamily('If.Errors'), 'interface');
});

test('the specific families win over the broad ones', () => {
  // `probe.cert` contains no latency token, but a name like `cert.check.delay`
  // matches both `cert` and `delay` — certificate must win, because a certificate
  // finding is a deadline, not a performance problem.
  assert.equal(metricFamily('cert.check.delay'), 'certificate');
  // Likewise a flatlined latency metric is a dead exporter, not a slow path.
  assert.equal(metricFamily('latency.flatline'), 'flatline');
});

// Every family this module can return needs wording in BOTH catalogues, or the
// dashboard renders a bare `changes.indicates.<family>` key at the reader. The
// general i18n parity test cannot catch this: it compares en to da, and a family
// missing from both would pass it.
test('every family has wording in both translation catalogues', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8');
  for (const family of FAMILY_KEYS) {
    const key = `'changes.indicates.${family}'`;
    const occurrences = src.split(key).length - 1;
    assert.equal(occurrences, 2, `${key} must appear in both en and da (found ${occurrences})`);
  }
});
