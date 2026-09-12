'use strict';

// Alert correlation: one cause producing three symptoms is one alert.
//
// The specs are weighted towards what must NOT be grouped. Over-grouping is the
// dangerous direction: it hides a real outage inside somebody else's, and
// nobody ever finds out that it did. Under-grouping only sends an extra page.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  groupAlerts, shouldSend, linkBetween, hostOf, endpointsOf, LINK, LAYER_WINDOW_MS,
} = require('../grouping');

const AT = (iso) => new Date(iso);
const BASE_TIME = '2026-09-12T09:00:00Z';

let nextId = 0;
const incident = (over = {}) => ({
  id: (nextId += 1),
  application_id: 1,
  subject_type: 'test',
  subject_key: `test:${nextId}`,
  subject_label: `Journey ${nextId}`,
  kind: 'http_500',
  severity: 'CRIT',
  status: 'open',
  summary: 'is failing',
  evidence: [],
  affected_journeys: [],
  correlated_layer: null,
  opened_at: AT(BASE_TIME),
  ...over,
});

const failedOn = (url) => [`GET ${url} → HTTP 500`];
const deps = (label, count = 3) => ({ failing: [{ label, journey_count: count }] });

// ------------------------------------------------------- the whole point
test('three journeys failing on one shared endpoint is ONE alert', () => {
  // Four incidents and one problem. Sent as four pages at 03:00 it is four
  // phones about one thing, and the fourth teaches whoever is carrying the
  // phone to stop reading them.
  const result = groupAlerts({
    incidents: [
      incident({ subject_label: 'Sign in', evidence: failedOn('https://portal.kunde.dk/api/auth') }),
      incident({ subject_label: 'Find customer', evidence: failedOn('https://portal.kunde.dk/api/auth') }),
      incident({ subject_label: 'Place order', evidence: failedOn('https://portal.kunde.dk/api/auth') }),
    ],
    dependencies: deps('/api/auth'),
  });
  assert.equal(result.alerts, 1);
  assert.equal(result.would_have_been, 3);
  assert.equal(result.folded, 2);
  assert.equal(result.groups[0].linked_by, LINK.DEPENDENCY);
  assert.match(result.groups[0].link_reason, /both failed on \/api\/auth/);
});

test('a symptom folded into a group is still named in it', () => {
  // Nothing is ever suppressed silently. One page instead of four, never three
  // problems nobody was told about.
  const result = groupAlerts({
    incidents: [
      incident({ subject_label: 'Sign in', evidence: failedOn('https://portal.kunde.dk/api/auth') }),
      incident({ subject_label: 'Find customer', evidence: failedOn('https://portal.kunde.dk/api/auth') }),
      incident({ subject_label: 'Place order', evidence: failedOn('https://portal.kunde.dk/api/auth') }),
    ],
    dependencies: deps('/api/auth'),
  });
  const group = result.groups[0];
  assert.equal(group.symptoms.length, 2);
  assert.equal(group.incidents.length, 3, 'every incident is still in the group');
  for (const name of ['Find customer', 'Place order']) {
    assert.match(group.summary, new RegExp(name), `${name} disappeared from the alert`);
  }
  assert.match(group.summary, /3 incidents, one problem/);
});

test('grouping is transitive — A with B and B with C is one problem, not two', () => {
  const result = groupAlerts({
    incidents: [
      incident({ subject_label: 'A', evidence: failedOn('https://x.dk/api/auth') }),
      incident({ subject_label: 'B', evidence: [...failedOn('https://x.dk/api/auth'), ...failedOn('https://x.dk/api/session')] }),
      incident({ subject_label: 'C', evidence: failedOn('https://x.dk/api/session') }),
    ],
    dependencies: { failing: [{ label: '/api/auth' }, { label: '/api/session' }] },
  });
  assert.equal(result.alerts, 1);
  assert.equal(result.groups[0].incidents.length, 3);
});

// --------------------------------------------------- what must NOT group
test('an endpoint that has never failed does not explain anything', () => {
  // A shared endpoint is only a link when it is the one that is FAILING. An
  // endpoint three journeys share and that answers fine explains nothing, and
  // grouping on it would fold two unrelated outages together.
  const result = groupAlerts({
    incidents: [
      incident({ subject_label: 'A', evidence: failedOn('https://x.dk/api/auth') }),
      incident({ subject_label: 'B', evidence: failedOn('https://x.dk/api/auth') }),
    ],
    dependencies: { failing: [], shared: [{ label: '/api/auth' }] },
  });
  assert.equal(result.alerts, 2, 'two unrelated outages were folded into one');
});

