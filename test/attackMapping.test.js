'use strict';

// MITRE ATT&CK on an event pattern — the operator's mapping.
//
// The thing these specs defend is WHO IS SPEAKING. docs/attack-indication.md
// says the detectors state facts with numbers and never name a technique, and
// that restraint is why the red line is worth looking at: 212 failed logins is
// equally consistent with a misconfigured backup job. So a technique is only
// ever asserted by a person, on a pattern, beside the reason the pattern
// already requires — and the detector's own sentence is untouched by it.
//
// The second thing is that half a mapping is refused. A technique with no
// tactic groups as nothing, exports as nothing and draws as nothing, while
// looking on every screen like a mapping that works.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, authHeader, makeSeverityRulesRepo, makeEventPatternsRepo, makeFindingStore,
} = require('../test-support/fakes');
const {
  TACTICS, TACTIC_IDS, SUGGESTED, isTechniqueId, tacticName, techniqueName,
  validateAttack, tacticsOf, navigatorLayer,
} = require('../src/events/attack');
const { createDispatcher } = require('../src/analysis/alerting/dispatcher');

const BASE = '/api/event-patterns';
const admin = () => authHeader('admin');

const mapped = (over = {}) => ({
  id: 1, name: 'Brute force on the switches', source: 'finding', enabled: true,
  match_metric: 'security.auth_failure', match_kind: null, match_host_id: null,
  match_application_id: null, reason: 'we treat this as T1110 here',
  attack_technique: 'T1110', attack_tactic: 'credential-access', ...over,
});

// ------------------------------------------------------------ the vocabulary
test('the tactic list is ATT&CK Enterprise, in matrix order, and closed', () => {
  assert.equal(TACTICS.length, 14, 'ATT&CK Enterprise has fourteen tactics');
  assert.equal(TACTICS[0].id, 'reconnaissance');
  assert.equal(TACTICS[TACTICS.length - 1].id, 'impact');
  // The order is the published matrix's, which is also roughly the order an
  // intrusion moves through — the whole reason the strip reads left to right.
  const order = TACTICS.map((x) => x.id);
  assert.ok(order.indexOf('discovery') < order.indexOf('command-and-control'));
  assert.ok(order.indexOf('command-and-control') < order.indexOf('exfiltration'));
  // Every tactic carries its TA id, because that is what an export names.
  for (const x of TACTICS) assert.match(x.code, /^TA\d{4}$/, x.id);
});

test('a technique id is checked by SHAPE, not against a list', () => {
  assert.ok(isTechniqueId('T1110'));
  assert.ok(isTechniqueId('T1110.001'), 'sub-techniques are ids too');
  // ATT&CK has some two hundred techniques and this product ships a dozen
  // suggestions. A customer who has mapped one we have never heard of is right.
  assert.ok(isTechniqueId('T9999'), 'an unknown but well-formed id is accepted');
  assert.equal(techniqueName('T9999'), null, 'and we do not pretend to know its name');
  for (const bad of ['', 'T110', 'T11101', 'brute force', 'TA0006', 'T1110.1', null, 42]) {
    assert.ok(!isTechniqueId(bad), String(bad));
  }
});

test('the suggestions name techniques this product can plausibly see — and skip the ones it cannot', () => {
  for (const s of SUGGESTED) {
    assert.ok(isTechniqueId(s.technique), s.technique);
    assert.ok(TACTIC_IDS.includes(s.tactic), `${s.technique} -> ${s.tactic}`);
    assert.ok(s.name, s.technique);
  }
  // The two first-sighting detectors are mapped to NOTHING on purpose: "this
  // site has never reached that network before" is an observation, and calling
  // it T1041 Exfiltration turns a cloud migration into an exfiltration alert.
  const metrics = SUGGESTED.flatMap((s) => s.metrics);
  assert.ok(!metrics.includes('peer.new_asn'));
  assert.ok(!metrics.includes('peer.new_country'));
  // The ones it CAN see are mapped.
  for (const m of ['net.scan', 'net.beacon', 'security.auth_failure', 'security.port_violation']) {
    assert.ok(metrics.includes(m), `${m} has no suggested technique`);
  }
});

// ------------------------------------------------------------------ validation
test('both fields or neither — half a mapping is refused, not half-applied', () => {
  const take = (input) => { const v = {}; const e = {}; validateAttack(input, v, e); return { v, e }; };

  const none = take({});
  assert.deepEqual(none.e, {});
  assert.equal(none.v.attack_technique, null);
  assert.equal(none.v.attack_tactic, null);

  assert.ok(take({ attack_technique: 'T1110' }).e.attack_tactic,
    'a technique with no tactic groups as nothing while looking mapped');
  assert.ok(take({ attack_tactic: 'discovery' }).e.attack_technique,
    'a tactic with no technique is a column with nothing in it');
  assert.ok(take({ attack_technique: 'brute force', attack_tactic: 'discovery' }).e.attack_technique);
  assert.ok(take({ attack_technique: 'T1110', attack_tactic: 'not-a-tactic' }).e.attack_tactic);

  const ok = take({ attack_technique: ' T1110 ', attack_tactic: 'credential-access' });
  assert.deepEqual(ok.e, {});
  assert.equal(ok.v.attack_technique, 'T1110');
  assert.equal(ok.v.attack_tactic, 'credential-access');
});

