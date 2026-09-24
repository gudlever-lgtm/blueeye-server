'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFlowPipeline } = require('../flowPipeline');
const { createGeoEnricher } = require('../enricher');
const { createGeoProvider } = require('../provider');
const { createCentroids } = require('../centroids');
const { ipv4ToInt } = require('../privateIp');

function buildEnricher() {
  const provider = createGeoProvider({ ranges: [
    { lo: ipv4ToInt('8.8.8.0'), hi: ipv4ToInt('8.8.8.255'), country: 'US', asn: 15169, asnName: 'GOOGLE' },
  ] });
  return createGeoEnricher({ provider, centroids: createCentroids() });
}

function fakeRepo() {
  const rows = [];
  return { rows, insertMany: async (recs) => { for (const r of recs) rows.push(r); return recs.length; } };
}

const payload = (flows) => ({ traffic: { flows } });

test('extracts, enriches and stores flow records', async () => {
  const flowsRepo = fakeRepo();
  const pipe = createFlowPipeline({ flowsRepo, enricher: buildEnricher(), config: { geoEnabled: true } });
  const n = await pipe.processResults(9, [payload([
    { srcIp: '10.0.0.5', dstIp: '8.8.8.8', bytes: 100 },
    { srcIp: '10.0.0.5', dstIp: '10.0.0.9', bytes: 50 }, // internal
  ])]);
  assert.equal(n, 2);
  const ext = flowsRepo.rows.find((r) => r.dstIp === '8.8.8.8');
  const internal = flowsRepo.rows.find((r) => r.dstIp === '10.0.0.9');
  assert.equal(ext.country, 'US');
  assert.equal(ext.agentId, 9);
  assert.equal(internal.internal, true);
  assert.equal(internal.country, null);
});

test('the geo flag off stores nothing', async () => {
  const flowsRepo = fakeRepo();
  const pipe = createFlowPipeline({ flowsRepo, enricher: buildEnricher(), config: { geoEnabled: false } });
  const n = await pipe.processResults(9, [payload([{ srcIp: '10.0.0.5', dstIp: '8.8.8.8' }])]);
  assert.equal(n, 0);
  assert.equal(flowsRepo.rows.length, 0);
});

test('payloads without flows store nothing', async () => {
  const flowsRepo = fakeRepo();
  const pipe = createFlowPipeline({ flowsRepo, enricher: buildEnricher(), config: { geoEnabled: true } });
  assert.equal(await pipe.processResults(9, [{ system: { cpuPercent: 5 } }]), 0);
});

test('a repository failure is swallowed (best-effort), returns 0', async () => {
  const flowsRepo = { insertMany: async () => { throw new Error('db down'); } };
  const pipe = createFlowPipeline({ flowsRepo, enricher: buildEnricher(), config: { geoEnabled: true } });
  const n = await pipe.processResults(9, [payload([{ srcIp: '10.0.0.5', dstIp: '8.8.8.8' }])]);
  assert.equal(n, 0); // did not throw
});

test('the VLAN and in/out ifIndex survive enrichment and reach the store', async () => {
  const flowsRepo = fakeRepo();
  const pipe = createFlowPipeline({ flowsRepo, enricher: buildEnricher(), config: { geoEnabled: true } });
  await pipe.processResults(9, [payload([
    { srcIp: '10.0.0.5', dstIp: '8.8.8.8', bytes: 100, vlan: 20, inIf: 3, outIf: 49 },
    { srcIp: '10.0.0.5', dstIp: '10.0.0.9', bytes: 50 },
  ])]);
  const ext = flowsRepo.rows.find((r) => r.dstIp === '8.8.8.8');
  assert.deepEqual([ext.vlan, ext.inIf, ext.outIf, ext.country], [20, 3, 49, 'US']);
  const internal = flowsRepo.rows.find((r) => r.dstIp === '10.0.0.9');
  assert.deepEqual([internal.vlan, internal.inIf, internal.outIf], [null, null, null]);
});
