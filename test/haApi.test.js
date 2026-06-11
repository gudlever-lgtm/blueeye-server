'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFeatureGate, makeHaCoordinator, authHeader } = require('../test-support/fakes');

// ---- GET /api/ha/status -----------------------------------------------------

test('GET /api/ha/status returns this node role for an authenticated user', async () => {
  const res = await request(makeApp()).get('/api/ha/status').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'leader');
  assert.equal(res.body.isLeader, true);
  assert.equal(res.body.nodeId, 'test-node');
});

test('HA status requires authentication (401)', async () => {
  const res = await request(makeApp()).get('/api/ha/status');
  assert.equal(res.status, 401);
});

test('HA endpoints are gated by ha_deployment (403 feature_not_available)', async () => {
  const featureGate = makeFeatureGate({ isFeatureEnabled: (f) => f !== 'ha_deployment' });
  const res = await request(makeApp({ featureGate })).get('/api/ha/status').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'feature_not_available');
  assert.equal(res.body.feature, 'ha_deployment');
});

// ---- GET /api/ha/nodes ------------------------------------------------------

test('GET /api/ha/nodes lists the cluster topology', async () => {
  const res = await request(makeApp()).get('/api/ha/nodes').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.nodes));
  assert.equal(res.body.nodes[0].node_id, 'test-node');
});

// ---- POST /api/ha/step-down -------------------------------------------------

test('step-down requires admin (operator → 403)', async () => {
  const res = await request(makeApp()).post('/api/ha/step-down').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 403);
});

test('step-down on a standalone node returns 409 cannot_step_down', async () => {
  // The default fake coordinator is HA-off → cannot step down.
  const res = await request(makeApp()).post('/api/ha/step-down').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'cannot_step_down');
  assert.equal(res.body.reason, 'ha_disabled');
});

test('step-down succeeds on an HA leader (200)', async () => {
  const haCoordinator = makeHaCoordinator({
    status: { enabled: true, role: 'leader', isLeader: true, lockName: 'blueeye_leader' },
    stepDown: async () => ({ ok: true }),
  });
  const res = await request(makeApp({ haCoordinator })).post('/api/ha/step-down').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.status);
});

test('step-down by a follower returns 409 not_leader', async () => {
  const haCoordinator = makeHaCoordinator({
    status: { enabled: true, role: 'follower', isLeader: false },
    stepDown: async () => ({ ok: false, reason: 'not_leader' }),
  });
  const res = await request(makeApp({ haCoordinator })).post('/api/ha/step-down').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'not_leader');
});
