'use strict';

// Storage for the V3 intelligence layer: observations, and the incident
// lifecycle and timeline that migration 090 added.
//
// Same approach as the other repository specs — a scripted pool, so what is
// asserted is the statement issued and the parameters bound rather than that a
// hand-rolled SQL engine agrees with itself. The statements are ALSO run against
// a real MySQL by scripts/verify-schema-against-mysql.js' sibling check, which
// is the only thing that can say the SQL is valid.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakePool, ok, rows } = require('./fakePool');
const { createObservationsRepository } = require('../observationsRepository');
const { createIncidentsRepository } = require('../incidentsRepository');
const { TRANSITIONS } = require('../../incidents/lifecycle');

const NOW = new Date('2026-09-12T12:00:00.000Z');
const now = () => NOW;

const OBS = (over = {}) => ({
  layer: 'api', kind: 'api.call', subject: 'https://portal.kunde.dk/api/search',
  outcome: 'bad', value: 812, unit: 'ms', summary: 'GET /api/search → HTTP 500',
  detail: { status: 500 }, observed_at: null, ...over,
});

// ------------------------------------------------------------ observations
test('a run’s observations are written in ONE statement, not one each', () => {
  // A journey with forty API calls produces sixty-odd observations. Sixty round
  // trips per run would make the worker slower than the browser it drives.
  const pool = makeFakePool([[/^INSERT INTO service_observations/i, () => ok({ affectedRows: 3 })]]);
  const repo = createObservationsRepository({ db: { pool }, now });
  return repo.recordMany({ run_id: 7, test_id: 2, application_id: 1 }, [OBS(), OBS(), OBS()])
    .then((written) => {
      assert.equal(written, 3);
      const calls = pool.matching(/^INSERT INTO service_observations/i);
      assert.equal(calls.length, 1, `${calls.length} statements for 3 observations`);
      assert.equal((calls[0].sql.match(/\(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/g) || []).length, 3);
      assert.equal(calls[0].params.length, 3 * 14, 'placeholders and parameters must agree — this is the bug class that broke a deploy');
    });
});

test('nothing to write issues no statement at all', async () => {
  const pool = makeFakePool([[/^INSERT/i, () => ok()]]);
  const repo = createObservationsRepository({ db: { pool }, now });
  for (const input of [[], null, undefined, 'no', [null, 3]]) {
    assert.equal(await repo.recordMany({ run_id: 1 }, input), 0, String(input));
  }
  assert.equal(pool.matching(/^INSERT/i).length, 0);
});

test('an unrecognised layer or outcome lands somewhere valid rather than failing the batch', async () => {
  // Both columns are ENUMs. A typo would be coerced to '' by a lenient server or
  // reject the whole batch on a strict one, and one bad observation must not
  // cost the other fifty-nine.
  const pool = makeFakePool([[/^INSERT INTO service_observations/i, () => ok({ affectedRows: 1 })]]);
  const repo = createObservationsRepository({ db: { pool }, now });
  await repo.recordMany({ run_id: 1 }, [OBS({ layer: 'quantum', outcome: 'maybe' })]);
  const [call] = pool.matching(/^INSERT INTO service_observations/i);
  assert.equal(call.params[5], 'application');
  assert.equal(call.params[8], 'unknown');
});

test('a measurement nobody took is stored as null, never as zero', async () => {
  // Zero is never neutral for a duration: it is "instant", the good end of the
  // scale, so a missing measurement stored as 0 reads as good news.
  const pool = makeFakePool([[/^INSERT INTO service_observations/i, () => ok({ affectedRows: 1 })]]);
  const repo = createObservationsRepository({ db: { pool }, now });
  await repo.recordMany({ run_id: 1 }, [OBS({ value: '' }), OBS({ value: '   ' }), OBS({ value: null }), OBS({ value: 0 })]);
  const [call] = pool.matching(/^INSERT INTO service_observations/i);
  assert.equal(call.params[9], null, "'' is absence");
  assert.equal(call.params[9 + 14], null, "'   ' is absence");
  assert.equal(call.params[9 + 28], null, 'null is absence');
  assert.equal(call.params[9 + 42], 0, 'a real zero is a real zero');
});

test('an observation keeps its own time, not the time it was written', async () => {
  // A run that took four minutes produced facts across four minutes. Stamping
  // them all with the write time makes the timeline a record of the database.
  const earlier = new Date('2026-09-12T11:58:03.250Z');
  const pool = makeFakePool([[/^INSERT INTO service_observations/i, () => ok({ affectedRows: 2 })]]);
  const repo = createObservationsRepository({ db: { pool }, now });
  await repo.recordMany({ run_id: 1 }, [OBS({ observed_at: earlier }), OBS({ observed_at: null })]);
  const [call] = pool.matching(/^INSERT INTO service_observations/i);
  assert.equal(call.params[13].getTime(), earlier.getTime());
  assert.equal(call.params[13 + 14].getTime(), NOW.getTime(), 'and the clock only when it has nothing better');
});

test('over-long text is cut to its column rather than erroring the write', async () => {
  const pool = makeFakePool([[/^INSERT INTO service_observations/i, () => ok({ affectedRows: 1 })]]);
  const repo = createObservationsRepository({ db: { pool }, now });
  await repo.recordMany({ run_id: 1 }, [OBS({ kind: 'k'.repeat(200), subject: 's'.repeat(900), summary: 'm'.repeat(900), unit: 'u'.repeat(90) })]);
  const [call] = pool.matching(/^INSERT INTO service_observations/i);
  assert.equal(call.params[6].length, 64);
  assert.equal(call.params[7].length, 512);
  assert.equal(call.params[10].length, 32);
  assert.equal(call.params[11].length, 512);
});

test('a list is capped however large a limit the caller asks for', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_observations/i, () => rows([])]]);
  const repo = createObservationsRepository({ db: { pool }, now });
  await repo.list({ applicationId: 1, limit: 999999 });
  assert.match(pool.matching(/^SELECT/i)[0].sql, /LIMIT 2000/);
});

