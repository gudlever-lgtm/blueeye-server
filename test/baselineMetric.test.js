'use strict';

// Tests for the shared "metric with baseline context" component
// (public/baselineMetric.js).
//
// The four cases the feature is specified against:
//   1. renders with a baseline
//   2. renders WITHOUT a baseline — and emits no secondary field at all
//   3. baseline = 0 is handled without dividing by zero
//   4. a negative deviation (below normal) renders correctly
//
// Pure logic is tested directly; rendering is tested under jsdom, matching how
// timelineView/clusterView are covered.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const BM = require('../public/baselineMetric');
const I18n = require('../public/i18n');

// The component reads strings through window.I18n; in node there is no window,
// so it falls back to returning the key. Point it at the real catalogue so the
// rendered text is what a user would actually see.
global.window = global.window || {};
global.window.I18n = I18n;
I18n.setLocale('en');

const doc = () => new JSDOM('<!doctype html><body></body>').window.document;

// A Tuesday 14:00 UTC baseline slot.
const TUESDAY_14 = { dow: 2, hour: 14 };
const baseline = (over) => Object.assign({
  median: 100, mad: 10, sampleCount: 40, observationCount: 500,
  updatedAt: '2026-07-28T12:00:00.000Z',
}, TUESDAY_14, over);

// ---------------------------------------------------------------- compare()
test('compare reports the deviation above normal', () => {
  const cmp = BM.compare(320, baseline());
  assert.equal(cmp.direction, 'above');
  assert.equal(Math.round(cmp.pct), 220);
  assert.equal(cmp.absolute, 220);
  assert.equal(cmp.comparable, true);
});

test('compare reports a NEGATIVE deviation as below normal', () => {
  const cmp = BM.compare(40, baseline());
  assert.equal(cmp.direction, 'below');
  assert.equal(Math.round(cmp.pct), -60);
  assert.equal(cmp.absolute, -60);
});

test('compare calls a small wobble normal rather than a deviation', () => {
  // Calling a 1% wobble "above normal" trains people to ignore the line.
  assert.equal(BM.compare(101, baseline()).direction, 'at');
  assert.equal(BM.compare(99, baseline()).direction, 'at');
  assert.equal(BM.compare(100, baseline()).direction, 'at');
  // ...but the threshold itself does register.
  assert.equal(BM.compare(105, baseline()).direction, 'above');
  assert.equal(BM.compare(95, baseline()).direction, 'below');
});

test('compare returns null when there is no baseline', () => {
  assert.equal(BM.compare(300, null), null);
  assert.equal(BM.compare(300, undefined), null);
  assert.equal(BM.compare(300, {}), null);
  assert.equal(BM.compare(300, { median: null }), null);
  assert.equal(BM.compare(300, { median: 'lots' }), null);
});

test('compare returns null for a non-numeric value', () => {
  assert.equal(BM.compare(null, baseline()), null);
  assert.equal(BM.compare(undefined, baseline()), null);
  assert.equal(BM.compare('300', baseline()), null);
  assert.equal(BM.compare(NaN, baseline()), null);
  assert.equal(BM.compare(Infinity, baseline()), null);
});

// -------------------------------------------------------- baseline = 0
test('a baseline of 0 never divides by zero', () => {
  const cmp = BM.compare(500, baseline({ median: 0 }));
  assert.equal(cmp.comparable, false, 'a percentage of zero is meaningless');
  assert.equal(cmp.pct, null, 'no Infinity, no NaN');
  assert.equal(cmp.absolute, 500);
  assert.equal(cmp.direction, 'above');
});

test('a baseline of 0 with a value of 0 reads as normal', () => {
  const cmp = BM.compare(0, baseline({ median: 0 }));
  assert.equal(cmp.direction, 'at');
  assert.equal(cmp.pct, null);
  assert.equal(cmp.absolute, 0);
});

