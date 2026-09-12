'use strict';

// The incident lifecycle over HTTP: picking one up, identifying it, resolving
// it, closing it — and the timeline that records all of it.
//
// Migration 090 added three states and this API knew about none of them. The
// bug it left behind is the one worth naming: resolve guarded on
// `status !== 'open'`, so an incident somebody had PICKED UP could no longer be
// resolved. That is the one thing they were most likely to want to do next.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, authHeader } = require('../../../../test-support/fakes');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');
const { TRANSITIONS } = require('../../incidents/lifecycle');

const BASE = '/api/service-tests/assurance';

function fixture() {
  const st = makeServiceTests();
  return { st, app: makeApp({ serviceTests: st }) };
}

const openIncident = (st, over = {}) => st.repositories.incidents.open({
  application_id: 1, subject_type: 'test', subject_key: 'test:1',
  subject_label: 'Customer search', kind: 'http_500', severity: 'CRIT',
  summary: 'HTTP 500 from /api/customer/search', explanation: 'x', evidence: ['HTTP 500'],
  ...over,
});

const get = (app, path, role = 'admin') => request(app).get(`${BASE}${path}`).set('Authorization', authHeader(role));
const post = (app, path, body, role = 'admin') =>
  request(app).post(`${BASE}${path}`).set('Authorization', authHeader(role)).send(body);

// ---------------------------------------------------------------- detail
test('an incident carries its reference, timeline, duration, impact and next moves', async () => {
  const { st, app } = fixture();
  const incident = await openIncident(st);
  await st.repositories.incidents.addEvents(incident.id, [
    { kind: 'opened', summary: 'Customer search started failing', source: 'run' },
  ]);

  const res = await get(app, `/incidents/${incident.id}`);
  assert.equal(res.status, 200);
  assert.match(res.body.reference, /^INC-\d{4}-\d{5}$/);
  assert.equal(res.body.timeline.length, 1);
  assert.ok(res.body.duration, 'how long it has been going is the first question');
  assert.ok(res.body.impact, 'technical failure and service impact are different things');
  assert.deepEqual(res.body.can_move_to, TRANSITIONS.open,
    'the screen must be offered exactly the moves that will be accepted');
});

test('affected users is Unknown, never invented', async () => {
  const { st, app } = fixture();
  const incident = await openIncident(st);
  const res = await get(app, `/incidents/${incident.id}`);
  assert.equal(res.body.impact.affected_users, 'unknown');
});

test('an incident from before the timeline existed reports an empty one, not an invented one', async () => {
  const { st, app } = fixture();
  const incident = await openIncident(st);
  const res = await get(app, `/incidents/${incident.id}`);
  assert.deepEqual(res.body.timeline, []);
});