test('with nothing known about dependencies, every incident alerts on its own', () => {
  // Rule 4. That is the behaviour without this module at all, and the right
  // thing to fall back to.
  const result = groupAlerts({
    incidents: [incident({ subject_label: 'A' }), incident({ subject_label: 'B' }), incident({ subject_label: 'C' })],
  });
  assert.equal(result.alerts, 3);
  assert.equal(result.folded, 0);
  for (const group of result.groups) {
    assert.equal(group.linked_by, null, 'a group of one has nothing to be linked by');
  }
});

test('the same layer is only a link inside the window', () => {
  // The weakest of the three links, and the only one that needs a window —
  // without it this would group this morning's outage with last night's.
  const near = groupAlerts({
    incidents: [
      incident({ subject_label: 'A', correlated_layer: 'network', opened_at: AT('2026-09-12T09:00:00Z') }),
      incident({ subject_label: 'B', correlated_layer: 'network', opened_at: AT('2026-09-12T09:10:00Z') }),
    ],
  });
  assert.equal(near.alerts, 1);
  assert.equal(near.groups[0].linked_by, LINK.LAYER);

  const far = groupAlerts({
    incidents: [
      incident({ subject_label: 'A', correlated_layer: 'network', opened_at: AT('2026-09-12T09:00:00Z') }),
      incident({ subject_label: 'B', correlated_layer: 'network', opened_at: new Date(AT('2026-09-12T09:00:00Z').getTime() + LAYER_WINDOW_MS + 60000) }),
    ],
  });
  assert.equal(far.alerts, 2, 'last night’s outage was folded into this morning’s');
});

test('a different layer is never a link, however close in time', () => {
  const result = groupAlerts({
    incidents: [
      incident({ subject_label: 'A', correlated_layer: 'network' }),
      incident({ subject_label: 'B', correlated_layer: 'api' }),
    ],
  });
  assert.equal(result.alerts, 2);
});

test('the same host with a DIFFERENT fault is not one problem', () => {
  const result = groupAlerts({
    incidents: [
      incident({ subject_key: 'certificate:portal.kunde.dk:443', kind: 'certificate_expiring' }),
      incident({ subject_key: 'certificate:portal.kunde.dk:443', kind: 'dns_failure' }),
    ],
  });
  assert.equal(result.alerts, 2, 'an expiring certificate and a DNS failure are two problems');
});

test('the same fault on the same host IS one problem', () => {
  const result = groupAlerts({
    incidents: [
      incident({ subject_key: 'certificate:portal.kunde.dk:443', kind: 'certificate_expiring' }),
      incident({ subject_key: 'certificate:portal.kunde.dk:8443', kind: 'certificate_expiring' }),
    ],
  });
  assert.equal(result.alerts, 1);
  assert.equal(result.groups[0].linked_by, LINK.HOST);
  assert.match(result.groups[0].link_reason, /portal\.kunde\.dk/);
});

// ------------------------------------------------------------- severity
test('a group takes the WORST severity in it, not the primary’s', () => {
  // A critical journey failing as a "symptom" of something is still a critical
  // journey failing.
  const result = groupAlerts({
    incidents: [
      incident({ subject_label: 'A', severity: 'WARN', evidence: failedOn('https://x.dk/api/auth') }),
      incident({ subject_label: 'B', severity: 'CRIT', evidence: failedOn('https://x.dk/api/auth') }),
    ],
    dependencies: deps('/api/auth'),
  });
  assert.equal(result.alerts, 1);
  assert.equal(result.groups[0].severity, 'CRIT');
});

test('a group takes the highest criticality of any journey in it', () => {
  const result = groupAlerts({
    incidents: [
      incident({ subject_label: 'A', evidence: failedOn('https://x.dk/api/auth'), affected_journeys: [{ id: 1, criticality: 'low' }] }),
      incident({ subject_label: 'B', evidence: failedOn('https://x.dk/api/auth'), affected_journeys: [{ id: 2, criticality: 'critical' }] }),
    ],
    dependencies: deps('/api/auth'),
  });
  assert.equal(result.groups[0].criticality, 'critical');
});

test('the worst group is first, so the biggest thing on fire is at the top', () => {
  const result = groupAlerts({
    incidents: [
      incident({ subject_label: 'Quiet', severity: 'INFO' }),
      incident({ subject_label: 'Loud', severity: 'CRIT' }),
      incident({ subject_label: 'Middling', severity: 'WARN' }),
    ],
  });
  assert.deepEqual(result.groups.map((g) => g.severity), ['CRIT', 'WARN', 'INFO']);
});