test('retention falls back to the shipped window rather than to zero', async () => {
  // Getting this wrong deletes the evidence the moment it is written.
  const pool = makeFakePool([[/^DELETE FROM service_observations/i, () => ok({ affectedRows: 4 })]]);
  const repo = createObservationsRepository({ db: { pool }, now });
  for (const bad of [0, null, undefined, 'soon', -5]) {
    // eslint-disable-next-line no-await-in-loop
    await repo.purgeOlderThan(bad);
    const last = pool.matching(/^DELETE FROM service_observations/i).pop();
    assert.equal(last.params[0].getTime(), NOW.getTime() - 30 * 86400000, `window ${String(bad)}`);
  }
});

// --------------------------------------------------------------- lifecycle
const INCIDENT = {
  id: 9, application_id: 1, environment_id: null, test_id: 4,
  subject_type: 'test', subject_key: 'test:4', subject_label: 'Customer search',
  kind: 'http_500', severity: 'CRIT', status: 'open', summary: 'HTTP 500',
  likely_cause: null, correlated_layer: null, confidence: null,
  impact: null, impact_reason: null, affected_journeys: null,
  explanation: 'x', evidence: '[]', occurrences: 2,
  opened_at: NOW, last_seen_at: NOW, resolved_at: null, resolved_by: null,
  acknowledged_at: null, acknowledged_by: null, resolution: null,
  notified_at: null, notified_severity: null,
};

function incidentPool(row = INCIDENT, update = ok({ affectedRows: 1 })) {
  return makeFakePool([
    [/^UPDATE service_test_incidents SET status/i, () => update],
    [/^UPDATE service_test_incidents SET/i, () => ok({ affectedRows: 1 })],
    [/^SELECT .* FROM service_test_incidents WHERE id = \?/i, () => rows([row])],
    [/^INSERT INTO service_incident_events/i, () => ok({ affectedRows: 1 })],
    [/^SELECT .* FROM service_incident_events/i, () => rows([])],
  ]);
}

test('picking an incident up is an acknowledgement, and it is stamped once', async () => {
  const pool = incidentPool();
  const repo = createIncidentsRepository({ db: { pool }, now });
  const res = await repo.transition(9, 'investigating', { by: 3 });
  assert.equal(res.ok, true);
  const [call] = pool.matching(/^UPDATE service_test_incidents SET status/i);
  assert.match(call.sql, /acknowledged_at = \?/);
  assert.match(call.sql, /AND status = \?$/, 'the move must be conditional on the status it was told about');
  assert.equal(call.params[call.params.length - 1], 'open');
});

test('an already-acknowledged incident does not have its acknowledgement rewritten', async () => {
  const pool = incidentPool({ ...INCIDENT, acknowledged_at: NOW, acknowledged_by: 2, status: 'open' });
  const repo = createIncidentsRepository({ db: { pool }, now });
  await repo.transition(9, 'investigating', { by: 9 });
  const [call] = pool.matching(/^UPDATE service_test_incidents SET status/i);
  assert.ok(!/acknowledged_by/.test(call.sql), 'the first person to pick it up is who picked it up');
});

test('an illegal move is refused with a sentence, not an exception', async () => {
  // Somebody clicked a button. Throwing at them is not an answer.
  const pool = incidentPool({ ...INCIDENT, status: 'closed' });
  const repo = createIncidentsRepository({ db: { pool }, now });
  const res = await repo.transition(9, 'open', {});
  assert.equal(res.ok, false);
  assert.match(res.reason, /a closed incident stays closed/, 'the refusal comes from the lifecycle module, in its words');
  assert.equal(pool.matching(/^UPDATE service_test_incidents SET status/i).length, 0, 'nothing was written');
});