test('a rendered baseline-of-0 comparison contains no NaN or Infinity in its text', () => {
  const node = BM.render(doc(), { value: 500, formatted: '500 MB', baseline: baseline({ median: 0 }) });
  const ctx = node.querySelector('.bm-context');
  assert.ok(ctx, 'a baseline exists, so context is rendered');
  assert.ok(!/NaN/.test(ctx.textContent), ctx.textContent);
  assert.ok(!/-?Infinity/.test(ctx.textContent), ctx.textContent);
});

// ------------------------------------------------------------------ describe()
test('describe phrases the deviation with the weekday and hour of the slot', () => {
  const d = BM.describe(320, baseline());
  assert.equal(d.direction, 'above');
  assert.match(d.text, /220%/);
  assert.match(d.text, /Tuesday/);
  assert.match(d.text, /14:00/);
});

test('describe phrases a below-normal deviation without a minus sign in the number', () => {
  // "60% below normal" reads correctly; "-60% below normal" reads as a double
  // negative.
  const d = BM.describe(40, baseline());
  assert.equal(d.direction, 'below');
  assert.match(d.text, /60% below normal/);
  assert.ok(!/-60/.test(d.text), d.text);
});

test('describe uses the slot recorded on the baseline, not the current time', () => {
  // The number came from the Tuesday-14:00 bucket; the sentence must say so even
  // if it is read on a Friday.
  const now = new Date('2026-07-31T09:00:00Z'); // a Friday
  const d = BM.describe(320, baseline(), now);
  assert.match(d.text, /Tuesday/);
  assert.match(d.text, /14:00/);
});

test('describe falls back to now when the baseline carries no slot', () => {
  const now = new Date('2026-07-28T14:00:00Z'); // a Tuesday
  const d = BM.describe(320, { median: 100 }, now);
  assert.match(d.text, /Tuesday/);
  assert.match(d.text, /14:00/);
});

test('describe returns null when there is nothing to say', () => {
  assert.equal(BM.describe(300, null), null);
  assert.equal(BM.describe(null, baseline()), null);
});

// ------------------------------------------------------------------- ageTitle
test('ageTitle reports how much data the baseline rests on', () => {
  // Three days of data is not the same claim as three months, and the person
  // deciding whether to act needs to know which.
  const title = BM.ageTitle(baseline({ observationCount: 900 }));
  assert.match(title, /900 observations/);
  assert.match(title, /2026-07-28/);
});

test('ageTitle hedges a thin baseline', () => {
  const title = BM.ageTitle(baseline({ observationCount: 12 }));
  assert.match(title, /still building/);
  assert.match(title, /12/);
});

test('ageTitle returns null when the baseline carries no counts', () => {
  assert.equal(BM.ageTitle({ median: 100 }), null);
  assert.equal(BM.ageTitle(null), null);
});

// --------------------------------------------------------------------- render
test('render emits the value and the context line when a baseline exists', () => {
  const node = BM.render(doc(), { value: 320, formatted: '320 Mbit/s', baseline: baseline() });

  assert.equal(node.querySelector('.bm-value').textContent, '320 Mbit/s');
  const ctx = node.querySelector('.bm-context');
  assert.ok(ctx);
  assert.match(ctx.textContent, /220% above normal for a Tuesday at 14:00/);
  assert.ok(ctx.classList.contains('bm-above'));
  assert.match(ctx.getAttribute('title'), /500 observations/);
});

test('render emits NO secondary element at all when there is no baseline', () => {
  // The rule: no placeholder, no "–", nothing. An empty space says "we do not
  // know"; a placeholder invites the reader to think something was measured.
  for (const baselineValue of [null, undefined, {}]) {
    const node = BM.render(doc(), { value: 320, formatted: '320 Mbit/s', baseline: baselineValue });
    assert.equal(node.querySelector('.bm-value').textContent, '320 Mbit/s');
    assert.equal(node.querySelector('.bm-context'), null, 'no context element may exist');
    assert.equal(node.children.length, 1, 'exactly one child: the value');
    assert.ok(!/–|-|normal/.test(node.textContent.replace('320 Mbit/s', '')), 'no leftover placeholder text');
  }
});

