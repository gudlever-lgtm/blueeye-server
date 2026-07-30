'use strict';

// Unit tests for the pure timeline view-logic (public/timelineView.js). The
// dashboard has no build step / browser test harness, so the renderer's DOM
// isn't exercised here — but the state selection, row mapping and range→window
// maths (the parts that decide populated/empty/error/partial) ARE.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { JSDOM } = require('jsdom');

const TV = require('../public/timelineView');

function newDoc() { return new JSDOM('<!doctype html><body></body>').window.document; }
function click(node, doc) { node.dispatchEvent(new doc.defaultView.Event('click')); }

// ---- resolveState: populated / empty / error / partial --------------------

test('resolveState → loading', () => {
  assert.equal(TV.resolveState({ loading: true }).state, 'loading');
});

test('resolveState → error carries the message', () => {
  const s = TV.resolveState({ error: { message: 'boom' } });
  assert.equal(s.state, 'error');
  assert.equal(s.message, 'boom');
});

test('resolveState → empty for [] (NOT an error)', () => {
  const s = TV.resolveState({ data: { events: [], partial: false, failedSources: [] } });
  assert.equal(s.state, 'empty');
  assert.equal(s.partial, false);
});

test('resolveState → ready with events', () => {
  const s = TV.resolveState({ data: { events: [{ timestamp: 't', source: 'finding' }] } });
  assert.equal(s.state, 'ready');
  assert.equal(s.events.length, 1);
});

test('resolveState → surfaces partial + failedSources (empty AND ready)', () => {
  const empty = TV.resolveState({ data: { events: [], partial: true, failedSources: ['findings'] } });
  assert.equal(empty.state, 'empty');
  assert.equal(empty.partial, true);
  assert.deepEqual(empty.failedSources, ['findings']);

  const ready = TV.resolveState({ data: { events: [{ timestamp: 't' }], partial: true, failedSources: ['incidents'] } });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.partial, true);
  assert.deepEqual(ready.failedSources, ['incidents']);
});

// ---- rowModel + severity/source mapping -----------------------------------

test('rowModel maps a normalised event to a row', () => {
  const r = TV.rowModel({ timestamp: '2026-06-01T09:00:00Z', source: 'agent', type: 'agent.offline', severity: 'WARN', summary: 'Agent disconnected', ref_id: 11 });
  assert.equal(r.time, '2026-06-01T09:00:00Z');
  assert.equal(r.sourceLabel, 'Agent');
  assert.equal(r.severity, 'WARN');
  assert.equal(r.summary, 'Agent disconnected');
  assert.equal(r.refId, 11);
});

test('severityClass normalises/falls back to INFO', () => {
  assert.equal(TV.severityClass('crit'), 'CRIT');
  assert.equal(TV.severityClass('warning'), 'INFO'); // already-normalised vocab only; unknown → INFO
  assert.equal(TV.severityClass(undefined), 'INFO');
  assert.equal(TV.severityClass('WARN'), 'WARN');
});

test('sourceLabel covers every source the feeds emit + fallback', () => {
  assert.equal(TV.sourceLabel('finding'), 'Finding');
  assert.equal(TV.sourceLabel('playbook'), 'Playbook');
  assert.equal(TV.sourceLabel('mystery'), 'mystery');
  // The operator-facing unit is an EVENT; `probe` is the active-probe outage and
  // `cluster` is a Situation. Two records that used to share the label "Incident".
  assert.equal(TV.sourceLabel('event'), 'Event');
  assert.equal(TV.sourceLabel('probe'), 'Probe outage');
  assert.equal(TV.sourceLabel('cluster'), 'Situation');
  // Legacy keys still resolve, so a cached payload never renders a table name.
  assert.equal(TV.sourceLabel('incident_case'), 'Event');
  assert.equal(TV.sourceLabel('incident'), 'Event');
});