test('validateAttack never throws on garbage', () => {
  for (const bad of [undefined, null, 'str', 42, [], () => {}]) {
    assert.doesNotThrow(() => validateAttack(bad, {}, {}));
  }
});

// -------------------------------------------------------------------- rollup
test('tacticsOf groups mapped patterns by tactic, in matrix order, and leaves the unmapped out', () => {
  const patterns = [
    mapped({ id: 1 }),
    mapped({ id: 2, name: 'Scanning', attack_technique: 'T1046', attack_tactic: 'discovery' }),
    mapped({ id: 3, name: 'More scanning', attack_technique: 'T1018', attack_tactic: 'discovery' }),
    mapped({ id: 4, name: 'First-ever ASN', attack_technique: null, attack_tactic: null }),
  ];
  const counts = new Map([[1, { count: 2, worst: 'CRIT' }], [2, { count: 5, worst: 'WARN' }]]);
  const out = tacticsOf(patterns, counts);

  assert.deepEqual(out.map((x) => x.id), ['credential-access', 'discovery'],
    'matrix order, and the unmapped pattern is not a tactic');
  const discovery = out[1];
  assert.equal(discovery.count, 5, 'two patterns, one tactic, summed');
  assert.equal(discovery.patterns.length, 2);
  assert.equal(discovery.worst, 'WARN');
  assert.equal(out[0].worst, 'CRIT');
  assert.equal(out[0].patterns[0].technique_name, 'Brute Force', 'the suggestion list names what it knows');
});

test('a mapped tactic with nothing open still appears — "we watch for this and it is quiet" is information', () => {
  const out = tacticsOf([mapped()], new Map());
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 0);
  assert.equal(out[0].worst, null);
});

test('an install that has mapped nothing gets no strip at all', () => {
  assert.deepEqual(tacticsOf([mapped({ attack_technique: null, attack_tactic: null })], new Map()), []);
  assert.deepEqual(tacticsOf([], new Map()), []);
  assert.deepEqual(tacticsOf(null, new Map()), []);
});

// ------------------------------------------------------------ Navigator layer
test('the Navigator layer is a layer: domain, version, and one cell per technique', () => {
  const layer = navigatorLayer(
    [mapped({ id: 1 }), mapped({ id: 2, name: 'Scanning', attack_technique: 'T1046', attack_tactic: 'discovery' })],
    new Map([[1, { count: 3 }]]),
  );
  assert.equal(layer.domain, 'enterprise-attack');
  assert.equal(layer.versions.layer, '4.5');
  assert.equal(layer.techniques.length, 2);
  const brute = layer.techniques.find((x) => x.techniqueID === 'T1110');
  assert.equal(brute.tactic, 'credential-access');
  assert.equal(brute.score, 3);
  // The operator's own words travel with the cell. A cell that only says
  // "T1110" says nothing the matrix did not already.
  assert.match(brute.comment, /we treat this as T1110 here/);
  const scan = layer.techniques.find((x) => x.techniqueID === 'T1046');
  assert.equal(scan.score, 0, 'mapped but quiet is still coverage');
  assert.ok(layer.gradient.maxValue >= 1, 'a zero-wide gradient renders every cell the same colour');
});

test('two patterns on the same technique are one cell, scored together', () => {
  const layer = navigatorLayer(
    [mapped({ id: 1 }), mapped({ id: 2, name: 'VPN brute force', match_metric: 'security.vpn_failure' })],
    new Map([[1, { count: 2 }], [2, { count: 4 }]]),
  );
  assert.equal(layer.techniques.length, 1);
  assert.equal(layer.techniques[0].score, 6);
  assert.match(layer.techniques[0].comment, /VPN brute force/);
});

