'use strict';

// Performance baselines (V2 §9).
//
// The thing under test is what BlueEyes calls "normal". Get that wrong in one
// direction and it cries wolf until people mute it; wrong in the other and it
// never notices a service that has doubled in latency.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { baselineFrom, compare, stepBaselines, fmt, MIN_SAMPLES } = require('../baseline');

const STEADY = [820, 910, 870, 880, 840, 900, 860];

test('a baseline is a median and a band, from the test\'s own runs', () => {
  const b = baselineFrom(STEADY);
  assert.equal(b.enough, true);
  assert.equal(b.median, 870);
  assert.equal(b.samples, 7);
  assert.ok(b.low < b.median && b.median < b.high);
});

test('one catastrophic run barely moves the baseline', () => {
  // This is the whole reason for median + MAD. With a mean and a standard
  // deviation, one 30-second timeout drags "normal" up until nothing ever looks
  // slow again — the failure mode of every naive latency alarm.
  const clean = baselineFrom(STEADY);
  const withOutlier = baselineFrom([...STEADY, 30000]);
  assert.ok(Math.abs(withOutlier.median - clean.median) < 50,
    `the median moved from ${clean.median} to ${withOutlier.median}`);
  assert.ok(withOutlier.high < 2000, 'and the band did not open wide enough to swallow a real regression');
});

test('too little history is "unknown", never "normal"', () => {
  for (const n of [0, 1, 2, 3, 4]) {
    const b = baselineFrom(new Array(n).fill(800));
    assert.equal(b.enough, false, `${n} samples must not be enough`);
    assert.equal(b.median, null);
  }
  assert.equal(baselineFrom(new Array(MIN_SAMPLES).fill(800)).enough, true);

  const verdict = compare(4700, baselineFrom([800, 900]));
  assert.equal(verdict.verdict, 'unknown');
  assert.match(verdict.reason, /not enough/);
});

test('missing durations never enter the baseline as zeroes', () => {
  // The Number(null) trap in its most damaging place: an unmeasured run
  // counting as "instant" drags normal towards zero, and then everything
  // afterwards looks slow.
  const withGaps = baselineFrom([820, 910, null, 880, '', 840, undefined, 900, 860]);
  const clean = baselineFrom(STEADY);
  assert.equal(withGaps.median, clean.median);
  assert.equal(withGaps.samples, 6, 'only the measured runs count');
});

test('slow needs to be outside the band AND materially slower', () => {
  const b = baselineFrom(STEADY);
  assert.equal(compare(4700, b).verdict, 'slow');
  assert.equal(compare(870, b).verdict, 'normal');

  // A test that is consistently 400 ms ±2 ms must not scream at 420. The
  // minimum spread is what stops that.
  const tight = baselineFrom([400, 401, 399, 400, 402, 398, 400]);
  assert.equal(compare(420, tight).verdict, 'normal', 'a 20 ms change no user would feel');
  assert.equal(compare(4000, tight).verdict, 'slow');
});

test('slow is a warning about the service, never a verdict on the test', () => {
  const verdict = compare(4700, baselineFrom(STEADY));
  // The reason must give both numbers: the operator is being asked to judge a
  // comparison, and one number is not a comparison.
  assert.match(verdict.reason, /4\.7 s/);
  assert.match(verdict.reason, /7 runs/);
  assert.equal(verdict.ratio > 5, true);
});

test('unexpectedly fast is reported, and is not treated as good news', () => {
  const verdict = compare(80, baselineFrom(STEADY));
  assert.equal(verdict.verdict, 'fast');
  // A run that finishes in a tenth of the usual time is often a page that
  // stopped loading something, not a page that got quicker.
  assert.match(verdict.reason, /stopped loading|Worth a look/);
});

test('an unmeasured run is unknown, not fast', () => {
  const b = baselineFrom(STEADY);
  for (const missing of [null, undefined, '']) {
    const verdict = compare(missing, b);
    assert.equal(verdict.verdict, 'unknown', `${JSON.stringify(missing)} must not be a verdict`);
    assert.equal(verdict.duration_ms, null);
  }
  // A genuine zero is a real measurement and is judged as one.
  assert.notEqual(compare(0, b).verdict, 'unknown');
});

test('durations read the way a person says them', () => {
  assert.equal(fmt(870), '870 ms');
  assert.equal(fmt(4700), '4.7 s');
  assert.equal(fmt(45000), '45 s');
  assert.equal(fmt(null), 'unknown');
  assert.equal(fmt(4700, 'da'), '4,7 s');
});

test('step baselines compare like with like', () => {
  const runs = [
    [{ position: 0, step_type: 'open', status: 'pass', duration_ms: 500 },
      { position: 1, step_type: 'click', status: 'pass', duration_ms: 200 }],
    [{ position: 0, step_type: 'open', status: 'pass', duration_ms: 520 },
      { position: 1, step_type: 'click', status: 'pass', duration_ms: 210 }],
    [{ position: 0, step_type: 'open', status: 'pass', duration_ms: 480 },
      { position: 1, step_type: 'click', status: 'pass', duration_ms: 190 }],
    [{ position: 0, step_type: 'open', status: 'pass', duration_ms: 510 },
      // A FAILED step's duration is the duration of a failure, not of the step.
      { position: 1, step_type: 'click', status: 'fail', duration_ms: 30000 }],
    [{ position: 0, step_type: 'open', status: 'pass', duration_ms: 495 },
      { position: 1, step_type: 'click', status: 'pass', duration_ms: 205 }],
    [{ position: 0, step_type: 'open', status: 'pass', duration_ms: 505 },
      { position: 1, step_type: 'click', status: 'pass', duration_ms: 195 }],
  ];
  const map = stepBaselines(runs);
  // Keyed by position AND type, so a reordered test does not compare step 3
  // against whatever used to be third.
  assert.ok(map.has('0:open'));
  assert.ok(map.has('1:click'));
  assert.equal(map.get('0:open').samples, 6);
  assert.equal(map.get('1:click').samples, 5, 'the failed step must not be in its own baseline');
  assert.ok(map.get('1:click').median < 300);
});

test('nothing to work with yields nothing, never a crash', () => {
  assert.equal(baselineFrom(null).enough, false);
  assert.equal(baselineFrom('nope').enough, false);
  assert.equal(baselineFrom([-5, -10]).enough, false, 'a negative duration is not a duration');
  assert.equal(compare(100, null).verdict, 'unknown');
  assert.equal(compare(100, {}).verdict, 'unknown');
  assert.deepEqual([...stepBaselines(null).keys()], []);
  assert.deepEqual([...stepBaselines([null, 'x', [null]]).keys()], []);
});
