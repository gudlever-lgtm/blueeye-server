'use strict';

// Visual regression inside a run (V2 §8).
//
// The comparison itself is argued with in compare.test.js. This is about how it
// behaves as part of an execution: opt-in per step, photographed only after the
// step passed, and — the promise the whole feature rests on — never able to
// change what the run concluded.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const { makeFakeDriver } = require('../../runner/__tests__/fakeDriver');
const { executeDefinition } = require('../../runner/execute');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}
function png(width, height, paint) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [0];
    for (let x = 0; x < width; x += 1) row.push(...paint(x, y));
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const WHITE = png(40, 40, () => [255, 255, 255, 255]);
const BLACK = png(40, 40, () => [0, 0, 0, 255]);

const TEST = {
  version: 1,
  name: 'Front page',
  steps: [
    { type: 'open', url: '/' },
    { type: 'assert_visible', target: { text: 'Welcome' } },
  ],
};

let clock = 0;
const tick = () => { clock += 100; return clock; };

// A driver that answers screenshots with whatever the current page "looks like".
function driverShowing(image, opts = {}) {
  const base = makeFakeDriver({ present: ['Welcome'], visible: ['Welcome'], ...opts });
  const shots = [];
  return {
    driver: { ...base, screenshot: async (o) => { shots.push(o); return image; } },
    shots,
  };
}

const run = (driver, baselines, readBaseline) => {
  clock = 0;
  return executeDefinition(TEST, {
    driver, now: tick,
    visualBaselines: baselines,
    readBaseline: readBaseline || (async () => WHITE),
  });
};

const BASELINE = { id: 1, step_index: 1, ignore_regions: [] };

test('nothing is photographed unless a step has a baseline', async () => {
  // A screenshot per step costs real time on every run. A test nobody opted in
  // must not pay for it.
  const { driver, shots } = driverShowing(WHITE);
  const result = await run(driver, []);
  assert.equal(shots.length, 0);
  assert.equal(result.visual, null, 'no baselines is not the same as everything matched');
});

test('an unchanged page matches and is reported as a match', async () => {
  const { driver, shots } = driverShowing(WHITE);
  const result = await run(driver, [BASELINE]);

  assert.equal(shots.length, 1, 'exactly the step with a baseline was photographed');
  // PNG always: a JPEG baseline would make every comparison fight its own
  // compression artefacts.
  assert.equal(shots[0].type, 'png');
  assert.equal(result.visual.length, 1);
  assert.equal(result.visual[0].status, 'match');
  assert.equal(result.visual[0].step_index, 1);
  assert.equal(result.visual[0].baseline_id, 1);
  assert.equal(result.visual[0].image, null, 'a matching page keeps no image');
});

test('a changed page is reported, keeps the new image, and the run still passes', async () => {
  const { driver } = driverShowing(BLACK);
  const result = await run(driver, [BASELINE]);

  // The promise the whole feature rests on. A moved button is not an outage.
  assert.equal(result.status, 'pass', 'a visual difference must never fail a run');
  assert.equal(result.failure_kind, null);

  const visual = result.visual[0];
  assert.equal(visual.status, 'changed');
  assert.equal(visual.changed_pct, 100);
  // The new picture is kept so a person can look at it and decide. Only when
  // something actually differs — storing an identical image every run is how an
  // artefact store fills a disk.
  assert.ok(Buffer.isBuffer(visual.image));
  assert.match(visual.explanation, /different/);
});

test('a step that FAILED is never photographed', async () => {
  // Photographing a page mid-failure compares the error state against the
  // working one and calls it a visual change — a second wrong answer on top of
  // the real failure.
  const { driver, shots } = driverShowing(BLACK, { present: [], visible: [] });
  const result = await run(driver, [BASELINE]);

  assert.equal(result.status, 'fail');
  assert.equal(shots.length, 0);
  assert.equal(result.visual, null);
});

test('a baseline that cannot be read is said plainly, never reported as a match', async () => {
  // The worst possible failure mode: a step that silently stops being watched.
  const { driver } = driverShowing(WHITE);
  const result = await run(driver, [BASELINE], async () => { throw new Error('ENOENT'); });

  assert.equal(result.status, 'pass');
  assert.equal(result.visual[0].status, 'uncomparable');
  assert.match(result.visual[0].reason, /baseline image could not be read/);
});

test('a screenshot that cannot be taken is reported, and the run is untouched', async () => {
  const base = makeFakeDriver({ present: ['Welcome'], visible: ['Welcome'] });
  const driver = { ...base, screenshot: async () => { throw new Error('page closed'); } };
  const result = await run(driver, [BASELINE]);

  assert.equal(result.status, 'pass');
  assert.equal(result.visual[0].status, 'uncomparable');
  assert.match(result.visual[0].reason, /screenshot could not be taken/);
});

test('a driver with no screenshot support simply compares nothing', async () => {
  // An older worker against a newer test. It must not crash and must not claim
  // the page matched.
  const base = makeFakeDriver({ present: ['Welcome'], visible: ['Welcome'] });
  delete base.screenshot;
  const result = await run(base, [BASELINE]);
  assert.equal(result.status, 'pass');
  assert.equal(result.visual, null);
});

test('the baseline\'s own tolerance and ignore regions are honoured', async () => {
  const { driver } = driverShowing(BLACK);
  // The whole frame marked as "this moves" — so nothing is left to compare and
  // the page matches.
  const ignored = await run(driver, [{ ...BASELINE, ignore_regions: [{ x: 0, y: 0, width: 40, height: 40 }] }]);
  assert.equal(ignored.visual[0].status, 'match');
  assert.equal(ignored.visual[0].ignored_pixels, 1600);

  // And a threshold nothing can exceed.
  const lenient = await run(driver, [{ ...BASELINE, threshold_pct: 100 }]);
  assert.equal(lenient.visual[0].status, 'match');
});

test('a differently-sized page is resized, not a percentage, and keeps the image', async () => {
  const { driver } = driverShowing(png(40, 60, () => [255, 255, 255, 255]));
  const result = await run(driver, [BASELINE]);
  const visual = result.visual[0];
  assert.equal(visual.status, 'resized');
  assert.equal(visual.changed_pct, 0);
  assert.ok(Buffer.isBuffer(visual.image), 'a resized page is worth looking at too');
});

test('the comparison cannot move anything the run concluded', async () => {
  const { driver: plain } = driverShowing(WHITE);
  const before = await run(plain, []);
  const { driver: photographed } = driverShowing(BLACK);
  const after = await run(photographed, [BASELINE]);

  // If the comparison could move any of these, it could move what wakes
  // somebody up at three in the morning.
  for (const key of ['status', 'failed_step', 'error_message', 'failure_kind']) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(after.steps.length, before.steps.length);
  assert.deepEqual(after.steps.map((s) => s.status), before.steps.map((s) => s.status));
});
