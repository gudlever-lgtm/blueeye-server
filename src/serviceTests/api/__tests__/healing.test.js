'use strict';

// Self-healing selectors — the decision surface (V2 §5).
//
// The spec's rule: *testen må ikke ændres automatisk uden brugerens accept*.
// So the specs here are mostly about the accept: that it is the only thing that
// changes a test, that it refuses when the test has moved underneath it, and
// that the decision is recorded either way.
//
// Contract per the repo's rule: 400 / 401 / 403 / 404 on every route, never 500.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFeatureGate, authHeader } = require('../../../../test-support/fakes');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');

const BASE = '/api/service-tests/healing';
const TESTS = '/api/service-tests/tests';

const ORIGINAL = { role: 'button', name: 'Log ind', id: 'login-button' };
const PROPOSED = { role: 'button', name: 'Log ind', id: 'signin-btn' };

// A test whose second step points at the button that is about to move, plus the
// proposal a run produced about it.
function fixture({ steps, proposal } = {}) {
  const serviceTests = makeServiceTests({
    tests: [{
      application_id: 1,
      name: 'Customer Login',
      definition: {
        version: 1,
        name: 'Customer Login',
        steps: steps || [
          { type: 'open', url: '/login' },
          { type: 'click', target: { ...ORIGINAL } },
        ],
      },
      version: 1,
      enabled: 1,
    }],
  });
  const id = serviceTests.tables.healing.insert({
    test_id: 1, run_id: null, step_path: '1', step_type: 'click',
    original_target: { ...ORIGINAL }, proposed_target: { ...PROPOSED },
    confidence: 'high', reason: 'the id changed', score: 7,
    status: 'proposed', applied_by: null, decided_at: null,
    ...proposal,
  }).id;
  return { serviceTests, app: makeApp({ serviceTests }), id };
}

const targetOf = async (app, path = '1') => {
  const res = await request(app).get(`${TESTS}/1`).set('Authorization', authHeader('operator'));
  const [i, j] = String(path).split('.').map(Number);
  const step = j === undefined ? res.body.definition.steps[i] : res.body.definition.steps[i].then[j];
  return { target: step.target, version: res.body.version };
};

// ------------------------------------------------------------------ 401 / 403
test('healing is licence-gated, anonymous-401, and deciding is operator-only', async () => {
  const { app, id } = fixture();
  assert.equal((await request(app).get(BASE)).status, 401);
  assert.equal((await request(app).post(`${BASE}/${id}/accept`).send({})).status, 401);

  assert.equal((await request(app).get(BASE).set('Authorization', authHeader('viewer'))).status, 200);
  // A viewer may SEE a proposal and may not act on it — the accept changes a test.
  assert.equal((await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('viewer')).send({})).status, 403);
  assert.equal((await request(app).post(`${BASE}/${id}/reject`).set('Authorization', authHeader('viewer')).send({})).status, 403);

  const unlicensed = makeApp({ featureGate: makeFeatureGate({ isFeatureEnabled: (f) => f !== 'service_tests' }) });
  assert.equal((await request(unlicensed).get(BASE).set('Authorization', authHeader('admin'))).status, 403);
});

// ------------------------------------------------------------------ 404 / 400
test('an unknown or malformed proposal id is 404/400, never 500', async () => {
  const { app } = fixture();
  const h = authHeader('operator');
  for (const [method, path] of [['get', '/999999'], ['post', '/999999/accept'], ['post', '/999999/reject']]) {
    assert.equal((await request(app)[method](`${BASE}${path}`).set('Authorization', h).send({})).status, 404, `${method} ${path}`);
  }
  for (const id of ['abc', '1;DROP', '-1', '1e309', '%00']) {
    for (const suffix of ['', '/accept', '/reject']) {
      const res = await request(app)[suffix ? 'post' : 'get'](`${BASE}/${id}${suffix}`).set('Authorization', h).send({});
      assert.ok(res.status < 500, `id=${id}${suffix} → ${res.status}`);
    }
  }
  assert.equal((await request(app).get(`${BASE}?test_id=abc`).set('Authorization', h)).status, 400);
  assert.equal((await request(app).get(`${BASE}?status=nonsense`).set('Authorization', h)).status, 400);

  for (const body of ['[]', '"str"', 'null', '123']) {
    const { app: a, id } = fixture();
    const res = await request(a).post(`${BASE}/${id}/accept`).set('Authorization', h)
      .set('Content-Type', 'application/json').send(body);
    assert.ok(res.status < 500, `${body} → ${res.status}`);
  }
});