// A missing SOURCE_LABELS entry is how `incident_case` ended up printed verbatim
// on the changes feed. Every source any mapper emits must have a label.
test('every source the change feed emits has a human label', () => {
  const emitted = ['finding', 'event', 'probe', 'cluster', 'agent', 'interface', 'topology', 'playbook', 'config'];
  for (const s of emitted) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(TV.SOURCE_LABELS, s),
      `source "${s}" has no label and would render as a raw key`
    );
  }
});

// ---- type chip -------------------------------------------------------------

test('the type chip drops the source prefix and hides what the summary already says', () => {
  // The bug this fixes: "finding.probe.latency" rendered next to
  // "probe.latency on core-sw", with no separator, as one run-together word.
  const m = TV.rowModel({
    source: 'finding', type: 'finding.probe.latency', summary: 'probe.latency on core-sw', severity: 'CRIT',
  });
  assert.equal(m.typeDetail, 'probe.latency', 'the source prefix is already on the source chip');
  assert.equal(m.showType, false, 'the summary spells it out — the chip would be pure duplication');

  // A status the summary does NOT carry is worth showing.
  const ev = TV.rowModel({ source: 'event', type: 'event.investigating', summary: 'CRIT latency on core-sw' });
  assert.equal(ev.typeDetail, 'investigating');
  assert.equal(ev.showType, true);
});

test('rowModel surfaces the correlation fields, defaulted for uncorrelated rows', () => {
  const plain = TV.rowModel({ source: 'event', type: 'event.open', summary: 'x' });
  assert.equal(plain.count, 1);
  assert.equal(plain.findingCount, 0);
  assert.equal(plain.family, null);

  const folded = TV.rowModel({
    source: 'event', type: 'event.open', summary: 'x',
    count: 7, findingCount: 12, family: 'latency', firstAt: '2026-07-30T07:15:00.000Z',
  });
  assert.equal(folded.count, 7);
  assert.equal(folded.findingCount, 12);
  assert.equal(folded.family, 'latency');
  assert.equal(folded.firstAt, '2026-07-30T07:15:00.000Z');
});

// ---- rangeToWindow / timelineQuery ----------------------------------------

test('rangeToWindow computes preset windows ending at now', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  const w1h = TV.rangeToWindow('1h', now);
  assert.equal(w1h.to, '2026-06-01T12:00:00.000Z');
  assert.equal(w1h.from, '2026-06-01T11:00:00.000Z');
  const w7d = TV.rangeToWindow('7d', now);
  assert.equal(w7d.from, '2026-05-25T12:00:00.000Z');
});

test('rangeToWindow custom: valid range, and null on invalid/incomplete', () => {
  const ok = TV.rangeToWindow('custom', 0, '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z');
  assert.equal(ok.from, '2026-06-01T00:00:00.000Z');
  assert.equal(TV.rangeToWindow('custom', 0, '2026-06-01T00:00:00Z', null), null); // incomplete
  assert.equal(TV.rangeToWindow('custom', 0, '2026-06-02T00:00:00Z', '2026-06-01T00:00:00Z'), null); // from > to
  assert.equal(TV.rangeToWindow('custom', 0, 'nonsense', '2026-06-01T00:00:00Z'), null); // invalid date
});

test('unknown preset key falls back to the 24h window', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  const w = TV.rangeToWindow('bogus', now);
  assert.equal(w.from, '2026-05-31T12:00:00.000Z');
});

test('timelineQuery builds from/to/limit', () => {
  const q = TV.timelineQuery({ from: '2026-06-01T00:00:00.000Z', to: '2026-06-02T00:00:00.000Z' }, 500);
  assert.match(q, /^\?from=.*&to=.*&limit=500$/);
  assert.equal(TV.timelineQuery(null, null), '');
});

// ---- deepLink -------------------------------------------------------------

test('deepLink targets the agent detail view, carrying source + refId', () => {
  const d = TV.deepLink({ source: 'finding', ref_id: 'f-1' }, 9);
  assert.deepEqual(d, { view: 'agent', id: 9, source: 'finding', refId: 'f-1' });
  assert.equal(TV.deepLink({}, null), null);
});

