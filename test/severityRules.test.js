'use strict';

// Severity rules — "this kind of event is a warning for us, not a critical".
//
// The specs are mostly about restraint. This feature's failure mode is a
// machine that quietly downgrades criticals: the dashboard goes green, nobody
// looks again, and the outage is found by a customer. So the rules below pin
// the three things that stop that — a rule can never silence an event, it can
// never change one without saying so, and writing one never rewrites history.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, authHeader, makeSeverityRulesRepo } = require('../test-support/fakes');
const {
  applySeverity, ruleFor, specificityOf, validateRule, describeDecision, SEVERITIES,
} = require('../src/events/severityRules');

const BASE = '/api/severity-rules';

const rule = (over = {}) => ({
  id: 1, source: 'finding', enabled: true, severity: 'WARN',
  match_metric: null, match_kind: null, match_host_id: null, match_application_id: null,
  reason: 'because', ...over,
});

// ------------------------------------------------------------------- matching
test('a rule changes the severity of what it matches, and nothing else', () => {
  const rules = [rule({ id: 1, match_metric: 'packet_loss', severity: 'WARN' })];
  const loss = applySeverity(rules, { source: 'finding', severity: 'CRIT', metric: 'packet_loss', kind: 'ANOMALY', host_id: 'a' });
  assert.equal(loss.severity, 'WARN');
  assert.equal(loss.original_severity, 'CRIT');
  assert.equal(loss.severity_rule_id, 1);
  assert.equal(loss.changed, true);

  const rtt = applySeverity(rules, { source: 'finding', severity: 'CRIT', metric: 'rtt', kind: 'ANOMALY', host_id: 'a' });
  assert.equal(rtt.severity, 'CRIT');
  assert.equal(rtt.original_severity, null, 'an untouched event records no rule');
  assert.equal(rtt.changed, false);
});

test('the most specific rule wins, so a general rule is safe to write', () => {
  // "packet_loss is noise" — except on the core router, where it is not.
  const rules = [
    rule({ id: 1, match_metric: 'packet_loss', severity: 'WARN' }),
    rule({ id: 2, match_metric: 'packet_loss', match_host_id: 'gw-core', severity: 'CRIT' }),
  ];
  const branch = { source: 'finding', severity: 'CRIT', metric: 'packet_loss', kind: 'ANOMALY', host_id: 'branch-7' };
  const core = { source: 'finding', severity: 'CRIT', metric: 'packet_loss', kind: 'ANOMALY', host_id: 'gw-core' };

  assert.equal(applySeverity(rules, branch).severity, 'WARN');
  assert.equal(applySeverity(rules, core).severity, 'CRIT', 'the narrower rule must win');
  assert.equal(ruleFor(rules, core).id, 2);
  assert.ok(specificityOf(rules[1]) > specificityOf(rules[0]));
});

test('two equally specific rules: the newer decision wins', () => {
  // A person changing their mind, not an ambiguity to refuse — and the later
  // one is what they meant.
  const rules = [
    rule({ id: 1, match_metric: 'rtt', severity: 'INFO' }),
    rule({ id: 2, match_metric: 'rtt', severity: 'WARN' }),
  ];
  assert.equal(ruleFor(rules, { source: 'finding', severity: 'CRIT', metric: 'rtt' }).id, 2);
});

test('a rule never crosses sources, and a disabled rule does nothing', () => {
  const rules = [rule({ id: 1, source: 'service_assurance', match_kind: 'http_5xx', severity: 'INFO' })];
  // Same kind string, different stream.
  assert.equal(applySeverity(rules, { source: 'finding', severity: 'CRIT', kind: 'http_5xx' }).changed, false);
  assert.equal(applySeverity(rules, { source: 'service_assurance', severity: 'CRIT', kind: 'http_5xx' }).severity, 'INFO');

  const off = [rule({ id: 1, source: 'service_assurance', match_kind: 'http_5xx', severity: 'INFO', enabled: false })];
  assert.equal(applySeverity(off, { source: 'service_assurance', severity: 'CRIT', kind: 'http_5xx' }).changed, false);
});

