'use strict';

// GATE · i18n RATCHET
//
// CLAUDE.md's rule is "the pre-existing screens are still hardcoded English and
// migrate opportunistically; don't add new hardcoded strings". The first half
// is a deliberate, sensible choice. The second half had nothing enforcing it,
// and nothing counted what was left — so "opportunistically" could mean the
// backlog grew and nobody would know.
//
// This counts it. The numbers below are a CEILING, not a target:
//
//   * add a hardcoded sentence and the count goes up and the gate fails,
//     naming the file. That is the "don't add new ones" half, enforced.
//   * migrate some to t() and the count goes DOWN, which also fails — with an
//     instruction to lower the ceiling in this file. That is deliberate: it
//     makes the ratchet tighten on every migration instead of drifting, and it
//     turns "we reduced the backlog" into a number in the diff.
//
// A file at 0 is finished and should stay that way, which is why
// serviceAssurance.js is pinned at 0 rather than left out: it proves the whole
// dashboard CAN be written this way, and stops it regressing.
//
// What counts as a finding: a quoted sentence — starts with a capital, has
// spaces, long enough to be prose rather than a class name, CSS value or key —
// passed as an argument. It is a heuristic, not a parser, and it does not need
// to be perfect: it needs to be STABLE, so that a change in the number means a
// change in the code.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

// file -> how many hardcoded user-facing sentences it may still contain.
// Only ever edit these DOWNWARD, in the same commit that does the migrating.
const CEILING = {
  'app.js': 618,
  'guides.js': 0,
  'serviceAssurance.js': 0,
  // The kitchen sink's are sample DATA inside a component demo, not product
  // copy — a fixture is allowed to be English. Pinned so it cannot grow.
  'kitchenSink.js': 3,
  'about.js': 0,
  'recorder.js': 0,
  'clusterView.js': 7,
  'timelineView.js': 0,
  'troubleshootingView.js': 0,
  'topologyGraph.js': 0,
  'baselineMetric.js': 0,
  'fleetFilter.js': 0,
  'deltaView.js': 0,
  'eventTitle.js': 0,
  'ui.js': 0,
  // Section bodies built through t() from the start.
  'thresholdsPanel.js': 0,
  'slaReports.js': 0,
  'nis2Evidence.js': 0,
};

// A quoted string that reads like a sentence shown to a person.
const SENTENCE = /,\s*'([A-Z][a-z][^']{12,})'/g;

// Lines that are never UI text, however they read.
const IGNORE_LINE = /\bt\(|data-i18n|console\.|require\(|recordClientLog|\/\/ /;

function countIn(file) {
  const lines = fs.readFileSync(path.join(PUBLIC, file), 'utf8').split('\n');
  let n = 0;
  const samples = [];
  lines.forEach((line, i) => {
    if (IGNORE_LINE.test(line)) return;
    SENTENCE.lastIndex = 0;
    let m;
    while ((m = SENTENCE.exec(line))) {
      n += 1;
      if (samples.length < 5) samples.push(`${file}:${i + 1}  "${m[1].slice(0, 60)}"`);
    }
  });
  return { n, samples };
}

for (const [file, ceiling] of Object.entries(CEILING)) {
  test(`i18n ratchet: public/${file} has at most ${ceiling} hardcoded sentence(s)`, () => {
    const full = path.join(PUBLIC, file);
    if (!fs.existsSync(full)) return; // a deleted file is not a regression
    const { n, samples } = countIn(file);

    assert.ok(
      n <= ceiling,
      `public/${file} now has ${n} hardcoded user-facing string(s), ceiling is ${ceiling}.\n` +
      'New UI text goes through t() with a key in BOTH catalogues (public/i18n.js).\n' +
      `Examples:\n  ${samples.join('\n  ')}`
    );

    assert.equal(
      n, ceiling,
      `public/${file} is down to ${n} hardcoded string(s) from ${ceiling} — nice.\n` +
      `Lower CEILING['${file}'] to ${n} in test/gate/i18nRatchet.test.js so it cannot creep back up.`
    );
  });
}

// The whole-dashboard number, so the trend is one line in the diff rather than
// something you have to add up across fifteen assertions.
test('i18n ratchet: the dashboard-wide backlog does not grow', () => {
  const total = Object.keys(CEILING)
    .filter((f) => fs.existsSync(path.join(PUBLIC, f)))
    .reduce((sum, f) => sum + countIn(f).n, 0);
  const ceiling = Object.values(CEILING).reduce((a, b) => a + b, 0);
  assert.equal(
    total, ceiling,
    `The dashboard has ${total} hardcoded user-facing string(s); the pinned total is ${ceiling}.\n` +
    'Up = new untranslated text. Down = migration done, so lower the per-file ceilings.'
  );
});