// ---- partialNotice --------------------------------------------------------

test('partialNotice names the failed sources and is never empty', () => {
  assert.match(TV.partialNotice(['findings', 'incidents']), /findings, incidents/);
  assert.match(TV.partialNotice([]), /some sources/);
});

// ---- render layer (jsdom): the actual DOM, not just the logic --------------

test('renderInto: populated → one row per event with severity/source badges', () => {
  const doc = newDoc();
  const c = doc.createElement('div');
  const view = TV.resolveState({ data: { events: [
    { timestamp: '2026-06-01T09:00:00Z', source: 'agent', type: 'agent.offline', severity: 'WARN', summary: 'Agent disconnected', ref_id: 11 },
    { timestamp: '2026-06-01T08:00:00Z', source: 'finding', type: 'cpu', severity: 'CRIT', summary: 'CPU spike', ref_id: 'f1' },
  ] } });
  TV.renderInto(doc, c, view, {});
  const lis = c.querySelectorAll('ul.timeline > li.tl');
  assert.equal(lis.length, 2);
  assert.ok(lis[0].querySelector('.badge.WARN'));
  assert.ok(lis[0].querySelector('.badge.tl-src'));
  assert.match(lis[0].textContent, /Agent disconnected/);
  assert.ok(lis[1].querySelector('.badge.CRIT'));
});

test('renderInto: empty → empty text, no rows, not an error', () => {
  const doc = newDoc();
  const c = doc.createElement('div');
  TV.renderInto(doc, c, TV.resolveState({ data: { events: [] } }), { emptyText: 'No changes detected in this window.' });
  assert.equal(c.querySelectorAll('li').length, 0);
  assert.equal(c.querySelector('.error'), null);
  assert.match(c.textContent, /No changes detected in this window\./);
});

test('renderInto: error → message + Retry that fires onRetry', () => {
  const doc = newDoc();
  const c = doc.createElement('div');
  let retried = 0;
  TV.renderInto(doc, c, TV.resolveState({ error: { message: 'endpoint exploded' } }), { onRetry: () => { retried += 1; } });
  assert.match(c.querySelector('.error').textContent, /endpoint exploded/);
  const btn = c.querySelector('button');
  assert.ok(btn, 'retry button present');
  click(btn, doc);
  assert.equal(retried, 1);
});

test('renderInto: partial → visible notice AND the rows (never hidden)', () => {
  const doc = newDoc();
  const c = doc.createElement('div');
  const view = TV.resolveState({ data: { events: [{ timestamp: 't', source: 'agent', type: 'agent.online', severity: 'INFO', summary: 'up', ref_id: 1 }], partial: true, failedSources: ['findings'] } });
  TV.renderInto(doc, c, view, {});
  assert.ok(c.querySelector('.tl-partial'), 'partial notice shown');
  assert.match(c.querySelector('.tl-partial').textContent, /findings/);
  assert.equal(c.querySelectorAll('li.tl').length, 1);
});

test('renderInto replaces prior contents on re-render (loading → ready)', () => {
  const doc = newDoc();
  const c = doc.createElement('div');
  TV.renderInto(doc, c, TV.resolveState({ loading: true }), {});
  assert.match(c.textContent, /Loading/);
  TV.renderInto(doc, c, TV.resolveState({ data: { events: [{ timestamp: 't', source: 'agent', type: 'agent.online', severity: 'INFO', summary: 'up', ref_id: 1 }] } }), {});
  assert.equal(c.querySelectorAll('li.tl').length, 1);
  assert.doesNotMatch(c.textContent, /Loading/);
});

