'use strict';

// Unit tests for the pure fleet-Overview filter logic (public/fleetFilter.js).
// The dashboard has no build step / browser test harness, so the DOM rendering
// isn't exercised here — but the parts that decide what a shared deep-link
// filters to (URL parse/serialise, AND-combination across dimensions, the
// severity→status mapping, chips and the health-score sort) ARE.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const FF = require('../public/fleetFilter');

// A minimal agent shape (only the fields the filter reads).
function agent(over) {
  return Object.assign({
    agentId: 1, online: true, locationId: null, locationName: null,
    health: { status: 'ok', metrics: {} },
  }, over);
}
const FLEET = [
  agent({ agentId: 1, health: { status: 'bad', metrics: { lossPct: 40 } }, locationName: 'Vest', online: true }),
  agent({ agentId: 2, health: { status: 'down', metrics: {} }, locationName: 'Vest', online: false }),
  agent({ agentId: 3, health: { status: 'warn', metrics: { latencyZ: 4 } }, locationName: 'Øst' }),
  agent({ agentId: 4, health: { status: 'ok', metrics: {} }, locationName: 'Øst' }),
  agent({ agentId: 5, health: { status: 'unknown', metrics: {} }, locationName: null, online: false }),
];
const ids = (list) => list.map((a) => a.agentId);

// ---- empty / active state --------------------------------------------------

test('emptyState is the documented shape and matches everything', () => {
  const s = FF.emptyState();
  assert.deepEqual(s, { severity: [], site: null, healthBelow: null, offline: false });
  assert.equal(FF.isActive(s), false);
  assert.deepEqual(ids(FF.applyFilter(FLEET, s)), [1, 2, 3, 4, 5]);
});

// ---- URL parse (deep-link) -------------------------------------------------

test('parseQuery reads severity/site/offline/healthBelow (with or without ?)', () => {
  const s = FF.parseQuery('?severity=CRIT,WARN&site=vest&offline=1&healthBelow=50');
  assert.deepEqual(s.severity, ['CRIT', 'WARN']);
  assert.equal(s.site, 'vest');
  assert.equal(s.offline, true);
  assert.equal(s.healthBelow, 50);
  assert.equal(FF.parseQuery('severity=CRIT').severity[0], 'CRIT'); // no leading '?'
});

test('parseQuery is forgiving: unknown severity ⇒ empty filter, not an error', () => {
  assert.deepEqual(FF.parseQuery('?severity=BOGUS').severity, []);
  assert.deepEqual(FF.parseQuery('?severity=').severity, []);
  assert.deepEqual(FF.parseQuery('').severity, []);
  assert.equal(FF.parseQuery('?healthBelow=notanumber').healthBelow, null);
  assert.equal(FF.parseQuery('?offline=nope').offline, false);
  // A mixed list keeps only the valid tokens, de-duplicated + normalised.
  assert.deepEqual(FF.parseQuery('?severity=warn,BOGUS,CRIT,WARN').severity, ['CRIT', 'WARN']);
});

test('toQuery round-trips a state and emits nothing when inactive', () => {
  assert.equal(FF.toQuery(FF.emptyState()), '');
  const s = { severity: ['WARN', 'CRIT'], site: 'Vest', healthBelow: 20, offline: true };
  const round = FF.parseQuery('?' + FF.toQuery(s));
  assert.deepEqual(round.severity, ['CRIT', 'WARN']); // normalised order
  assert.equal(round.site, 'Vest');
  assert.equal(round.healthBelow, 20);
  assert.equal(round.offline, true);
});

// ---- matching / AND-combination -------------------------------------------

test('severity maps CRIT⇒bad|down, WARN⇒warn (OR within the dimension)', () => {
  assert.deepEqual(ids(FF.applyFilter(FLEET, FF.parseQuery('?severity=CRIT'))), [1, 2]);
  assert.deepEqual(ids(FF.applyFilter(FLEET, FF.parseQuery('?severity=WARN'))), [3]);
  assert.deepEqual(ids(FF.applyFilter(FLEET, FF.parseQuery('?severity=CRIT,WARN'))), [1, 2, 3]);
});

