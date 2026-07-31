'use strict';

// The events table has columns for severity, device and location, and the
// server's stored title repeats all three ("CRIT probe.latency on Localhost
// agent test (gnf-server-agent)"). These cover the trim that leaves only the
// condition — and, more importantly, every case where it must NOT trim, because
// a wrong strip silently changes what an operator reads.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ET = require('../public/eventTitle');

const LABEL = 'Localhost agent test (gnf-server-agent)';

test('the reported row: severity and device tail both come off', () => {
  assert.equal(
    ET.conditionOf('CRIT probe.latency on Localhost agent test (gnf-server-agent)', 'CRIT', LABEL),
    'probe.latency'
  );
  assert.equal(ET.conditionOf('WARN probe.jitter on Fellis Agent 007 (Fellis)', 'WARN', 'Fellis Agent 007 (Fellis)'), 'probe.jitter');
});

test('a device with no site still trims', () => {
  assert.equal(ET.conditionOf('WARN cpu on core-sw', 'WARN', 'core-sw'), 'cpu');
});

test('the severity comes off only when it matches the row badge', () => {
  // Mismatched — the title is describing a different severity than the row.
  assert.equal(ET.conditionOf('CRIT cpu on core-sw', 'WARN', 'core-sw'), 'CRIT cpu');
  // Long forms normalise.
  assert.equal(ET.conditionOf('CRITICAL cpu on core-sw', 'CRIT', 'core-sw'), 'cpu');
  assert.equal(ET.conditionOf('WARNING cpu on core-sw', 'WARN', 'core-sw'), 'cpu');
});

test('the device tail comes off only on an EXACT match', () => {
  // Agent renamed since the title was stored: the tail no longer matches, so
  // the full title stays rather than silently hiding the discrepancy.
  assert.equal(
    ET.conditionOf('CRIT cpu on old-name (HQ)', 'CRIT', 'new-name (HQ)'),
    'cpu on old-name (HQ)'
  );
  // A metric containing " on " is not a device tail.
  assert.equal(
    ET.conditionOf('WARN power on self test on core-sw', 'WARN', 'core-sw'),
    'power on self test'
  );
  // No label to match against → leave the tail alone.
  assert.equal(ET.conditionOf('WARN cpu on core-sw', 'WARN', null), 'cpu on core-sw');
});

test('never trims a title down to nothing', () => {
  // Title IS just the severity.
  assert.equal(ET.conditionOf('CRIT', 'CRIT', LABEL), 'CRIT');
  // Title IS just the device tail — trimming leaves the fragment "on core-sw",
  // which is not a shorter truth, so the stored title is shown instead.
  assert.equal(ET.conditionOf(' on core-sw', 'WARN', 'core-sw'), 'on core-sw');
  // Severity + device with no condition between them.
  assert.equal(ET.conditionOf('CRIT on core-sw', 'CRIT', 'core-sw'), 'CRIT on core-sw');
});

test('an unrecognised or hand-edited title is returned unchanged', () => {
  assert.equal(ET.conditionOf('Ring buffer overruns after the Tuesday change', 'CRIT', LABEL),
    'Ring buffer overruns after the Tuesday change');
  assert.equal(ET.conditionOf('', 'CRIT', LABEL), '');
  assert.equal(ET.conditionOf(null, 'CRIT', LABEL), '');
  assert.equal(ET.conditionOf(undefined, undefined, undefined), '');
});
