'use strict';

// Comparing a screenshot against its baseline (V2 §8).
//
// The spec warns that this "must not turn small dynamic differences into false
// failures", and that is what most of these assertions are about. Every visual
// regression tool that ends up switched off is switched off for the same reason:
// a clock or one pixel of antialiasing turned the build red once too often.
//
// The single most important test in this file is the last one in the
// false-positives block: a difference is never a failure.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const { compareScreenshots, describeComparison, normalizeRegions } = require('../compare');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

// An RGBA PNG from a pixel function: paint(x, y) -> [r,g,b,a].
function png(width, height, paint) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [0];
    for (let x = 0; x < width; x += 1) row.push(...paint(x, y));
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const WHITE = () => [255, 255, 255, 255];
const W = 100;
const H = 100; // 10,000 pixels — 1% is exactly 100 of them

// A page with a block of `colour` in a rectangle, white everywhere else.
const pageWithBlock = (x0, y0, w, h, colour) => png(W, H, (x, y) =>
  (x >= x0 && x < x0 + w && y >= y0 && y < y0 + h) ? colour : WHITE());

// ------------------------------------------------------------ the happy path
test('an identical page matches, and says so rather than reporting 0%', () => {
  const page = pageWithBlock(10, 10, 20, 20, [0, 0, 255, 255]);
  const res = compareScreenshots(page, page);
  // "0.2% different" invites somebody to treat a clean comparison as a small
  // problem. A match is a match.
  assert.equal(res.status, 'match');
  assert.equal(res.changed_pixels, 0);
  assert.equal(describeComparison(res), 'Looks the same.');
});

test('a real change is reported with where it is', () => {
  const before = pageWithBlock(10, 10, 30, 30, [0, 0, 255, 255]);
  const after = pageWithBlock(60, 60, 30, 30, [0, 0, 255, 255]);
  const res = compareScreenshots(before, after);

  assert.equal(res.status, 'changed');
  assert.equal(res.changed_pixels, 1800, 'both the old block and the new one differ');
  assert.equal(res.changed_pct, 18);
  // Which part of the page moved, as a few boxes. "Which part" is the question
  // a person asks; a list of 1800 coordinates is not an answer to it.
  assert.ok(res.regions.length);
  assert.ok(res.regions.every((r) => r.pixels > 0));
  assert.match(describeComparison(res), /18% of the page looks different/);
});

// ------------------------------------------------------ the false positives
test('antialiasing and sub-pixel rendering are not differences', () => {
  // The same page rendered twice, a few levels apart on every channel. This is
  // what two screenshots of an UNCHANGED page actually look like.
  const before = png(W, H, () => [200, 200, 200, 255]);
  const after = png(W, H, () => [206, 204, 197, 255]);
  const res = compareScreenshots(before, after);
  assert.equal(res.status, 'match', `${res.changed_pct}% over tolerance`);
});

test('a handful of changed pixels is below the threshold and is not a report', () => {
  // 50 of 10,000 pixels = 0.5%, which is the threshold, not over it.
  const before = png(W, H, WHITE);
  const after = png(W, H, (x, y) => (y === 0 && x < 50 ? [0, 0, 0, 255] : WHITE()));
  const res = compareScreenshots(before, after);
  assert.equal(res.changed_pixels, 50);
  assert.equal(res.status, 'match', 'the threshold is a floor to be exceeded, not met');
});

test('an ignore region excludes the part the operator knows moves', () => {
  // The clock in the corner. Without the region this is a change on every run,
  // forever, which is exactly how these features get switched off.
  const before = pageWithBlock(0, 0, 40, 40, [0, 0, 0, 255]);
  const after = pageWithBlock(0, 0, 40, 40, [255, 0, 0, 255]);

  const noisy = compareScreenshots(before, after);
  assert.equal(noisy.status, 'changed');

  const quiet = compareScreenshots(before, after, {
    ignoreRegions: [{ x: 0, y: 0, width: 40, height: 40, label: 'clock' }],
  });
  assert.equal(quiet.status, 'match');
  assert.equal(quiet.ignored_pixels, 1600);
  // The percentage is over what was actually COMPARED. Diluting it with pixels
  // nobody looked at would understate every real change on a page with a big
  // ignored area.
  assert.equal(quiet.compared_pixels, 10000 - 1600);
  assert.match(describeComparison(quiet), /1 ignored area/);
});

test('a change OUTSIDE an ignore region is still found', () => {
  // The region must exclude a place, not switch the check off.
  const before = pageWithBlock(50, 50, 30, 30, [0, 0, 0, 255]);
  const after = png(W, H, WHITE);
  const res = compareScreenshots(before, after, {
    ignoreRegions: [{ x: 0, y: 0, width: 40, height: 40 }],
  });
  assert.equal(res.status, 'changed');
});