test('filters stack with AND across dimensions', () => {
  // deep-link scenario: ?severity=CRIT&site=vest ⇒ only the CRIT agents at Vest.
  const s = FF.parseQuery('?severity=CRIT&site=vest');
  assert.deepEqual(ids(FF.applyFilter(FLEET, s)), [1, 2]);
  // add offline ⇒ narrows to the offline CRIT agent at Vest.
  assert.deepEqual(ids(FF.applyFilter(FLEET, FF.toggleOffline(s))), [2]);
});

test('site matches by name (case-insensitive) or numeric id', () => {
  const byName = FF.applyFilter(FLEET, { severity: [], site: 'øst', healthBelow: null, offline: false });
  assert.deepEqual(ids(byName), [3, 4]);
  const withId = [agent({ agentId: 9, locationId: 7, locationName: 'HQ' })];
  assert.deepEqual(ids(FF.applyFilter(withId, { severity: [], site: '7', healthBelow: null, offline: false })), [9]);
});

test('offline matches connection state, not the health verdict', () => {
  assert.deepEqual(ids(FF.applyFilter(FLEET, { severity: [], site: null, healthBelow: null, offline: true })), [2, 5]);
});

test('healthBelow keeps agents scoring under the threshold', () => {
  const below = FF.applyFilter(FLEET, { severity: [], site: null, healthBelow: 50, offline: false });
  // bad(≈0), down(8), warn(≈36) all score < 50; ok(100) + unknown(30)… unknown=30<50 too.
  assert.ok(below.every((a) => FF.healthScore(a) < 50));
  assert.ok(!ids(below).includes(4)); // the healthy agent (score 100) is excluded
});

// ---- health score + sort ---------------------------------------------------

test('healthScore orders verdicts worst→best', () => {
  assert.ok(FF.healthScore(agent({ health: { status: 'bad', metrics: {} } }))
    < FF.healthScore(agent({ health: { status: 'warn', metrics: {} } })));
  assert.ok(FF.healthScore(agent({ health: { status: 'warn', metrics: {} } }))
    < FF.healthScore(agent({ health: { status: 'ok', metrics: {} } })));
  assert.equal(FF.healthScore(agent({ health: { status: 'ok', metrics: {} } })), 100);
});

test('sortByHealth returns a worst-first copy without mutating the input', () => {
  const input = FLEET.slice();
  const sorted = FF.sortByHealth(input);
  assert.equal(sorted[0].agentId, 1); // bad + 40% loss is the worst
  assert.equal(sorted[sorted.length - 1].agentId, 4); // healthy is best
  assert.deepEqual(ids(input), [1, 2, 3, 4, 5]); // input untouched
});

// ---- chips + toggles -------------------------------------------------------

test('chips lists one descriptor per active filter with Danish labels', () => {
  const s = { severity: ['CRIT', 'WARN'], site: 'Vest', healthBelow: null, offline: true };
  const cs = FF.chips(s);
  assert.deepEqual(cs.map((c) => c.label), ['Kritiske', 'Advarsler', 'Vest', 'Offline']);
  assert.equal(FF.chips(FF.emptyState()).length, 0);
});

test('removeChip drops exactly one filter; toggles are immutable', () => {
  const s = { severity: ['CRIT', 'WARN'], site: 'Vest', healthBelow: null, offline: true };
  const noCrit = FF.removeChip(s, { kind: 'severity', value: 'CRIT' });
  assert.deepEqual(noCrit.severity, ['WARN']);
  assert.deepEqual(s.severity, ['CRIT', 'WARN']); // original untouched
  assert.equal(FF.removeChip(s, { kind: 'site' }).site, null);
  assert.equal(FF.removeChip(s, { kind: 'offline' }).offline, false);
});

test('toggleSeverity adds then removes; ignores unknown tokens', () => {
  let s = FF.emptyState();
  s = FF.toggleSeverity(s, 'CRIT');
  assert.deepEqual(s.severity, ['CRIT']);
  s = FF.toggleSeverity(s, 'WARN');
  assert.deepEqual(s.severity, ['CRIT', 'WARN']);
  s = FF.toggleSeverity(s, 'CRIT');
  assert.deepEqual(s.severity, ['WARN']);
  s = FF.toggleSeverity(s, 'BOGUS');
  assert.deepEqual(s.severity, ['WARN']); // unchanged
});

test('activeCount counts each set dimension', () => {
  assert.equal(FF.activeCount(FF.emptyState()), 0);
  assert.equal(FF.activeCount({ severity: ['CRIT', 'WARN'], site: 'Vest', healthBelow: 20, offline: true }), 5);
});
