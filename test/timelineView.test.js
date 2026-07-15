'use strict';

// Unit tests for the pure timeline view-logic (public/timelineView.js). The
// dashboard has no build step / browser test harness, so the renderer's DOM
// isn't exercised here — but the state selection, row mapping and range→window
// maths (the parts that decide populated/empty/error/partial) ARE.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const TV = require('../public/timelineView');

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

test('sourceLabel covers all four sources + fallback', () => {
  assert.equal(TV.sourceLabel('finding'), 'Finding');
  assert.equal(TV.sourceLabel('incident'), 'Incident');
  assert.equal(TV.sourceLabel('playbook'), 'Playbook');
  assert.equal(TV.sourceLabel('mystery'), 'mystery');
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
