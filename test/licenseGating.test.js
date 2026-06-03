'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeFeatureGate, makeAssistant, makeDispatcher, makeFindingStore, authHeader } = require('../test-support/fakes');
const { createAnalysisPipeline } = require('../src/analysis/pipeline');
const { createDispatcher } = require('../src/analysis/alerting/dispatcher');
const { loadConfig } = require('../src/analysis/config');

const viewer = () => authHeader('viewer');
const gateMissing = (feature) => makeFeatureGate({ features: { analysis: true, assistant: true, alerting: true, geo: true, [feature]: false } });

// ---- GET /license/features -------------------------------------------------
test('GET /license/features reflects the license entitlements', async () => {
  const featureGate = makeFeatureGate({ features: { analysis: true, assistant: false, alerting: false, geo: true } });
  const res = await request(makeApp({ featureGate })).get('/license/features').set('Authorization', viewer());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { analysis: true, assistant: false, alerting: false, geo: true });
});

// ---- assistant: license vs config -----------------------------------------
test('assistant returns 403 (license) when the feature is not licensed — independent of config', async () => {
  // A fully working assistant, but the license does not include it.
  const assistant = makeAssistant({ explain: async () => ({ answer: 'hello', model: 'm', usedFindings: 0 }) });
  const app = makeApp({ assistant, featureGate: gateMissing('assistant') });
  const res = await request(app).post('/api/assistant/explain').set('Authorization', viewer()).send({ question: 'what is happening?' });
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'license');
  assert.match(res.body.error, /license/i);
});

test('assistant licensed but switched off in config -> 403 with the "off" message, not a license error', async () => {
  // Default featureGate = allow-all (licensed); default assistant = disabled in config.
  const res = await request(makeApp()).post('/api/assistant/explain').set('Authorization', viewer()).send({ question: 'what is happening?' });
  assert.equal(res.status, 403);
  assert.notEqual(res.body.reason, 'license');
  assert.match(res.body.error, /disabled/i);
});

// ---- geo --------------------------------------------------------------------
test('geo endpoints return 403 (license) when geo is not licensed', async () => {
  const app = makeApp({ featureGate: gateMissing('geo') });
  const res = await request(app).get('/api/geo/overview').set('Authorization', viewer());
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'license');
});

test('geo still requires auth before the license check (401 without a token)', async () => {
  const res = await request(makeApp({ featureGate: gateMissing('geo') })).get('/api/geo/overview');
  assert.equal(res.status, 401);
});

// ---- analysis pipeline ------------------------------------------------------
test('analysis pipeline produces nothing when analysis is not licensed', async () => {
  const detector = { evaluate: () => ({ id: 'x', hostId: '9', metric: 'cpu', severity: 'CRIT', kind: 'ANOMALY', explanation: 'x', evidence: [{}], createdAt: new Date() }) };
  const extract = () => [{ hostId: '9', metric: 'cpu', value: 1, ts: new Date() }];
  const pipe = createAnalysisPipeline({
    detector, findingStore: makeFindingStore(), extract,
    config: { ...loadConfig({}), analysisEnabled: true },
    licensed: () => false, // license does not include analysis
  });
  const produced = await pipe.processResults('9', [{}]);
  assert.equal(produced.length, 0);
});

// ---- alerting dispatcher ----------------------------------------------------
test('dispatcher skips all channels when alerting is not licensed', async () => {
  const calls = [];
  const channel = { send: async () => { calls.push(1); return { ok: true }; } };
  const dispatcher = createDispatcher({
    config: { enabled: true, cooldownMs: 0, channels: { syslog: { enabled: true, minSeverity: 'INFO' } } },
    channels: { syslog: channel },
    licensed: () => false,
  });
  const res = await dispatcher.dispatch({ hostId: '9', metric: 'cpu', kind: 'ANOMALY', severity: 'CRIT' });
  assert.equal(res.reason, 'unlicensed');
  assert.equal(calls.length, 0);
});