// ---------------------------------------------------------------- dispatcher
test('an alert carries the technique when the pattern has one — and the detector still says what it said', async () => {
  const sent = [];
  const config = {
    enabled: true, enabledSetting: true, cooldownMs: 0,
    channels: { email: { enabled: true, minSeverity: 'INFO' } },
  };
  const dispatcher = createDispatcher({
    config,
    channels: { email: { async send(s) { sent.push(s); return { ok: true }; } } },
    // A pattern with NO route still labels its alerts: the mapping is the
    // pattern's, and naming a technique is not the same act as redirecting.
    routing: { routeFor: async () => ({ pattern: mapped(), route: null, routed: true }) },
  });

  const finding = {
    id: 1, hostId: 'core-sw-1', metric: 'security.auth_failure', kind: 'RATE', severity: 'CRIT',
    explanation: '212 auth failures in 10 minutes',
  };
  await dispatcher.dispatch(finding);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].attackTechnique, 'T1110');
  assert.equal(sent[0].attackTactic, 'credential-access');
  assert.equal(sent[0].attackPattern, 'Brute force on the switches');
  assert.equal(sent[0].explanation, '212 auth failures in 10 minutes',
    "the detector's own sentence is not rewritten by the label");
  assert.equal(finding.attackTechnique, undefined, 'the caller keeps the finding as it was');
});

test('an unmapped pattern labels nothing', async () => {
  const sent = [];
  const dispatcher = createDispatcher({
    config: { enabled: true, enabledSetting: true, cooldownMs: 0, channels: { email: { enabled: true, minSeverity: 'INFO' } } },
    channels: { email: { async send(s) { sent.push(s); return { ok: true }; } } },
    routing: { routeFor: async () => ({ pattern: mapped({ attack_technique: null, attack_tactic: null }), route: null, routed: true }) },
  });
  await dispatcher.dispatch({ id: 1, hostId: 'a', metric: 'rtt', kind: 'ANOMALY', severity: 'WARN' });
  assert.equal(sent[0].attackTechnique, undefined);
});

test('each channel carries it in the shape its reader parses', () => {
  const labelled = {
    hostId: 'core-sw-1', hostName: 'core-sw-1', metric: 'security.auth_failure', kind: 'RATE',
    severity: 'CRIT', explanation: '212 auth failures in 10 minutes', createdAt: '2026-10-09T12:00:00.000Z',
    attackTechnique: 'T1110', attackTactic: 'credential-access', attackPattern: 'Brute force on the switches',
  };

  // syslog: unquoted key=value beside the fields already there, because that is
  // what a SIEM's parser splits on.
  const { createSyslogChannel } = require('../src/analysis/alerting/channels/syslog');
  const lines = [];
  const syslog = createSyslogChannel({
    config: { host: '10.0.0.1', port: 514, proto: 'udp', appName: 'blueeye' },
    send: (buf) => { lines.push(buf.toString()); },
  });
  return syslog.send(labelled, null).then(() => {
    assert.equal(lines.length, 1);
    assert.match(lines[0], /technique=T1110 tactic=credential-access/);
    assert.match(lines[0], /212 auth failures/, 'the sentence is still there');

    // matrix: a line after the detector's sentence, never instead of it.
    const { createMatrixChannel } = require('../src/analysis/alerting/channels/matrix');
    const posted = [];
    const matrix = createMatrixChannel({
      config: { homeserver: 'https://m.example.dk', roomId: '!r:example.dk', accessToken: 'x' },
      fetchImpl: async (url, init) => { posted.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({}) }; },
    });
    return matrix.send(labelled, null).then(() => {
      assert.equal(posted.length, 1);
      assert.match(posted[0].body, /MITRE ATT&CK: T1110 · credential-access/);
      assert.match(posted[0].body, /212 auth failures/);
    });
  });
});

// ---------------------------------------------------------------------- API
function appWith(seed = [], findings = []) {
  const severityRulesRepo = makeSeverityRulesRepo();
  const eventPatternsRepo = makeEventPatternsRepo(seed, { severityRulesRepo });
  const findingStore = makeFindingStore();
  for (const f of findings) findingStore.rows.push({ createdAt: new Date().toISOString(), acked: false, ...f });
  return { app: makeApp({ severityRulesRepo, eventPatternsRepo, findingStore }), findingStore, eventPatternsRepo };
}

test('GET /attack serves the server\'s own vocabulary, so the form cannot offer a tactic it refuses', async () => {
  const { app } = appWith();
  assert.equal((await request(app).get(`${BASE}/attack`)).status, 401);
  const res = await request(app).get(`${BASE}/attack`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.tactics.length, 14);
  assert.ok(res.body.suggested.length >= 10);
});