test('a visual difference is NEVER a failure', () => {
  // The promise the whole feature rests on. A moved button is not an outage,
  // and a check that can turn a build red is one people switch off.
  const before = png(W, H, WHITE);
  const after = png(W, H, () => [0, 0, 0, 255]);
  const res = compareScreenshots(before, after);
  assert.equal(res.changed_pct, 100);
  // Every status this can produce, and none of them is a failure.
  assert.ok(['match', 'changed', 'resized', 'uncomparable'].includes(res.status));
  assert.notEqual(res.status, 'fail');
});

// ------------------------------------------------------------- size changes
test('a differently-sized page is "resized", not a percentage', () => {
  // A page that grew a section is not "3.4% different" — it is a different
  // shape, and a percentage over the overlap answers a question nobody asked.
  const before = png(100, 100, WHITE);
  const after = png(100, 140, WHITE);
  const res = compareScreenshots(before, after);

  assert.equal(res.status, 'resized');
  assert.equal(res.changed_pct, 0, 'no misleading percentage is invented');
  assert.deepEqual(res.baseline_size, { width: 100, height: 100 });
  assert.deepEqual(res.current_size, { width: 100, height: 140 });
  assert.match(describeComparison(res), /100×100 → 100×140/);
});

// ------------------------------------------------------------ unreadable
test('an unreadable screenshot is said plainly, never reported as a match', () => {
  // Reporting this as "nothing changed" would mean a broken baseline silently
  // stops watching the page — the worst possible failure mode for this feature.
  const good = png(10, 10, WHITE);
  const res = compareScreenshots(Buffer.from('not a png'), good);
  assert.equal(res.status, 'uncomparable');
  assert.match(res.reason, /not a PNG/);
  assert.equal(res.changed_pct, 0);

  assert.equal(compareScreenshots(good, null).status, 'uncomparable');
  assert.equal(compareScreenshots(null, null).status, 'uncomparable');
});

// ----------------------------------------------------------------- tuning
test('tolerance and threshold do what they say', () => {
  const before = png(W, H, () => [100, 100, 100, 255]);
  const after = png(W, H, () => [120, 100, 100, 255]); // 20 apart on one channel

  assert.equal(compareScreenshots(before, after, { tolerance: 30 }).status, 'match');
  assert.equal(compareScreenshots(before, after, { tolerance: 5 }).status, 'changed');

  // A whole-page change passes any tolerance test but can be thresholded away.
  assert.equal(compareScreenshots(before, after, { tolerance: 5, thresholdPct: 100 }).status, 'match');
});

test('a hue change is not diluted by averaging across channels', () => {
  // A red button turning green moves two channels a long way. A Euclidean
  // distance would average that toward the middle; the thing a person would
  // obviously call different must not be what the maths smooths away.
  const before = png(W, H, () => [255, 0, 0, 255]);
  const after = png(W, H, () => [0, 255, 0, 255]);
  assert.equal(compareScreenshots(before, after).status, 'changed');
});

test('two transparent pixels are the same however they are coloured', () => {
  // Whatever colour sits under full transparency is not visible, so it is not a
  // difference anybody can see.
  const before = png(W, H, () => [255, 0, 0, 0]);
  const after = png(W, H, () => [0, 0, 255, 0]);
  assert.equal(compareScreenshots(before, after).status, 'match');
});

// ------------------------------------------------------------ ignore regions
test('a region drawn off the edge is repaired, not refused', () => {
  // Obviously meant to reach the edge. Failing the whole comparison over it
  // would be pedantry with a real cost.
  const regions = normalizeRegions([{ x: 90, y: 90, width: 50, height: 50 }], 100, 100);
  assert.deepEqual(regions, [{ x1: 90, y1: 90, x2: 100, y2: 100, label: null }]);
});

test('junk regions are dropped rather than throwing', () => {
  assert.deepEqual(normalizeRegions([null, 'x', {}, { x: 5, y: 5, width: 0, height: 9 }], 100, 100), []);
  assert.deepEqual(normalizeRegions(null, 100, 100), []);
  assert.deepEqual(normalizeRegions([{ x: -50, y: -50, width: 10, height: 10 }], 100, 100), []);
});

test('overlapping regions do not double-count the pixels they share', () => {
  const before = png(W, H, WHITE);
  const after = png(W, H, () => [0, 0, 0, 255]);
  const res = compareScreenshots(before, after, {
    ignoreRegions: [{ x: 0, y: 0, width: 50, height: 50 }, { x: 25, y: 25, width: 50, height: 50 }],
  });
  // 2500 + 2500 − 625 shared. Counting the overlap twice would report more
  // pixels ignored than the image contains.
  assert.equal(res.ignored_pixels, 4375);
  assert.equal(res.compared_pixels, 10000 - 4375);
});
