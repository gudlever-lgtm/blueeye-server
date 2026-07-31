'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEventCaseService } = require('../src/eventCases/eventCaseService');
const { createConfigSnapshotsRepository } = require('../src/repositories/configSnapshotsRepository');
const { makeEventCasesRepo, makeFindingStore, makeConfigSnapshotsRepo } = require('../test-support/fakes');

const T0 = new Date('2026-06-01T10:00:00Z');
const finding = (over = {}) => ({ id: 'a1', hostId: '9', metric: 'cpu', severity: 'CRIT', createdAt: T0, ...over });

function svc({ configSnapshotsRepo, configWindowMs } = {}) {
  const eventCasesRepo = makeEventCasesRepo();
  const findingStore = makeFindingStore();
  const s = createEventCaseService({ eventCasesRepo, findingStore, configSnapshotsRepo, configWindowMs });
  return { s, eventCasesRepo };
}

test('a config change WITHIN the window (before the anomaly) is linked to the event', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  const cid = await configSnapshotsRepo.insert({ deviceId: 9, configText: 'x', capturedVia: 'manual', capturedAt: new Date('2026-06-01T09:45:00Z') }); // 15m before
  const { s, eventCasesRepo } = svc({ configSnapshotsRepo });
  const r = await s.assignFinding(finding());
  assert.equal(eventCasesRepo.rows.find((x) => x.id === r.eventCaseId).config_change_id, cid);
});

test('a config change OUTSIDE the window (too old) is NOT linked', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  await configSnapshotsRepo.insert({ deviceId: 9, configText: 'x', capturedVia: 'manual', capturedAt: new Date('2026-06-01T09:00:00Z') }); // 60m before, window default 30m
  const { s, eventCasesRepo } = svc({ configSnapshotsRepo });
  const r = await s.assignFinding(finding());
  assert.equal(eventCasesRepo.rows.find((x) => x.id === r.eventCaseId).config_change_id, null);
});

test('a config change AFTER the anomaly is NOT linked (only changes before count)', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  await configSnapshotsRepo.insert({ deviceId: 9, configText: 'x', capturedVia: 'manual', capturedAt: new Date('2026-06-01T10:05:00Z') }); // after T0
  const { s, eventCasesRepo } = svc({ configSnapshotsRepo });
  const r = await s.assignFinding(finding());
  assert.equal(eventCasesRepo.rows.find((x) => x.id === r.eventCaseId).config_change_id, null);
});

test('the window is configurable (60m picks up a 45m-old change)', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  const cid = await configSnapshotsRepo.insert({ deviceId: 9, configText: 'x', capturedVia: 'manual', capturedAt: new Date('2026-06-01T09:15:00Z') }); // 45m before
  const { s, eventCasesRepo } = svc({ configSnapshotsRepo, configWindowMs: 60 * 60 * 1000 });
  const r = await s.assignFinding(finding());
  assert.equal(eventCasesRepo.rows.find((x) => x.id === r.eventCaseId).config_change_id, cid);
});

test('the first correlated change wins (a later anomaly does not overwrite it)', async () => {
  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  const first = await configSnapshotsRepo.insert({ deviceId: 9, configText: 'x', capturedVia: 'manual', capturedAt: new Date('2026-06-01T09:45:00Z') });
  await configSnapshotsRepo.insert({ deviceId: 9, configText: 'y', capturedVia: 'manual', capturedAt: new Date('2026-06-01T10:20:00Z') });
  const { s, eventCasesRepo } = svc({ configSnapshotsRepo });
  const r1 = await s.assignFinding(finding({ id: 'a1', createdAt: T0 }));
  // a second anomaly 25m later (same event, still within grouping window? grouping=60s, so new event)
  await s.assignFinding(finding({ id: 'a2', createdAt: new Date('2026-06-01T10:00:30Z') }));
  assert.equal(eventCasesRepo.rows.find((x) => x.id === r1.eventCaseId).config_change_id, first);
});

test('correlation is a no-op when no config repo is wired', async () => {
  const { s, eventCasesRepo } = svc();
  const r = await s.assignFinding(finding());
  assert.equal(eventCasesRepo.rows.find((x) => x.id === r.eventCaseId).config_change_id, null);
});

test('repository setConfigChange is guarded to only set when NULL', async () => {
  let step = 0;
  const pool = { async query(sql, params) {
    step += 1;
    assert.match(sql, /config_change_id = \?\s+WHERE id = \? AND config_change_id IS NULL/);
    assert.deepEqual(params, [7, 3]);
    return [{ affectedRows: step === 1 ? 1 : 0 }];
  } };
  const repo = require('../src/repositories/eventCasesRepository').createEventCasesRepository({ pool });
  assert.equal(await repo.setConfigChange(3, 7), true);
  assert.equal(await repo.setConfigChange(3, 7), false); // already set
});

test('configSnapshots.latestForDeviceBetween binds an exclusive-from / inclusive-to window', async () => {
  const pool = { async query(sql, params) {
    assert.match(sql, /captured_at > \? AND captured_at <= \?/);
    assert.match(sql, /ORDER BY captured_at DESC, id DESC LIMIT 1/);
    assert.deepEqual(params, [9, 'FROM', 'TO']);
    return [[]];
  } };
  const repo = createConfigSnapshotsRepository({ pool });
  assert.equal(await repo.latestForDeviceBetween(9, 'FROM', 'TO'), null);
});
