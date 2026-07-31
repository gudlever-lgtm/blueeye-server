'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeEventClustersRepo, makeAlertDispatchLogRepo, authHeader } = require('../test-support/fakes');

async function withCluster(over = {}) {
  const eventClustersRepo = makeEventClustersRepo();
  const alertDispatchLogRepo = makeAlertDispatchLogRepo();
  const id = await eventClustersRepo.create({ confidence: 'high', memberFindingIds: ['a', 'b'], status: over.status || 'open', detectedAt: new Date() });
  await eventClustersRepo.setItsmRef(id, { ticketRef: 'SNOW-42', integrationId: 1 });
  await alertDispatchLogRepo.record({ subjectType: 'cluster', subjectId: id, hostId: 'opened', metric: 'cluster.opened', severity: 'CRIT', sentAt: new Date() });
  const app = makeApp({ eventClustersRepo, alertDispatchLogRepo, ...over.appOverrides });
  return { app, id, eventClustersRepo };
}

test('GET /:id/notifications returns ticket ref + alert history (viewer+) → 200', async () => {
  const { app, id } = await withCluster();
  const res = await request(app).get(`/api/event-clusters/${id}/notifications`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.itsmTicketRef, 'SNOW-42');
  assert.equal(res.body.alerts.length, 1);
  assert.equal(res.body.alerts[0].event, 'opened');
});

test('GET /:id/notifications requires auth → 401', async () => {
  const { app, id } = await withCluster();
  assert.equal((await request(app).get(`/api/event-clusters/${id}/notifications`)).status, 401);
});

test('GET /:id/notifications 400 on a bad id', async () => {
  const { app } = await withCluster();
  const res = await request(app).get('/api/event-clusters/abc/notifications').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /:id/notifications 404 for an unknown cluster', async () => {
  const { app } = await withCluster();
  const res = await request(app).get('/api/event-clusters/99999/notifications').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /:id/notifications clean 500 on repo failure', async () => {
  const eventClustersRepo = makeEventClustersRepo({ findById: async () => { throw new Error('db boom'); } });
  const app = makeApp({ eventClustersRepo });
  const res = await request(app).get('/api/event-clusters/1/notifications').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  assert.ok(!/boom/.test(String(res.body.error)));
});

test('POST /:id/resolve fires ONE resolution notification with the note', async () => {
  const notified = [];
  const clusterNotifier = { notify: async (ev) => { notified.push(ev); } };
  const eventClustersRepo = makeEventClustersRepo();
  const id = await eventClustersRepo.create({ confidence: 'high', memberFindingIds: ['a'], status: 'open', detectedAt: new Date() });
  const app = makeApp({ eventClustersRepo, clusterNotifier });
  const res = await request(app).post(`/api/event-clusters/${id}/resolve`).set('Authorization', authHeader('operator')).send({ note: 'carrier fixed the WAN' });
  assert.equal(res.status, 200);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].event, 'resolved');
  assert.equal(notified[0].cluster.resolutionNote, 'carrier fixed the WAN');
});