// -------------------------------------------------------------- lifecycle
test('an incident can be picked up, identified, resolved and closed', async () => {
  const { st, app } = fixture();
  const incident = await openIncident(st);

  for (const [to, expected] of [['investigating', 200], ['identified', 200], ['resolved', 200], ['closed', 200]]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await post(app, `/incidents/${incident.id}/status`, { status: to });
    assert.equal(res.status, expected, `${to}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.status, to);
  }
});

test('picking one up acknowledges it, so alerting can stop escalating', async () => {
  const { st, app } = fixture();
  const incident = await openIncident(st);
  const res = await post(app, `/incidents/${incident.id}/status`, { status: 'investigating' });
  assert.ok(res.body.acknowledged_at);
  assert.equal(res.body.acknowledged_by, 1);
});

test('an illegal move is 409 with a sentence, never a 500', async () => {
  const { st, app } = fixture();
  const incident = await openIncident(st);
  await post(app, `/incidents/${incident.id}/status`, { status: 'resolved' });
  await post(app, `/incidents/${incident.id}/status`, { status: 'closed' });

  const res = await post(app, `/incidents/${incident.id}/status`, { status: 'open' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /closed incident stays closed/);
  assert.equal(res.body.incident.status, 'closed', 'and the caller is told where it actually is');
});

test('an unknown status is 400, and an unknown incident is 404', async () => {
  const { st, app } = fixture();
  const incident = await openIncident(st);
  assert.equal((await post(app, `/incidents/${incident.id}/status`, { status: 'on fire' })).status, 400);
  assert.equal((await post(app, `/incidents/${incident.id}/status`, {})).status, 400);
  assert.equal((await post(app, '/incidents/999999/status', { status: 'investigating' })).status, 404);
  assert.equal((await post(app, '/incidents/nope/status', { status: 'investigating' })).status, 400);
});

test('every move a screen is offered is a move the API accepts', async () => {
  // The sweep that matters: `can_move_to` and what POST /status allows are two
  // statements of one rule, and a screen offering a button that 409s is worse
  // than one that offers nothing.
  const { st, app } = fixture();
  for (const from of Object.keys(TRANSITIONS)) {
    for (const to of TRANSITIONS[from]) {
      // eslint-disable-next-line no-await-in-loop
      const incident = await openIncident(st, { subject_key: `test:${from}-${to}` });
      if (from !== 'open') {
        // Walk it into the state under test by a legal path.
        const path = { investigating: ['investigating'], identified: ['identified'], resolved: ['resolved'], closed: ['resolved', 'closed'] }[from];
        for (const step of path) {
          // eslint-disable-next-line no-await-in-loop
          await post(app, `/incidents/${incident.id}/status`, { status: step });
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const offered = (await get(app, `/incidents/${incident.id}`)).body.can_move_to;
      assert.ok(offered.includes(to), `${from} should offer ${to}`);
      // eslint-disable-next-line no-await-in-loop
      const res = await post(app, `/incidents/${incident.id}/status`, { status: to });
      assert.equal(res.status, 200, `${from} → ${to} was offered and refused: ${JSON.stringify(res.body)}`);
    }
  }
});

test('a move is recorded on the timeline as a PERSON, not as a run', async () => {
  // A person acknowledging an incident and a sweep observing a recovery are both
  // real events, and a timeline that presents one as the other is a timeline
  // nobody can read.
  const { st, app } = fixture();
  const incident = await openIncident(st);
  await post(app, `/incidents/${incident.id}/status`, { status: 'investigating', note: 'looking at the auth service' });

  const timeline = await st.repositories.incidents.timeline(incident.id);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].source, 'person');
  assert.equal(timeline[0].actor_id, 1);
  assert.match(timeline[0].summary, /looking at the auth service/);
});

test('moving to the state it is already in changes nothing and adds no entry', async () => {
  const { st, app } = fixture();
  const incident = await openIncident(st);
  await post(app, `/incidents/${incident.id}/status`, { status: 'investigating' });
  const res = await post(app, `/incidents/${incident.id}/status`, { status: 'investigating' });
  assert.equal(res.status, 200);
  assert.equal((await st.repositories.incidents.timeline(incident.id)).length, 1, 'a no-op wrote a timeline entry');
});

// ------------------------------------------------------------- resolving
test('an incident somebody picked up can still be resolved', async () => {
  // The live bug. resolve guarded on `status !== 'open'`, so an incident under
  // investigation could not be resolved — the one thing whoever picked it up was
  // most likely to want to do next.
  const { st, app } = fixture();
  const incident = await openIncident(st);
  await post(app, `/incidents/${incident.id}/status`, { status: 'investigating' });

  const res = await post(app, `/incidents/${incident.id}/resolve`, { resolution: 'restarted the pool' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'resolved');
  assert.equal(res.body.resolution, 'restarted the pool');
});

test('an already-resolved incident is 400, and says which state it is in', async () => {
  const { st, app } = fixture();
  const incident = await openIncident(st);
  await post(app, `/incidents/${incident.id}/resolve`, {});
  const res = await post(app, `/incidents/${incident.id}/resolve`, {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already resolved/);
});

// ------------------------------------------------------------------ RBAC
test('a viewer can read an incident and move nothing', async () => {
  const { st, app } = fixture();
  const incident = await openIncident(st);
  assert.equal((await get(app, `/incidents/${incident.id}`, 'viewer')).status, 200);
  assert.equal((await post(app, `/incidents/${incident.id}/status`, { status: 'investigating' }, 'viewer')).status, 403);
  assert.equal((await post(app, `/incidents/${incident.id}/resolve`, {}, 'viewer')).status, 403);
});

test('the status filter knows every state, not just the two V2 had', async () => {
  const { st, app } = fixture();
  const incident = await openIncident(st);
  await post(app, `/incidents/${incident.id}/status`, { status: 'investigating' });
  for (const status of Object.keys(TRANSITIONS)) {
    // eslint-disable-next-line no-await-in-loop
    const res = await get(app, `/incidents?status=${status}`);
    assert.equal(res.status, 200, `?status=${status} was refused`);
  }
  const listed = await get(app, '/incidents?status=investigating');
  assert.equal(listed.body.length, 1, 'an incident somebody picked up is invisible to the dashboard');
});
