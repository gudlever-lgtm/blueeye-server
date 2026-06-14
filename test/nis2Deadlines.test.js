'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeNis2IncidentsRepo, authHeader } = require('../test-support/fakes');

const HOUR = 3600 * 1000;
const longAgo = new Date(Date.now() - 200 * HOUR).toISOString();

async function seed(repo) {
  await repo.create({ title: 'Significant breach', severity: 'high', status: 'investigating', detectedAt: longAgo, notificationRequired: true });
  await repo.create({ title: 'Minor blip', severity: 'low', status: 'open' }); // not a reporting duty
}

test('GET /api/nis2/incidents attaches computed reporting deadlines', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  await seed(nis2IncidentsRepo);
  const res = await request(makeApp({ nis2IncidentsRepo }))
    .get('/api/nis2/incidents').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const significant = res.body.find((i) => i.title === 'Significant breach');
  const minor = res.body.find((i) => i.title === 'Minor blip');
  assert.equal(significant.deadlines.applicable, true);
  assert.equal(significant.deadlines.stages.length, 3);
  assert.equal(significant.deadlines.worstStatus, 'overdue'); // 200h old
  assert.equal(minor.deadlines.applicable, false);
});

test('GET /api/nis2/deadlines returns an urgency-ranked overview', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  await seed(nis2IncidentsRepo);
  const res = await request(makeApp({ nis2IncidentsRepo }))
    .get('/api/nis2/deadlines').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.total, 1); // only the duty-bearing incident
  assert.equal(res.body.summary.overdue, 1);
  assert.equal(res.body.incidents[0].title, 'Significant breach');
});

test('GET /api/nis2/deadlines requires auth (401)', async () => {
  assert.equal((await request(makeApp()).get('/api/nis2/deadlines')).status, 401);
});

test('GET /api/nis2/incidents/:id includes deadlines', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  await seed(nis2IncidentsRepo);
  const res = await request(makeApp({ nis2IncidentsRepo }))
    .get('/api/nis2/incidents/1').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.ok(res.body.deadlines);
  assert.equal(res.body.deadlines.applicable, true);
});
