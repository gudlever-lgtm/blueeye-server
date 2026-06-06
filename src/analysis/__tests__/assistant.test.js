'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAssistant, FeatureDisabledError } = require('../assistant');
const { loadConfig } = require('../config');

const ENABLED = {
  assistantEnabled: true,
  assistantApiKey: 'k-123',
  assistantModel: 'mistral-small-latest',
  assistantBaseUrl: 'https://api.example/v1/chat',
  assistantMaxFindings: 20,
  assistantTimeoutMs: 5000,
};

// A mock fetch that records its calls and returns a fixed OK JSON body.
function okFetch(body) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => body };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const findings = (rows = []) => ({ list: async () => rows });

test('explain throws FeatureDisabled when the assistant is off', async () => {
  const a = createAssistant({ config: { assistantEnabled: false }, findingStore: findings() });
  await assert.rejects(() => a.explain('hello', 'h1'), (e) => e.name === 'FeatureDisabled');
  assert.equal(a.isEnabled(), false);
});

test('FeatureDisabledError carries the documented name', () => {
  assert.equal(new FeatureDisabledError().name, 'FeatureDisabled');
});

test('explain rejects an empty/missing question (when enabled)', async () => {
  const a = createAssistant({ config: ENABLED, findingStore: findings(), fetchImpl: okFetch({}) });
  await assert.rejects(() => a.explain('   ', 'h1'), (e) => e.name === 'InvalidQuestion');
  await assert.rejects(() => a.explain(null, 'h1'), (e) => e.name === 'InvalidQuestion');
});

test('explain throws AssistantMisconfigured when enabled without an API key', async () => {
  const a = createAssistant({ config: { ...ENABLED, assistantApiKey: '' }, findingStore: findings(), fetchImpl: okFetch({}) });
  await assert.rejects(() => a.explain('what is happening?', 'h1'), (e) => e.name === 'AssistantMisconfigured');
});

test('explain returns the trimmed answer and the context it used', async () => {
  const rows = [
    { metric: 'cpu', severity: 'CRIT', kind: 'ANOMALY', observed: 99, baseline: 10, deviation: 8, explanation: 'cpu-spike-evidence', correlatedWith: [], createdAt: new Date('2026-01-01T00:00:00Z') },
  ];
  const fetchImpl = okFetch({ choices: [{ message: { content: '  CPU is overloaded.  ' } }] });
  const a = createAssistant({ config: ENABLED, findingStore: findings(rows), fetchImpl });

  const out = await a.explain('why is cpu high?', 'h7');
  assert.equal(out.answer, 'CPU is overloaded.');
  assert.equal(out.model, 'mistral-small-latest');
  assert.equal(out.usedFindings, 1);

  // The provider was called with the key, the model and our compact context.
  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, ENABLED.assistantBaseUrl);
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers.Authorization, 'Bearer k-123');
  const sent = JSON.parse(opts.body);
  assert.equal(sent.model, 'mistral-small-latest');
  const userMsg = sent.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('why is cpu high?')); // the question
  assert.ok(userMsg.content.includes('cpu-spike-evidence')); // the finding context
});

test('explain raises AssistantUpstreamError on a non-OK provider response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const a = createAssistant({ config: ENABLED, findingStore: findings(), fetchImpl });
  await assert.rejects(() => a.explain('q', 'h1'), (e) => e.name === 'AssistantUpstreamError' && /500/.test(e.message));
});

test('explain raises AssistantUpstreamError when the network call rejects', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const a = createAssistant({ config: ENABLED, findingStore: findings(), fetchImpl });
  await assert.rejects(() => a.explain('q', 'h1'), (e) => e.name === 'AssistantUpstreamError');
});

test('explainDiagnostic is gated when off, and forwards only a bounded snapshot when on', async () => {
  const off = createAssistant({ config: { assistantEnabled: false }, findingStore: findings() });
  await assert.rejects(() => off.explainDiagnostic({ source: 'sflow' }, 'h1'), (e) => e.name === 'FeatureDisabled');
  await assert.rejects(() => off.explainDiagnostic({ source: 'sflow' }, 'h1'), (e) => e.name === 'FeatureDisabled');

  const fetchImpl = okFetch({ choices: [{ message: { content: 'No exporter is sending to the collector.' } }] });
  const a = createAssistant({ config: ENABLED, findingStore: findings([]), fetchImpl });
  const diagnostic = {
    source: 'sflow',
    collector: { kind: 'sflow', listening: true, datagrams: 0, decodedFlows: 0, bufferedFlows: 0 },
    hsflowd: { state: 'inactive', detail: 'not enabled' },
    secret: 'should-not-be-forwarded',
  };
  const out = await a.explainDiagnostic(diagnostic, 'h7');
  assert.equal(out.answer, 'No exporter is sending to the collector.');
  assert.equal(out.model, 'mistral-small-latest');

  const sent = JSON.parse(fetchImpl.calls[0].opts.body);
  const userMsg = sent.messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('sflow')); // the snapshot source
  assert.ok(userMsg.content.includes('datagrams')); // collector counters forwarded
  assert.ok(!userMsg.content.includes('should-not-be-forwarded')); // bounded: unknown fields dropped
});

test('buildContext caps to maxFindings, keeps only summary fields, survives store failure', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ metric: `m${i}`, explanation: 'x', evidence: [{ secret: 1 }], createdAt: new Date() }));
  const a = createAssistant({ config: { ...ENABLED, assistantMaxFindings: 5 }, findingStore: findings(many), fetchImpl: okFetch({}) });
  const ctx = await a.buildContext('h1');
  assert.equal(ctx.length, 5);
  assert.ok(Object.prototype.hasOwnProperty.call(ctx[0], 'explanation'));
  assert.ok(!Object.prototype.hasOwnProperty.call(ctx[0], 'evidence')); // raw payloads omitted

  const boom = createAssistant({ config: ENABLED, findingStore: { list: async () => { throw new Error('db down'); } }, fetchImpl: okFetch({}) });
  assert.deepEqual(await boom.buildContext('h1'), []); // failure -> empty context, no throw
});

test('loadConfig exposes assistant defaults (off, Mistral) and honours overrides', () => {
  const d = loadConfig({});
  assert.equal(d.assistantEnabled, false);
  assert.equal(d.assistantApiKey, '');
  assert.equal(d.assistantModel, 'mistral-small-latest');
  assert.match(d.assistantBaseUrl, /mistral/);
  assert.equal(d.assistantMaxFindings, 20);

  const o = loadConfig({
    ANALYSIS_ASSISTANT_ENABLED: 'true',
    MISTRAL_API_KEY: 'env-key',
    ANALYSIS_ASSISTANT_MODEL: 'mistral-large-latest',
    ANALYSIS_ASSISTANT_MAX_FINDINGS: '3',
  });
  assert.equal(o.assistantEnabled, true);
  assert.equal(o.assistantApiKey, 'env-key');
  assert.equal(o.assistantModel, 'mistral-large-latest');
  assert.equal(o.assistantMaxFindings, 3);
});