// ------------------------------------------------------------- never silently
test('a proposal changes nothing until somebody accepts it', async () => {
  const { app, id } = fixture();
  // Reading it, listing it, looking at it — none of that touches the test.
  await request(app).get(BASE).set('Authorization', authHeader('operator'));
  await request(app).get(`${BASE}/${id}`).set('Authorization', authHeader('operator'));

  const before = await targetOf(app);
  assert.deepEqual(before.target, ORIGINAL, 'the test must still say what it said');
  assert.equal(before.version, 1, 'and must not have been re-saved');
});

test('accepting repoints the step, bumps the version, and records who did it', async () => {
  const { serviceTests, app, id } = fixture();
  const res = await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 200);

  const after = await targetOf(app);
  assert.deepEqual(after.target, PROPOSED);
  assert.equal(after.version, 2, 'a heal is an ordinary edit and gets an ordinary version bump');

  // The log the spec asks for survives the decision.
  const row = serviceTests.tables.healing.find(id);
  assert.equal(row.status, 'accepted');
  assert.ok(row.decided_at);
  assert.deepEqual(row.original_target, ORIGINAL, 'what the test used to say is still recorded');
});

test('rejecting records the decision and leaves the test alone', async () => {
  const { serviceTests, app, id } = fixture();
  const res = await request(app).post(`${BASE}/${id}/reject`).set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 200);
  assert.equal(serviceTests.tables.healing.find(id).status, 'rejected');
  assert.deepEqual((await targetOf(app)).target, ORIGINAL);

  const again = await request(app).post(`${BASE}/${id}/reject`).set('Authorization', authHeader('operator')).send({});
  assert.equal(again.status, 409, 'a decision is one-way — re-deciding would lose the first one');
});

test('the operator can edit the proposal before accepting it', async () => {
  const { app, id } = fixture();
  // "Accept / Reject / Edit" — an edited target is still their decision rather
  // than the heuristic's.
  const mine = { role: 'button', name: 'Log ind', id: 'my-own-choice' };
  const res = await request(app).post(`${BASE}/${id}/accept`)
    .set('Authorization', authHeader('operator')).send({ target: mine });
  assert.equal(res.status, 200);
  assert.deepEqual((await targetOf(app)).target, mine);

  const { app: app2, id: id2 } = fixture();
  assert.equal((await request(app2).post(`${BASE}/${id2}/accept`)
    .set('Authorization', authHeader('operator')).send({ target: {} })).status, 400);
});

// -------------------------------------------------- the test moved underneath
test('a proposal is refused when the step it described has changed', async () => {
  const { serviceTests, app, id } = fixture();
  // Somebody re-targeted that step by hand in the meantime. It is not the step
  // this proposal described, even though it sits at the same path.
  const t = serviceTests.tables.tests.find(1);
  t.definition.steps[1].target = { role: 'button', name: 'Something else' };
  serviceTests.tables.tests.update(1, { definition: t.definition });

  const res = await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 409);
  assert.match(res.body.error, /has been changed/);
  // And it is marked stale rather than left to be accepted again tomorrow.
  assert.equal(serviceTests.tables.healing.find(id).status, 'stale');
  assert.deepEqual((await targetOf(app)).target, { role: 'button', name: 'Something else' });
});