test('every illegal move in the lifecycle is refused, not just the one', () => {
  // The guard read `if (!canTransition(...))` against a function that returns
  // `{ ok, reason }`. An object is always truthy, so every move was allowed —
  // including reopening a closed incident. Swept rather than sampled.
  const states = Object.keys(TRANSITIONS);
  const checks = [];
  for (const from of states) {
    for (const to of states) {
      if (from === to) continue;
      checks.push([from, to, TRANSITIONS[from].includes(to)]);
    }
  }
  assert.ok(checks.some(([, , legal]) => !legal), 'nothing illegal to test');
  return Promise.all(checks.map(async ([from, to, legal]) => {
    const pool = incidentPool({ ...INCIDENT, status: from });
    const repo = createIncidentsRepository({ db: { pool }, now });
    const res = await repo.transition(9, to, {});
    assert.equal(res.ok, legal, `${from} → ${to}`);
    assert.equal(pool.matching(/^UPDATE service_test_incidents SET status/i).length, legal ? 1 : 0, `${from} → ${to} wrote when it should not have`);
  }));
});

test('two people moving the same incident at once — the second is told, not silently undone', async () => {
  const pool = incidentPool(INCIDENT, ok({ affectedRows: 0 }));
  const repo = createIncidentsRepository({ db: { pool }, now });
  const res = await repo.transition(9, 'investigating', { by: 3 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /somebody else changed this incident first/);
});

test('moving to the state it is already in is a no-op, not an error', async () => {
  const pool = incidentPool({ ...INCIDENT, status: 'investigating' });
  const repo = createIncidentsRepository({ db: { pool }, now });
  const res = await repo.transition(9, 'investigating', {});
  assert.equal(res.ok, true);
  assert.equal(res.unchanged, true);
  assert.equal(pool.matching(/^UPDATE service_test_incidents SET status/i).length, 0);
});

test('an incident that no longer exists is reported, not thrown', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_incidents WHERE id = \?/i, () => rows([])]]);
  const repo = createIncidentsRepository({ db: { pool }, now });
  const res = await repo.transition(404, 'investigating', {});
  assert.equal(res.ok, false);
  assert.equal(res.incident, null);
});

test('a confidence of zero and no confidence at all are different values', async () => {
  const pool = incidentPool();
  const repo = createIncidentsRepository({ db: { pool }, now });
  await repo.recordAssessment(9, { correlatedLayer: 'api', confidence: 0 });
  let call = pool.matching(/^UPDATE service_test_incidents SET/i).pop();
  assert.equal(call.params[1], 0);

  await repo.recordAssessment(9, { correlatedLayer: 'api' });
  call = pool.matching(/^UPDATE service_test_incidents SET/i).pop();
  assert.equal(call.params.length, 2, 'confidence was not written at all');
  assert.ok(!/confidence/.test(call.sql));
});

test('an assessment with nothing in it issues no statement', async () => {
  const pool = incidentPool();
  const repo = createIncidentsRepository({ db: { pool }, now });
  await repo.recordAssessment(9, {});
  assert.equal(pool.matching(/^UPDATE service_test_incidents SET/i).length, 0);
});

// ---------------------------------------------------------------- timeline
test('several events of one run are written in ONE statement', async () => {
  const pool = incidentPool();
  const repo = createIncidentsRepository({ db: { pool }, now });
  await repo.addEvents(9, [
    { kind: 'opened', summary: 'Customer search started failing', source: 'run' },
    { kind: 'correlated', summary: 'Likely an application or API problem', source: 'correlation' },
  ]);
  const calls = pool.matching(/^INSERT INTO service_incident_events/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.length, 2 * 7, 'placeholders and parameters must agree');
});

test('an unrecognised source lands on a valid one rather than failing the write', async () => {
  const pool = incidentPool();
  const repo = createIncidentsRepository({ db: { pool }, now });
  await repo.addEvent(9, { kind: 'x', summary: 'y', source: 'telepathy' });
  const [call] = pool.matching(/^INSERT INTO service_incident_events/i);
  assert.equal(call.params[4], 'run');
});

test('an event keeps the time it HAPPENED', async () => {
  const when = new Date('2026-09-12T11:55:00.000Z');
  const pool = incidentPool();
  const repo = createIncidentsRepository({ db: { pool }, now });
  await repo.addEvents(9, [{ kind: 'a', summary: 'b', occurred_at: when }, { kind: 'c', summary: 'd' }]);
  const [call] = pool.matching(/^INSERT INTO service_incident_events/i);
  assert.equal(call.params[6].getTime(), when.getTime());
  assert.equal(call.params[13].getTime(), NOW.getTime());
});

test('a timeline is read forwards, and ties break by id', async () => {
  // Several events of one run share a timestamp to the millisecond, and "the
  // incident opened" must not appear after "the correlation concluded".
  const pool = incidentPool();
  const repo = createIncidentsRepository({ db: { pool }, now });
  await repo.timeline(9);
  const [call] = pool.matching(/^SELECT .* FROM service_incident_events/i);
  assert.match(call.sql, /ORDER BY occurred_at, id/);
  assert.match(call.sql, /LIMIT 500/);
});

test('an empty batch of events issues no statement', async () => {
  const pool = incidentPool();
  const repo = createIncidentsRepository({ db: { pool }, now });
  for (const input of [[], null, undefined, 'no', [null]]) {
    assert.equal(await repo.addEvents(9, input), 0, String(input));
  }
  assert.equal(pool.matching(/^INSERT INTO service_incident_events/i).length, 0);
});
