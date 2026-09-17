'use strict';

// The sigma that wasn't. Both detectors divided by `mad * 1.4826 || 1e-9`, so a
// baseline with no spread produced a "deviation" of the raw difference times
// 10^9 — the dashboard printed
//
//   Flow 4->9:443 volume 0B deviated -92845056000000000.0σ from its 92845056B
//   baseline for this weekday/hour
//
// which is 92,845,056 bytes / 1e-9, and cleared any crit threshold by sixteen
// orders of magnitude. Every constant pair that changed at all became a CRIT.

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { robustSigma, sigmaFromMad, meanAbsDev, median, mad, MAD_TO_SIGMA } = require('../src/analysis/baselines');
const { zScore, classify } = require('../src/analysis/flowPairBaseline');

test('a baseline with no spread yields no sigma, not an infinitesimal one', () => {
  assert.equal(sigmaFromMad(0), null, 'a zero MAD is an undefined scale, never 1e-9');
  assert.equal(sigmaFromMad(null), null);
  assert.equal(sigmaFromMad(undefined), null);
  assert.ok(sigmaFromMad(1000) > 0);
});

test('the flow-pair z-score refuses to invent a deviation for a flat slot', () => {
  const flat = { medianBytes: 92845056, madBytes: 0 };
  assert.equal(zScore(flat, 0), null,
    'this is the -92845056000000000σ finding: a byte difference divided by 1e-9');
  assert.equal(classify(zScore(flat, 0)), null, 'and it must not raise a CRIT');

  // The same pair with a real spread still scores, and still raises.
  const real = { medianBytes: 92845056, madBytes: 1000000 };
  const z = zScore(real, 0);
  assert.ok(Number.isFinite(z), 'a baseline WITH scale must still be scored');
  assert.ok(Math.abs(z) > 4, `an 88 MiB drop against a 1 MB MAD is a real anomaly (got ${z})`);
  assert.equal(classify(z), 'CRIT');
});

test('no sigma is ever so small that an ordinary change looks like a catastrophe', () => {
  // The property the old code broke: a stated deviation is a measurement, so it
  // may never exceed what the data can support. 1e-9 could support anything.
  for (const madBytes of [0, null, undefined, NaN, -1]) {
    const z = zScore({ medianBytes: 5000, madBytes }, 4000);
    assert.ok(z === null || Math.abs(z) < 1e6,
      `madBytes=${madBytes} produced ${z}`);
  }
});

test('robustSigma falls back to the mean absolute deviation before giving up', () => {
  // MAD is a MEDIAN of absolute deviations, so it reads 0 as soon as more than
  // half the samples are identical — even when the series plainly varies.
  const varying = [5, 5, 5, 5, 9];
  assert.equal(mad(varying, median(varying)), 0, 'MAD really is 0 here');
  assert.ok(meanAbsDev(varying, median(varying)) > 0);
  const sigma = robustSigma(varying);
  assert.ok(sigma > 0, 'a series that varies must keep a usable scale');
  assert.equal(sigma, meanAbsDev(varying, median(varying)) * MAD_TO_SIGMA);

  // Genuinely constant: no scale exists, and none is invented.
  assert.equal(robustSigma([7, 7, 7, 7]), null);
  assert.equal(robustSigma([]), null);
});

// The detection the sigma bug was hiding inside. A flat slot that suddenly
// changes IS what this job exists for — the fix must keep the finding and drop
// only the fabricated magnitude.
const { scoreDeviation, FLAT_MIN_BYTES } = require('../src/analysis/flowPairBaseline');

test('a flat baseline still raises on a real jump, stated as a ratio', () => {
  const flat = { medianBytes: 100, madBytes: 0 };
  const hit = scoreDeviation(flat, 100000);
  assert.equal(hit.severity, 'CRIT');
  assert.equal(hit.basis, 'ratio', 'there is no sigma here, and none is claimed');
  assert.equal(hit.z, null);
  assert.ok(hit.ratio > 900, `99900/100 is ~999x, got ${hit.ratio}`);
});

test('a flat baseline does not raise on jitter under the byte floor', () => {
  const flat = { medianBytes: 100, madBytes: 0 };
  // 40x the baseline in RATIO terms, but 4 KB is not an incident on a pair that
  // normally sends 100 bytes. Both tests must pass, or the ratio rule replaces
  // one false-positive class with another.
  assert.equal(scoreDeviation(flat, 100 + FLAT_MIN_BYTES - 1).severity, null);
  assert.equal(scoreDeviation(flat, 100).severity, null, 'no change is no finding');
});

test('a pair that normally sends nothing reports new traffic, not a division', () => {
  const idle = { medianBytes: 0, madBytes: 0 };
  const hit = scoreDeviation(idle, 5_000_000);
  assert.equal(hit.severity, 'CRIT');
  assert.equal(hit.ratio, Infinity, 'x/0 is not a multiple of anything');
  assert.equal(hit.z, null);
});