test('the same incidents always produce the same group key', () => {
  // A cooldown is kept against the key. One that changed with arrival order
  // would mean the same alert going out repeatedly under different names.
  const a = incident({ id: 7, subject_label: 'A', evidence: failedOn('https://x.dk/api/auth') });
  const b = incident({ id: 3, subject_label: 'B', evidence: failedOn('https://x.dk/api/auth') });
  const first = groupAlerts({ incidents: [a, b], dependencies: deps('/api/auth') }).groups[0].key;
  const second = groupAlerts({ incidents: [b, a], dependencies: deps('/api/auth') }).groups[0].key;
  assert.equal(first, second);
});

// -------------------------------------------------------------- cooldown
test('nothing sent yet always sends', () => {
  const group = { severity: 'CRIT', incidents: [{}] };
  const decision = shouldSend(group, { lastSent: null });
  assert.equal(decision.send, true);
  assert.match(decision.reason, /nothing has been sent/);
});

test('the same alert again inside the cooldown is held, with a reason', () => {
  // "Why did I not get paged" has to have an answer.
  const group = { severity: 'CRIT', incidents: [{}] };
  const decision = shouldSend(group, {
    lastSent: { severity: 'CRIT', incident_count: 1, at: new Date(Date.now() - 60000) },
    cooldownMs: 15 * 60000,
  });
  assert.equal(decision.send, false);
  assert.match(decision.reason, /1 minutes ago and nothing has changed/);
});

test('an escalation always goes through, cooldown or not', () => {
  // A WARN that has become a CRIT is new information, and holding it is the one
  // case where silence costs something.
  const decision = shouldSend({ severity: 'CRIT', incidents: [{}] }, {
    lastSent: { severity: 'WARN', incident_count: 1, at: new Date(Date.now() - 30000) },
    cooldownMs: 60 * 60000,
  });
  assert.equal(decision.send, true);
  assert.match(decision.reason, /escalated from WARN to CRIT/);
});

test('a group that has GROWN goes through too', () => {
  // Two more journeys falling over is not the same alert as the one already sent.
  const decision = shouldSend({ severity: 'CRIT', incidents: [{}, {}, {}] }, {
    lastSent: { severity: 'CRIT', incident_count: 1, at: new Date(Date.now() - 30000) },
    cooldownMs: 60 * 60000,
  });
  assert.equal(decision.send, true);
  assert.match(decision.reason, /affects 3 things, up from 1/);
});

test('a group that SHRANK does not re-alert', () => {
  // One of three recovering is good news, and good news is not a page.
  const decision = shouldSend({ severity: 'CRIT', incidents: [{}] }, {
    lastSent: { severity: 'CRIT', incident_count: 3, at: new Date(Date.now() - 30000) },
    cooldownMs: 60 * 60000,
  });
  assert.equal(decision.send, false);
});

test('past the cooldown it sends again', () => {
  const decision = shouldSend({ severity: 'CRIT', incidents: [{}] }, {
    lastSent: { severity: 'CRIT', incident_count: 1, at: new Date(Date.now() - 20 * 60000) },
    cooldownMs: 15 * 60000,
  });
  assert.equal(decision.send, true);
});

// ------------------------------------------------------------ robustness
test('neither function throws, whatever it is handed', () => {
  for (const input of [null, undefined, 'nope', 42, true, [], {},
    { incidents: 'no' }, { incidents: [null, 3, {}] },
    { incidents: [incident()], dependencies: 'no' },
    { incidents: [incident({ evidence: 'not a list', affected_journeys: 7 })] },
    { incidents: [incident({ opened_at: 'not a date' })], now: 'also not' }]) {
    assert.doesNotThrow(() => groupAlerts(input), String(JSON.stringify(input)).slice(0, 60));
  }
  for (const input of [null, undefined, 'x', 42, []]) {
    assert.doesNotThrow(() => shouldSend(input, {}));
    assert.doesNotThrow(() => shouldSend({ severity: 'CRIT', incidents: [] }, input));
  }
});

test('the helpers read what the incident RECORDED, not today’s data', () => {
  assert.equal(hostOf(incident({ subject_key: 'certificate:portal.kunde.dk:443' })), 'portal.kunde.dk');
  assert.equal(hostOf(incident({ evidence: failedOn('https://api.kunde.dk/x') })), 'api.kunde.dk');
  assert.equal(hostOf(incident({ subject_key: 'test:4' })), null);
  assert.ok([...endpointsOf(incident({ evidence: failedOn('https://x.dk/api/a') }))].length);
  assert.equal(linkBetween(incident(), null), null);
  assert.equal(linkBetween(null, null), null);
});

test('it says it is rules, so an AI second opinion can never be confused with it', () => {
  assert.equal(groupAlerts({ incidents: [incident()] }).source, 'rules');
});
