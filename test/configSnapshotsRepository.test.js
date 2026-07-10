'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createConfigSnapshotsRepository } = require('../src/repositories/configSnapshotsRepository');

function fakePool(handler) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return handler(sql, params, calls.length); } };
}

test('insert without captured_at lets SQL default it, returns the new id', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /INSERT INTO config_snapshots \(device_id, config_text, captured_via\)/);
    assert.deepEqual(params, [9, 'hostname r1', 'manual']);
    return [{ insertId: 3 }];
  });
  const repo = createConfigSnapshotsRepository({ pool });
  const id = await repo.insert({ deviceId: 9, configText: 'hostname r1' });
  assert.equal(id, 3);
});

test('insert with an explicit captured_at binds it', async () => {
  const at = new Date('2026-06-01T08:00:00Z');
  const pool = fakePool((sql, params) => {
    assert.match(sql, /captured_via, captured_at/);
    assert.deepEqual(params, [9, 'cfg', 'agent_poll', at]);
    return [{ insertId: 5 }];
  });
  const repo = createConfigSnapshotsRepository({ pool });
  assert.equal(await repo.insert({ deviceId: 9, configText: 'cfg', capturedVia: 'agent_poll', capturedAt: at }), 5);
});

test('findById returns the row incl. config_text, mapped', async () => {
  const pool = fakePool(() => [[{
    id: 7, device_id: 9, config_text: 'hostname r1', captured_at: new Date('2026-06-01T08:00:00Z'),
    captured_via: 'manual', created_at: new Date('2026-06-01T08:00:00Z'),
  }]]);
  const repo = createConfigSnapshotsRepository({ pool });
  const row = await repo.findById(7);
  assert.equal(row.id, 7);
  assert.equal(row.deviceId, 9);
  assert.equal(row.configText, 'hostname r1');
  assert.equal(row.capturedVia, 'manual');
});

test('findById returns null when missing', async () => {
  const repo = createConfigSnapshotsRepository({ pool: fakePool(() => [[]]) });
  assert.equal(await repo.findById(1), null);
});

test('listForDevice defaults to metadata only (no config_text) newest-first', async () => {
  const pool = fakePool((sql, params) => {
    assert.doesNotMatch(sql, /config_text/);
    assert.match(sql, /ORDER BY captured_at DESC, id DESC/);
    assert.deepEqual(params, [9, 50]);
    return [[{ id: 2, device_id: 9, captured_at: new Date('2026-06-01T09:00:00Z'), captured_via: 'manual', created_at: new Date() }]];
  });
  const repo = createConfigSnapshotsRepository({ pool });
  const rows = await repo.listForDevice(9);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].configText, undefined); // metadata-only omits text
});

test('listForDevice withText selects config_text', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /config_text FROM config_snapshots/);
    return [[]];
  });
  const repo = createConfigSnapshotsRepository({ pool });
  await repo.listForDevice(9, { withText: true });
});

test('previousBefore selects the row just before the given snapshot for the device', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /\(captured_at, id\) < \(SELECT captured_at, id FROM config_snapshots WHERE id = \?\)/);
    assert.match(sql, /ORDER BY captured_at DESC, id DESC LIMIT 1/);
    assert.deepEqual(params, [9, 7, 7]);
    return [[{ id: 6, device_id: 9, config_text: 'old', captured_at: new Date('2026-06-01T07:00:00Z'), captured_via: 'manual', created_at: new Date() }]];
  });
  const repo = createConfigSnapshotsRepository({ pool });
  const prev = await repo.previousBefore(9, 7);
  assert.equal(prev.id, 6);
  assert.equal(prev.configText, 'old');
});
