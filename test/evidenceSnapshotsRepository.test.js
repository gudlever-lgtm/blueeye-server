'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');

const { createEvidenceSnapshotsRepository, mapMeta } = require('../src/repositories/evidenceSnapshotsRepository');

// A minimal fake pool: returns canned rows and records the last SQL + params.
function fakePool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return handler(sql, params, calls.length);
    },
  };
}

test('create opens a pending snapshot and returns the new id', async () => {
  const pool = fakePool(() => [{ insertId: 42 }]);
  const repo = createEvidenceSnapshotsRepository({ pool });
  const id = await repo.create({ clusterId: 5, target: '10', commandSetVersion: 'evidence-v1', capturedAt: new Date('2026-07-01T12:00:00Z'), trigger: 'auto' });
  assert.equal(id, 42);
  assert.match(pool.calls[0].sql, /INSERT INTO cluster_evidence_snapshots/);
  assert.match(pool.calls[0].sql, /'pending'/);
  assert.equal(pool.calls[0].params[0], 5);
  assert.equal(pool.calls[0].params[1], '10');
  // `trigger` is a MySQL reserved word — it MUST be backticked in the column list,
  // or CREATE/INSERT fail at runtime (regression: migrate.js exited 1 on deploy).
  assert.match(pool.calls[0].sql, /`trigger`/);
  assert.doesNotMatch(pool.calls[0].sql, /[,(]\s*trigger\b/);
});

test('reserved-word `trigger` is backticked in the metadata SELECT (findById/listForCluster)', async () => {
  const pool = fakePool(() => [[]]);
  const repo = createEvidenceSnapshotsRepository({ pool });
  await repo.findById(1);
  await repo.listForCluster(1);
  for (const call of pool.calls) {
    assert.match(call.sql, /`trigger`/, 'the SELECT column list must backtick `trigger`');
    assert.doesNotMatch(call.sql, /,\s*trigger\b/, 'no un-backticked `trigger` identifier');
  }
});

test('complete gzips the payload text and records byte length', async () => {
  let stored = null;
  const pool = fakePool((sql, params) => { stored = params; return [{ affectedRows: 1 }]; });
  const repo = createEvidenceSnapshotsRepository({ pool });
  const text = '# agent.state [ok]\nconnected: yes';
  const ok = await repo.complete(7, { status: 'complete', items: [{ name: 'agent.state', status: 'ok' }], payloadText: text });
  assert.equal(ok, true);
  // params: [status, itemsJson, gzipBuffer, bytes, id]
  const gz = stored[2];
  assert.ok(Buffer.isBuffer(gz));
  assert.equal(zlib.gunzipSync(gz).toString('utf8'), text);
  assert.equal(stored[3], Buffer.byteLength(text, 'utf8'));
  assert.equal(stored[4], 7);
});

test('getPayload gunzips the stored blob back to text', async () => {
  const text = 'hello evidence';
  const gz = zlib.gzipSync(Buffer.from(text, 'utf8'));
  const pool = fakePool(() => [[{ payload_gzip: gz }]]);
  const repo = createEvidenceSnapshotsRepository({ pool });
  assert.equal(await repo.getPayload(1), text);
});

test('getPayload returns null for a missing row and empty for a null blob', async () => {
  const missing = createEvidenceSnapshotsRepository({ pool: fakePool(() => [[]]) });
  assert.equal(await missing.getPayload(9), null);
  const nullBlob = createEvidenceSnapshotsRepository({ pool: fakePool(() => [[{ payload_gzip: null }]]) });
  assert.equal(await nullBlob.getPayload(9), '');
});

test('ageOut protects the given cluster ids from deletion', async () => {
  const pool = fakePool(() => [{ affectedRows: 3 }]);
  const repo = createEvidenceSnapshotsRepository({ pool });
  const cutoff = new Date('2026-04-01T00:00:00Z');
  const deleted = await repo.ageOut(cutoff, { protectedClusterIds: [1, 2, 2] });
  assert.equal(deleted, 3);
  assert.match(pool.calls[0].sql, /DELETE FROM cluster_evidence_snapshots/);
  assert.match(pool.calls[0].sql, /NOT IN/);
  // cutoff + the de-duplicated protected ids
  assert.deepEqual(pool.calls[0].params, [cutoff, 1, 2]);
});

test('mapMeta never leaks the blob and coerces ids/dates', () => {
  const meta = mapMeta({
    id: '3', cluster_id: '5', target: '10', command_set_version: 'evidence-v1',
    status: 'complete', items: JSON.stringify([{ name: 'agent.state', status: 'ok' }]),
    payload_bytes: '128', captured_at: new Date('2026-07-01T12:00:00Z'), trigger: 'auto',
    created_at: new Date('2026-07-01T12:00:00Z'),
  });
  assert.equal(meta.id, 3);
  assert.equal(meta.clusterId, 5);
  assert.equal(meta.payloadBytes, 128);
  assert.deepEqual(meta.items, [{ name: 'agent.state', status: 'ok' }]);
  assert.ok(!('payload' in meta) && !('payload_gzip' in meta));
});