test('a proposal is refused when the step it described is gone', async () => {
  const { serviceTests, app, id } = fixture();
  const t = serviceTests.tables.tests.find(1);
  t.definition.steps = [t.definition.steps[0]];
  serviceTests.tables.tests.update(1, { definition: t.definition });

  const res = await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 409);
  assert.match(res.body.error, /no longer exists/);
  assert.equal(serviceTests.tables.healing.find(id).status, 'stale');
});

test('accepting twice is a 409', async () => {
  const { app, id } = fixture();
  assert.equal((await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('operator')).send({})).status, 200);
  const again = await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('operator')).send({});
  assert.equal(again.status, 409);
  assert.equal(again.body.status, 'accepted');
});

// ------------------------------------------------------------------ nesting
test('a step inside a condition block can be healed too', async () => {
  // A path rather than an index, so the tests complicated enough to break are
  // not the ones healing quietly cannot reach.
  const { app, id } = fixture({
    steps: [
      { type: 'open', url: '/login' },
      { type: 'condition', target: { text: 'Accepter cookies' }, then: [{ type: 'click', target: { ...ORIGINAL } }] },
    ],
    proposal: { step_path: '1.0' },
  });

  const res = await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('operator')).send({});
  assert.equal(res.status, 200);
  assert.deepEqual((await targetOf(app, '1.0')).target, PROPOSED);

  // And the block's own target is untouched.
  const after = await request(app).get(`${TESTS}/1`).set('Authorization', authHeader('operator'));
  assert.deepEqual(after.body.definition.steps[1].target, { text: 'Accepter cookies' });
});

// ------------------------------------------------------------------ listing
test('the list shows both sides in words, and filters by test and status', async () => {
  const { app, id } = fixture();
  const list = await request(app).get(BASE).set('Authorization', authHeader('viewer'));
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  // What the operator is being asked to judge, in the words they would use.
  assert.match(list.body[0].original_label, /Log ind/);
  assert.match(list.body[0].proposed_label, /Log ind/);
  assert.equal(list.body[0].test_name, 'Customer Login');

  assert.equal((await request(app).get(`${BASE}?test_id=1`).set('Authorization', authHeader('viewer'))).body.length, 1);
  assert.equal((await request(app).get(`${BASE}?test_id=999`).set('Authorization', authHeader('viewer'))).body.length, 0);
  assert.equal((await request(app).get(`${BASE}?status=accepted`).set('Authorization', authHeader('viewer'))).body.length, 0);

  await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('operator')).send({});
  assert.equal((await request(app).get(`${BASE}?status=accepted`).set('Authorization', authHeader('viewer'))).body.length, 1);
  assert.equal((await request(app).get(`${BASE}?status=proposed`).set('Authorization', authHeader('viewer'))).body.length, 0);
});

test('accepting one proposal makes the alternatives for that step stale', async () => {
  const { serviceTests, app, id } = fixture();
  // A later run proposed something else for the same step.
  const other = serviceTests.tables.healing.insert({
    test_id: 1, step_path: '1', step_type: 'click',
    original_target: { ...ORIGINAL }, proposed_target: { role: 'button', name: 'Log in' },
    confidence: 'medium', reason: 'another candidate', score: 5, status: 'proposed',
  }).id;

  await request(app).post(`${BASE}/${id}/accept`).set('Authorization', authHeader('operator')).send({});
  // They were alternatives to a question that now has an answer.
  assert.equal(serviceTests.tables.healing.find(other).status, 'stale');
});

// ------------------------------------------------------------------ 500
test('a repository failure is a 500 with no detail, not a leak', async () => {
  const serviceTests = makeServiceTests();
  serviceTests.repositories.healing.list = async () => {
    throw new Error('SELECT service_test_healing failed: ECONNREFUSED 10.0.0.5:3306');
  };
  const app = makeApp({ serviceTests });
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = await request(app).get(BASE).set('Authorization', authHeader('operator'));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Internal Server Error' });
    assert.ok(!res.text.includes('10.0.0.5'));
  } finally {
    process.env.NODE_ENV = prev;
  }
});