test('a rule that agrees with the detector is not a change', () => {
  // Recording it would put "downgraded from WARN to WARN" on screen and make
  // the provenance meaningless.
  const rules = [rule({ match_metric: 'rtt', severity: 'WARN' })];
  const d = applySeverity(rules, { source: 'finding', severity: 'WARN', metric: 'rtt' });
  assert.equal(d.changed, false);
  assert.equal(d.severity_rule_id, null);
});

test('a rule can never silence an event', () => {
  // INFO is the floor. Something that makes events disappear is a different and
  // far more dangerous control, and it is not going to hide behind this one.
  for (const s of SEVERITIES) assert.ok(['INFO', 'WARN', 'CRIT'].includes(s));
  assert.ok(validateRule({ source: 'finding', severity: 'NONE', match_metric: 'x', reason: 'r' }).errors);
  assert.ok(validateRule({ source: 'finding', severity: 'SUPPRESS', match_metric: 'x', reason: 'r' }).errors);
  assert.ok(validateRule({ source: 'finding', severity: null, match_metric: 'x', reason: 'r' }).errors);
});

test('a changed event always says so, in words', () => {
  const d = applySeverity([rule({ match_metric: 'rtt', severity: 'WARN', reason: 'the VPN link is always like this' })],
    { source: 'finding', severity: 'CRIT', metric: 'rtt' });
  const sentence = describeDecision(d);
  assert.match(sentence, /CRIT/);
  assert.match(sentence, /downgraded/);
  assert.match(sentence, /WARN/);
  assert.match(sentence, /the VPN link is always like this/, 'the reason is the point, not decoration');
  // An unchanged event has nothing to explain.
  assert.equal(describeDecision(applySeverity([], { source: 'finding', severity: 'CRIT', metric: 'rtt' })), null);
});

test('an upgrade is as valid as a downgrade, and says which', () => {
  const d = applySeverity([rule({ match_metric: 'disk_full', severity: 'CRIT' })],
    { source: 'finding', severity: 'WARN', metric: 'disk_full' });
  assert.equal(d.severity, 'CRIT');
  assert.match(describeDecision(d), /upgraded/);
});

test('junk in, no decision out — never a crash', () => {
  for (const bad of [null, undefined, {}, 'nope', 42]) {
    assert.doesNotThrow(() => applySeverity([rule()], bad));
    assert.doesNotThrow(() => applySeverity(bad, { source: 'finding', severity: 'CRIT' }));
  }
  assert.equal(applySeverity([null, 42, 'x'], { source: 'finding', severity: 'CRIT', metric: 'rtt' }).changed, false);
  assert.equal(applySeverity([rule()], { source: 'finding', severity: 'NOPE' }).severity, null);
});

// ----------------------------------------------------------------- validation
test('a rule with nothing to match on is refused', () => {
  // It would govern EVERY event from its source, which is never what anyone
  // means and is how an estate goes quiet overnight.
  const res = validateRule({ source: 'finding', severity: 'INFO', reason: 'quieter please' });
  assert.ok(res.errors._);
  assert.match(res.errors._, /every event/);
});

test('a rule must say why it exists', () => {
  // The one somebody inherits in two years and dare not delete.
  assert.match(validateRule({ source: 'finding', severity: 'WARN', match_metric: 'rtt' }).errors.reason, /why/);
  assert.match(validateRule({ source: 'finding', severity: 'WARN', match_metric: 'rtt', reason: '  ' }).errors.reason, /why/);
  assert.ok(validateRule({ source: 'finding', severity: 'WARN', match_metric: 'rtt', reason: 'ok' }).value);
});