test('render emits a below-normal context with its own class', () => {
  const node = BM.render(doc(), { value: 40, formatted: '40 MB', baseline: baseline() });
  const ctx = node.querySelector('.bm-context');
  assert.ok(ctx.classList.contains('bm-below'));
  assert.match(ctx.textContent, /below normal/);
});

test('render marks an unremarkable value as normal rather than omitting the line', () => {
  // "We checked, it is normal" is information; silence would be indistinguishable
  // from "we have no baseline".
  const node = BM.render(doc(), { value: 101, formatted: '101 MB', baseline: baseline() });
  const ctx = node.querySelector('.bm-context');
  assert.ok(ctx);
  assert.ok(ctx.classList.contains('bm-at'));
  assert.match(ctx.textContent, /Normal for a Tuesday/);
});

test('render falls back to the raw value when no formatted string is given', () => {
  assert.equal(BM.render(doc(), { value: 42 }).querySelector('.bm-value').textContent, '42');
  assert.equal(BM.render(doc(), {}).querySelector('.bm-value').textContent, '–');
});

test('a provider that throws costs the context, never the value', () => {
  const provider = { name: 'broken', lookup: () => { throw new Error('lookup failed'); } };
  const node = BM.render(doc(), { value: 320, formatted: '320 MB', provider, metric: {} });

  assert.equal(node.querySelector('.bm-value').textContent, '320 MB');
  assert.equal(node.querySelector('.bm-context'), null);
});

// ------------------------------------------------------------------- provider
test('flowPairProvider resolves a baseline by (dst, port, dow, hour)', () => {
  const provider = BM.flowPairProvider([
    { dstHostId: 9, dstPort: 443, dow: 2, hour: 14, medianBytes: 1000, madBytes: 100, sampleCount: 40, observationCount: 500, updatedAt: '2026-07-28T12:00:00.000Z' },
  ]);

  const hit = provider.lookup({ dstHostId: 9, dstPort: 443, dow: 2, hour: 14 });
  assert.equal(hit.median, 1000);
  assert.equal(hit.observationCount, 500);
});

test('flowPairProvider returns null for a slot it has no baseline for', () => {
  // It must not borrow another slot's number — that would be inventing context.
  const provider = BM.flowPairProvider([
    { dstHostId: 9, dstPort: 443, dow: 2, hour: 14, medianBytes: 1000 },
  ]);
  assert.equal(provider.lookup({ dstHostId: 9, dstPort: 443, dow: 2, hour: 15 }), null);
  assert.equal(provider.lookup({ dstHostId: 9, dstPort: 80, dow: 2, hour: 14 }), null);
  assert.equal(provider.lookup(null), null);
});

test('flowPairProvider handles an empty or missing row set', () => {
  // A fresh install has no baselines for ~14 days (history builds forward).
  for (const rows of [[], null, undefined]) {
    const provider = BM.flowPairProvider(rows);
    assert.equal(provider.lookup({ dstHostId: 1, dstPort: 1, dow: 0, hour: 0 }), null);
  }
});

test('render through a provider produces the same result as an explicit baseline', () => {
  const rows = [{ dstHostId: 9, dstPort: 443, dow: 2, hour: 14, medianBytes: 100, observationCount: 500, updatedAt: '2026-07-28T12:00:00.000Z' }];
  const viaProvider = BM.render(doc(), {
    value: 320, formatted: '320 MB',
    provider: BM.flowPairProvider(rows),
    metric: { dstHostId: 9, dstPort: 443, dow: 2, hour: 14 },
  });
  const explicit = BM.render(doc(), { value: 320, formatted: '320 MB', baseline: baseline() });

  assert.equal(
    viaProvider.querySelector('.bm-context').textContent,
    explicit.querySelector('.bm-context').textContent
  );
});

// ---------------------------------------------------------------- translation
test('the context line is translated, not hardcoded', () => {
  I18n.setLocale('da');
  try {
    const node = BM.render(doc(), { value: 320, formatted: '320 MB', baseline: baseline() });
    assert.match(node.querySelector('.bm-context').textContent, /over normal for en tirsdag/i);
  } finally {
    I18n.setLocale('en');
  }
});