test('the pattern API takes the mapping, and refuses half of one', async () => {
  const { app } = appWith();
  const base = { name: 'Brute force', source: 'finding', match_metric: 'security.auth_failure', reason: 'r' };

  const half = await request(app).post(BASE).set('Authorization', admin())
    .send({ ...base, attack_technique: 'T1110' });
  assert.equal(half.status, 400);
  assert.ok(half.body.details.attack_tactic);

  const ok = await request(app).post(BASE).set('Authorization', admin())
    .send({ ...base, attack_technique: 'T1110', attack_tactic: 'credential-access' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.attack_technique, 'T1110');

  // And it can be taken off again — a mapping somebody no longer stands behind
  // must be removable without deleting the pattern and its rules with it.
  const cleared = await request(app).put(`${BASE}/${ok.body.id}`).set('Authorization', admin())
    .send({ attack_technique: '', attack_tactic: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.attack_technique, null);
  assert.equal(cleared.body.attack_tactic, null);
});

test('the layer export is admin-only, downloads as a file, and counts without writing', async () => {
  const { app, findingStore } = appWith([mapped()], [
    { id: 'f1', hostId: 'a1', metric: 'security.auth_failure', kind: 'RATE', severity: 'CRIT' },
    { id: 'f2', hostId: 'a2', metric: 'security.auth_failure', kind: 'RATE', severity: 'WARN' },
    { id: 'f3', hostId: 'a3', metric: 'rtt', kind: 'ANOMALY', severity: 'CRIT' },
  ]);
  assert.equal((await request(app).get(`${BASE}/attack/layer`)).status, 401);
  assert.equal((await request(app).get(`${BASE}/attack/layer`).set('Authorization', authHeader('viewer'))).status, 403);

  const res = await request(app).get(`${BASE}/attack/layer`).set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], /attachment; filename="blueeye-attack-layer\.json"/);
  assert.equal(res.body.domain, 'enterprise-attack');
  assert.equal(res.body.techniques.length, 1);
  assert.equal(res.body.techniques[0].score, 2, 'the two auth failures, not the latency anomaly');
  assert.equal(findingStore.rows.length, 3, 'an export is a read');
});

test('a disabled or unmapped pattern is not in the layer', async () => {
  const { app } = appWith([
    mapped({ id: 1, enabled: false }),
    mapped({ id: 2, name: 'Unmapped', attack_technique: null, attack_tactic: null }),
  ]);
  const res = await request(app).get(`${BASE}/attack/layer`).set('Authorization', admin());
  assert.deepEqual(res.body.techniques, []);
});

test('the red bar carries the tactics lit right now, and no raw groups', async () => {
  const { app } = appWith([mapped(), mapped({
    id: 2, name: 'Scanning', match_metric: 'net.scan', attack_technique: 'T1046', attack_tactic: 'discovery',
  })], [
    // Two detectors, one event case: the corroboration the red line requires
    // (docs/attack-indication.md), and a progression once it has tactic names —
    // Discovery beside Credential Access.
    { id: 'f1', hostId: 'a1', metric: 'security.auth_failure', kind: 'RATE', severity: 'CRIT', eventCaseId: 9 },
    { id: 'f2', hostId: 'a1', metric: 'net.scan', kind: 'THRESHOLD', severity: 'WARN', eventCaseId: 9 },
  ]);
  const res = await request(app).get('/api/findings/attack-indication').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.groups, undefined, 'the raw groups are not part of the bar contract');
  assert.deepEqual(res.body.tactics.map((x) => x.id), ['credential-access', 'discovery'],
    'matrix order — two cells side by side is a progression, which is the point of the strip');
  assert.equal(res.body.tactics[0].count, 1);
  assert.equal(res.body.tactics[0].worst, 'CRIT');
});

test('an install with no mapped pattern gets an empty strip, never a 500', async () => {
  const { app } = appWith([], [
    { id: 'f1', hostId: 'a1', metric: 'security.auth_failure', kind: 'RATE', severity: 'CRIT', eventCaseId: 9 },
  ]);
  const res = await request(app).get('/api/findings/attack-indication').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.tactics, []);
  assert.ok(res.body.count >= 1, 'the bar itself still works — the strip is the addition, not the feature');
});

test('a patterns repository that throws costs the strip, not the bar', async () => {
  const severityRulesRepo = makeSeverityRulesRepo();
  const broken = { ...makeEventPatternsRepo([], { severityRulesRepo }), active: async () => { throw new Error('db gone'); } };
  const findingStore = makeFindingStore();
  findingStore.rows.push({
    id: 'f1', hostId: 'a1', metric: 'security.auth_failure', kind: 'RATE', severity: 'CRIT',
    acked: false, eventCaseId: 9, createdAt: new Date().toISOString(),
  });
  const app = makeApp({ severityRulesRepo, eventPatternsRepo: broken, findingStore });
  const res = await request(app).get('/api/findings/attack-indication').set('Authorization', admin());
  assert.equal(res.status, 200, 'every open browser polls this endpoint');
  assert.deepEqual(res.body.tactics, []);
  assert.ok(res.body.count >= 1);
});

test('tacticName falls back to nothing rather than inventing a label', () => {
  assert.equal(tacticName('credential-access'), 'Credential Access');
  assert.equal(tacticName('not-a-tactic'), null);
  assert.equal(tacticName(null), null);
});