test('a match field from the wrong source is refused, not ignored', () => {
  // Silently dropping it would make the rule match far more than the person who
  // wrote it believed.
  const res = validateRule({ source: 'service_assurance', severity: 'INFO', match_kind: 'x', match_host_id: 'a1', reason: 'r' });
  assert.ok(res.errors.match_host_id);
  assert.match(res.errors.match_host_id, /does not apply/);

  // But only when it carries a value. A stored row has every column, the other
  // source's included, sitting at NULL — and an edit validates the stored row
  // merged with the patch. Refusing a null there would make every rule
  // uneditable.
  const empty = validateRule({
    source: 'service_assurance', severity: 'INFO', match_kind: 'x', reason: 'r',
    match_metric: null, match_host_id: '',
  });
  assert.ok(empty.value, JSON.stringify(empty.errors));
});

// ------------------------------------------------------------------- HTTP
test('rules are admin-only to write, viewer-readable, and 401 anonymous', async () => {
  const app = makeApp();
  assert.equal((await request(app).get(BASE)).status, 401);
  assert.equal((await request(app).post(BASE).send({})).status, 401);

  assert.equal((await request(app).get(BASE).set('Authorization', authHeader('viewer'))).status, 200);
  // A rule changes what wakes people at 3am, across the estate, indefinitely.
  for (const role of ['viewer', 'operator']) {
    assert.equal((await request(app).post(BASE).set('Authorization', authHeader(role)).send({})).status, 403, role);
    assert.equal((await request(app).delete(`${BASE}/1`).set('Authorization', authHeader(role))).status, 403, role);
  }
});

test('the HTTP surface answers 400/404 and never 500', async () => {
  const app = makeApp();
  const h = authHeader('admin');
  assert.equal((await request(app).post(BASE).set('Authorization', h).send({})).status, 400);
  assert.equal((await request(app).get(`${BASE}/999999`).set('Authorization', h)).status, 404);
  assert.equal((await request(app).put(`${BASE}/999999`).set('Authorization', h).send({ severity: 'WARN' })).status, 404);
  assert.equal((await request(app).delete(`${BASE}/999999`).set('Authorization', h)).status, 404);
  assert.equal((await request(app).get(`${BASE}?source=nonsense`).set('Authorization', h)).status, 400);

  for (const id of ['abc', '1;DROP', '-1', '1e309', '%00']) {
    for (const [method, suffix] of [['get', ''], ['put', ''], ['delete', ''], ['post', '/apply-to-open']]) {
      const res = await request(app)[method](`${BASE}/${id}${suffix}`).set('Authorization', h).send({});
      assert.ok(res.status < 500, `${method} ${id}${suffix} → ${res.status}`);
    }
  }
  for (const body of ['[]', '"str"', 'null', '123']) {
    const res = await request(app).post(BASE).set('Authorization', h).set('Content-Type', 'application/json').send(body);
    assert.ok(res.status < 500, `${body} → ${res.status}`);
  }
});

test('an edit is validated as a whole rule, not as a patch', async () => {
  const app = makeApp();
  const h = authHeader('admin');
  const created = (await request(app).post(BASE).set('Authorization', h)
    .send({ source: 'finding', severity: 'WARN', match_metric: 'rtt', reason: 'noisy link' })).body;

  // Clearing the last match field would turn a narrow rule into one that
  // governs every finding BlueEyes produces. Validating the patch alone would
  // have let it through.
  const widened = await request(app).put(`${BASE}/${created.id}`).set('Authorization', h).send({ match_metric: '' });
  assert.equal(widened.status, 400);
  assert.match(widened.body.details._, /every event/);

  const ok = await request(app).put(`${BASE}/${created.id}`).set('Authorization', h).send({ severity: 'INFO' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.severity, 'INFO');
  assert.equal(ok.body.match_metric, 'rtt', 'the rest of the rule survives an edit');
});

test('writing a rule does not touch events that already exist', async () => {
  const app = makeApp();
  const h = authHeader('admin');
  // A rule written today must not silently rewrite what you thought last March.
  const res = await request(app).post(BASE).set('Authorization', h)
    .send({ source: 'finding', severity: 'INFO', match_metric: 'rtt', reason: 'r' });
  assert.equal(res.status, 201);
  assert.equal(res.body.applied_count, 0, 'creating a rule applies it to nothing');
});

test('the backfill counts before it changes, and needs confirming', async () => {
  const app = makeApp();
  const h = authHeader('admin');
  const created = (await request(app).post(BASE).set('Authorization', h)
    .send({ source: 'finding', severity: 'WARN', match_metric: 'rtt', reason: 'r' })).body;

  const dry = await request(app).post(`${BASE}/${created.id}/apply-to-open`).set('Authorization', h).send({});
  assert.equal(dry.status, 200);
  assert.equal(dry.dry_run, undefined);
  assert.equal(dry.body.dry_run, true, 'a backfill must not happen because somebody clicked once');
  assert.match(dry.body.note, /confirm/);

  const applied = await request(app).post(`${BASE}/${created.id}/apply-to-open`).set('Authorization', h).send({ confirm: true });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.dry_run, false);
});

