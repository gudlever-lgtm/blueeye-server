'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAssistant, authHeader } = require('../test-support/fakes');

const viewer = () => authHeader('viewer');

test('POST /api/assistant/explain returns 403 while the feature is disabled', async () => {
  // The default fake assistant is disabled -> the endpoint exists but answers 403.
  const res = await request(makeApp())
    .post('/api/assistant/explain').set('Authorization', viewer())
    .send({ question: 'what is happening?' });
  assert.equal(res.status, 403);
});

test('POST /api/assistant/explain returns 400 for an empty question', async () => {
  const res = await request(makeApp())
    .post('/api/assistant/explain').set('Authorization', viewer())
    .send({ question: '   ' });
  assert.equal(res.status, 400);
});

test('POST /api/assistant/explain returns 400 when the question is missing', async () => {
  const res = await request(makeApp())
    .post('/api/assistant/explain').set('Authorization', viewer())
    .send({});
  assert.equal(res.status, 400);
});

test('POST /api/assistant/explain without a token returns 401', async () => {
  const res = await request(makeApp()).post('/api/assistant/explain').send({ question: 'hello' });
  assert.equal(res.status, 401);
});

test('POST /api/assistant/explain returns 200 with the answer when enabled', async () => {
  const assistant = makeAssistant({
    explain: async (q, hostId) => ({ answer: `answer to ${q} (${hostId})`, model: 'mistral-small-latest', usedFindings: 2 }),
  });
  const res = await request(makeApp({ assistant }))
    .post('/api/assistant/explain').set('Authorization', viewer())
    .send({ question: 'why is cpu high?', hostId: '7' });
  assert.equal(res.status, 200);
  assert.match(res.body.answer, /why is cpu high/);
  assert.match(res.body.answer, /\(7\)/); // hostId threaded through
  assert.equal(res.body.usedFindings, 2);
});

test('POST /api/assistant/explain returns 500 when the provider call fails', async () => {
  const assistant = makeAssistant({
    explain: async () => { const e = new Error('upstream blew up'); e.name = 'AssistantUpstreamError'; throw e; },
  });
  const res = await request(makeApp({ assistant }))
    .post('/api/assistant/explain').set('Authorization', viewer())
    .send({ question: 'q' });
  assert.equal(res.status, 500);
});

test('an unknown assistant sub-path returns 404', async () => {
  const res = await request(makeApp())
    .post('/api/assistant/nope').set('Authorization', viewer())
    .send({ question: 'q' });
  assert.equal(res.status, 404);
});
