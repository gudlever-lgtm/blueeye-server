'use strict';

// The SNMP feature docs state numbers. This checks they are the code's numbers.
//
// Same reason `guideAccuracy.test.js` exists for the Service Assurance guide: a
// document stops being true not because somebody rewrites it wrongly, but
// because somebody moves a default and nobody remembers a file three
// directories away quotes it. Only MECHANICAL claims — prose is not testable,
// and a test that fails on a rewording is a test people delete.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const doc = (name) => fs.readFileSync(path.join(__dirname, '..', 'docs', name), 'utf8');

const { MAX_DELTA_SEC, MIN_DELTA_SEC } = require('../src/devices/counterDelta');
const {
  MIN_COUNTER_INTERVAL_SEC, MAX_COUNTER_INTERVAL_SEC,
} = require('../src/validation/snmpDeviceValidation');
const { MAX_BASELINE_PORTS, REFRACTORY_MINUTES } = require('../src/analysis/l2LoopService');
const {
  MIN_FLAPPING_MACS, MIN_SURGING_PORTS, CRIT_SCORE, WARN_SCORE,
} = require('../src/analysis/l2Loop');

test('device-counters.md quotes the cadence bounds the validator enforces', () => {
  const counters = doc('device-counters.md');

  assert.equal(MAX_COUNTER_INTERVAL_SEC, MAX_DELTA_SEC,
    'the cadence ceiling IS the gap ceiling — a wider cadence voids every rate it produces');
  assert.ok(counters.includes(`capped at ${MAX_COUNTER_INTERVAL_SEC} seconds`),
    `the doc does not state the ${MAX_COUNTER_INTERVAL_SEC}-second ceiling`);
  assert.ok(counters.includes(`floored\nat ${MIN_COUNTER_INTERVAL_SEC} seconds`)
    || counters.includes(`floored at ${MIN_COUNTER_INTERVAL_SEC} seconds`),
  `the doc does not state the ${MIN_COUNTER_INTERVAL_SEC}-second floor`);

  // The `gap` row of the discontinuity table.
  assert.ok(counters.includes(`over ${MAX_DELTA_SEC / 60} minutes`),
    'the gap table does not state the upper bound the code uses');
  assert.ok(counters.includes(`under ${MIN_DELTA_SEC} seconds`),
    'the gap table does not state the lower bound the code uses');
});

test('l2-loop.md quotes the thresholds the detector actually applies', () => {
  const loop = doc('l2-loop.md');

  assert.ok(loop.includes(`capped at ${MAX_BASELINE_PORTS} ports`),
    `the doc does not state the ${MAX_BASELINE_PORTS}-port baseline cap`);
  assert.ok(loop.includes(`per device per ${REFRACTORY_MINUTES} minutes`),
    `the doc does not state the ${REFRACTORY_MINUTES}-minute refractory period`);
  // The scoring block the doc publishes so the rule can be argued with. A
  // block that disagrees with the arithmetic is worse than no block.
  assert.ok(loop.includes(`flapping MACs >= ${MIN_FLAPPING_MACS}`),
    'the scoring block does not state the flapping-MAC minimum the code uses');
  assert.ok(loop.includes(`broadcast surging on >= ${MIN_SURGING_PORTS}`),
    'the scoring block does not state the surging-port minimum the code uses');
  assert.ok(loop.includes(`score >= ${CRIT_SCORE} \u2192 CRIT`),
    'the scoring block does not state the CRIT threshold the code uses');
  assert.ok(loop.includes(`>= ${WARN_SCORE} \u2192 WARN`),
    'the scoring block does not state the WARN threshold the code uses');

  assert.ok(MIN_SURGING_PORTS <= MAX_BASELINE_PORTS,
    'the baseline cap is below the number of surging ports the rule needs — the rule could never fire');
});