test('preview shows the effect without storing anything', async () => {
  const app = makeApp();
  const res = await request(app).post(`${BASE}/preview`).set('Authorization', authHeader('viewer')).send({
    rule: { source: 'finding', severity: 'WARN', match_metric: 'packet_loss', reason: 'noisy' },
    event: { source: 'finding', severity: 'CRIT', metric: 'packet_loss', kind: 'ANOMALY', host_id: 'a' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.severity, 'WARN');
  assert.equal(res.body.changed, true);
  assert.match(res.body.explanation, /downgraded/);

  assert.equal((await request(app).post(`${BASE}/preview`).set('Authorization', authHeader('viewer'))
    .send({ rule: { source: 'finding', severity: 'WARN', match_metric: 'x', reason: 'r' } })).status, 400);
});

// ------------------------------------------------------- the store applies it
test('a finding is STORED with the ruled severity, and remembers what it was', async () => {
  const { FindingStore } = require('../src/analysis/findings');
  const inserts = [];
  const pool = { query: async (sql, params) => { inserts.push({ sql, params }); return [{ affectedRows: 1 }]; } };
  const severityRules = makeSeverityRulesRepo([
    { source: 'finding', match_metric: 'packet_loss', severity: 'WARN', reason: 'noisy wifi' },
  ]);
  const store = new FindingStore({ db: { pool }, severityRules });

  const saved = await store.save({
    hostId: 'a1', metric: 'packet_loss', severity: 'CRIT', kind: 'ANOMALY',
    explanation: 'loss above baseline', evidence: [{ at: 1, value: 5 }],
  });

  // Alerting reads the STORED severity — that is the whole point of not paging.
  assert.equal(saved.severity, 'WARN');
  assert.equal(saved.originalSeverity, 'CRIT');
  assert.ok(saved.severityRuleId);
  const insert = inserts.find((q) => /INSERT INTO findings/i.test(q.sql));
  assert.ok(insert.params.includes('WARN'));
  assert.ok(insert.params.includes('CRIT'), 'what it would have been is stored beside it');
});

test('a rule set that cannot be read leaves the detector\'s judgement alone', async () => {
  const { FindingStore } = require('../src/analysis/findings');
  const pool = { query: async () => [{ affectedRows: 1 }] };
  const broken = { active: async () => { throw new Error('db down'); } };
  const store = new FindingStore({ db: { pool }, severityRules: broken });

  // The safe direction: the alternative is losing the downgrade AND the finding.
  const saved = await store.save({
    hostId: 'a1', metric: 'rtt', severity: 'CRIT', kind: 'ANOMALY',
    explanation: 'x', evidence: [{ at: 1, value: 5 }],
  });
  assert.equal(saved.severity, 'CRIT');
  assert.equal(saved.originalSeverity, null);
});

test('without rules wired at all, nothing changes', async () => {
  const { FindingStore } = require('../src/analysis/findings');
  const pool = { query: async () => [{ affectedRows: 1 }] };
  const store = new FindingStore({ db: { pool } });
  const saved = await store.save({
    hostId: 'a1', metric: 'rtt', severity: 'CRIT', kind: 'ANOMALY',
    explanation: 'x', evidence: [{ at: 1, value: 5 }],
  });
  assert.equal(saved.severity, 'CRIT');
  assert.equal(saved.severityRuleId, null);
});