test('renderRow: clickable + deep-links via onOpen when agentId is given', () => {
  const doc = newDoc();
  let opened = null;
  const li = TV.renderRow(doc, { timestamp: 't', source: 'finding', type: 'cpu', severity: 'INFO', summary: 'x', ref_id: 'f1' }, { agentId: 9, onOpen: (id) => { opened = id; } });
  assert.ok(li.classList.contains('clickable'));
  assert.match(li.title, /Open device.*#f1/);
  click(li, doc);
  assert.equal(opened, 9);
});

test('renderRow: not clickable without agentId', () => {
  const doc = newDoc();
  const li = TV.renderRow(doc, { timestamp: 't', source: 'finding', type: 'cpu', severity: 'INFO', summary: 'x' }, {});
  assert.ok(!li.classList.contains('clickable'));
});

test('renderRow: applies formatTime to the timestamp', () => {
  const doc = newDoc();
  const li = TV.renderRow(doc, { timestamp: '2026-06-01T09:00:00Z', source: 'agent', type: 'agent.online', severity: 'INFO', summary: 'x' }, { formatTime: () => 'FORMATTED' });
  assert.match(li.querySelector('.tl-time').textContent, /FORMATTED/);
});

test('renderRow: the same metric is never printed twice on one row', () => {
  // The bug from the field: a CRIT row read
  //   "finding.probe.latencyprobe.latency on Fellis Agent 007"
  // — the dotted type chip, the summary repeating it, and (in the changes feed's
  // <ul>, which never picked up the flex/gap rules) no separator between them.
  const doc = newDoc();
  const li = TV.renderRow(doc, {
    timestamp: 't', source: 'finding', type: 'finding.probe.latency',
    severity: 'CRIT', summary: 'probe.latency on Fellis Agent 007', ref_id: 'f1',
  }, {});

  assert.equal(li.querySelectorAll('.tl-type').length, 0, 'the type chip is dropped when the summary says it');
  const occurrences = li.textContent.split('probe.latency').length - 1;
  assert.equal(occurrences, 1, `the metric appears once, not ${occurrences} times`);
  assert.ok(!li.textContent.includes('finding.probe.latency'), 'and never as a raw dotted key');
});

test('renderRow: an event row is labelled Event, never with a table name', () => {
  const doc = newDoc();
  const li = TV.renderRow(doc, {
    timestamp: 't', source: 'event', type: 'event.open', severity: 'CRIT',
    summary: 'CRIT probe.latency on core-sw (Copenhagen HQ)', ref_id: 3,
  }, {});
  assert.equal(li.querySelector('.tl-src').textContent, 'Event');
  assert.ok(!li.textContent.includes('incident_case'));
  // `open` is a status the summary does not carry, so the chip earns its place —
  // and "Copenhagen" must not suppress it just for containing the letters.
  assert.equal(li.querySelector('.tl-type').textContent, 'open');
});

test('a word inside a site or device name never suppresses the type chip', () => {
  // Matching on bare substrings hid the status chip on every event at a
  // Copenhagen site. Boundaries, not substrings.
  assert.equal(TV.typeIsInformative('event.open', 'event', 'CRIT latency on sw1 (Copenhagen HQ)'), true);
  assert.equal(TV.typeIsInformative('event.open', 'event', 'Event open on sw1'), false);
  // A dotted metric still matches literally (the dot is not a wildcard).
  assert.equal(TV.typeIsInformative('finding.probe.latency', 'finding', 'probe.latency on sw1'), false);
  assert.equal(TV.typeIsInformative('finding.probe.latency', 'finding', 'probeXlatency on sw1'), true);
});

test('renderRow: summary is inert text, not parsed HTML (no injection)', () => {
  const doc = newDoc();
  const li = TV.renderRow(doc, { timestamp: 't', source: 'finding', type: 'cpu', severity: 'INFO', summary: '<img src=x onerror=alert(1)>' }, {});
  assert.equal(li.querySelector('.tl-desc img'), null); // rendered as text, no <img> element created
  assert.match(li.querySelector('.tl-desc').textContent, /<img/);
});
