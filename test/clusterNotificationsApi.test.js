'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeIncidentClustersRepo, makeAlertDispatchLogRepo, authHeader } = require('../test-support/fakes');

async function withCluster(over = {}) {
  const incidentClustersRepo = makeIncidentClustersRepo();
  const alertDispatchLogRepo = makeAlertDispatchLogRepo();
  const id = await incidentClustersRepo.create({ confidence: 'high', memberFindingIds: ['a', 'b'], status: over.status || 'open', detectedAt: new Date() });
  await incidentClustersRepo.setItsmRef(id, { ticketRef: 'SNOW-42', integrationId: 1 });
  await alertDispatchLogRepo.record({ subjectType: 'cluster', subjectId: id, hostId: 'opened', metric: 'cluster.opened', severity: 'CRIT', sentAt: new Date() });
  const app = makeApp({ incidentClustersRepo, alertDispatchLogRepo, ...over.appOverrides });
  return { app, id, incidentClustersRepo };
}

test('GET /:id/notifications returns ticket ref + alert history (viewer+) → 200', async () => {
  const { app, id } = await withCluster();
  const res = await request(app).get(`/api/incident-clusters/${id}/notifications`).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.itsmTicketRef, 'SNOW-42');
  assert.equal(res.body.alerts.length, 1);
  assert.equal(res.body.alerts[0].event, 'opened');
});

test('GET /:id/notifications requires auth → 401', async () => {
  const { app, id } = await withCluster();
  assert.equal((await request(app).get(`/api/incident-clusters/${id}/notifications`)).status, 401);
});

test('GET /:id/notifications 400 on a bad id', async () => {
  const { app } = await withCluster();
  const res = await request(app).get('/api/incident-clusters/abc/notifications').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /:id/notifications 404 for an unknown cluster', async () => {
  const { app } = await withCluster();
  const res = await request(app).get('/api/incident-clusters/99999/notifications').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

test('GET /:id/notifications clean 500 on repo failure', async () => {
  const incidentClustersRepo = makeIncidentClustersRepo({ findById: async () => { throw new Error('db boom'); } });
  const app = makeApp({ incidentClustersRepo });
  const res = await request(app).get('/api/incident-clusters/1/notifications').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  assert.ok(!/boom/.test(String(res.body.error)));
});

test('POST /:id/resolve fires ONE resolution notification with the note', async () => {
  const notified = [];
  const clusterNotifier = { notify: async (ev) => { notified.push(ev); } };
  const incidentClustersRepo = makeIncidentClustersRepo();
  const id = await incidentClustersRepo.create({ confidence: 'high', memberFindingIds: ['a'], status: 'open', detectedAt: new Date() });
  const app = makeApp({ incidentClustersRepo, clusterNotifier });
  const res = await request(app).post(`/api/incident-clusters/${id}/resolve`).set('Authorization', authHeader('operator')).send({ note: 'carrier fixed the WAN' });
  assert.equal(res.status, 200);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].event, 'resolved');
  assert.equal(notified[0].cluster.resolutionNote, 'carrier fixed the WAN');
});
