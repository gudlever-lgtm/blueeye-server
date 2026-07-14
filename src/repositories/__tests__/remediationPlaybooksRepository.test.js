'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRemediationPlaybooksRepository } = require('../remediationPlaybooksRepository');

// A tiny in-memory fake of the mysql2 pool understanding the exact SQL the
// remediation-playbooks repository issues.
function makeFakePool() {
  const playbooks = [];
  const runs = [];
  let pbSeq = 0;
  let runSeq = 0;
  return {
    playbooks,
    runs,
    async query(sql, params = []) {
      if (/^INSERT INTO remediation_playbooks/i.test(sql)) {
        // only used indirectly by tests via seedPlaybook below (not the repo)
        throw new Error('repo does not insert playbooks');
      }
      if (/^INSERT INTO incident_playbook_runs/i.test(sql)) {
        const [incident_case_id, playbook_id, status, result_text, ran_by] = params;
        const id = (runSeq += 1);
        runs.push({ id, incident_case_id, playbook_id, status, result_text, ran_by, ran_at: new Date('2026-06-01T00:00:00Z') });
        return [{ insertId: id }];
      }
      if (/FROM remediation_playbooks\s+WHERE enabled = 1 AND trigger_condition = \?/i.test(sql)) {
        const [type] = params;
        const hit = playbooks.filter((p) => p.enabled && p.trigger_condition === type).sort((a, b) => b.id - a.id).slice(0, 1);
        return [hit];
      }
      if (/FROM remediation_playbooks WHERE id = \?/i.test(sql)) {
        return [playbooks.filter((p) => p.id === params[0])];
      }
      if (/FROM remediation_playbooks ORDER BY id DESC/i.test(sql)) {
        return [playbooks.slice().sort((a, b) => b.id - a.id)];
      }
      if (/FROM incident_playbook_runs r/i.test(sql)) {
        const [incidentId] = params;
        const out = runs
          .filter((r) => r.incident_case_id === incidentId)
          .sort((a, b) => b.id - a.id)
          .map((r) => {
            const p = playbooks.find((x) => x.id === r.playbook_id);
            return { ...r, playbook_name: p ? p.name : null, playbook_action_type: p ? p.action_type : null };
          });
        return [out];
      }
      throw new Error(`unexpected SQL in fake pool: ${sql}`);
    },
    seedPlaybook(p) {
      const id = (pbSeq += 1);
      playbooks.push({ id, enabled: 1, auto_trigger: 0, manual_action_text: null, created_at: new Date('2026-01-01T00:00:00Z'), ...p });
      return id;
    },
  };
}

test('matchByAnomalyType returns the enabled playbook for the anomaly-type, mapped to camelCase', async () => {
  const pool = makeFakePool();
  pool.seedPlaybook({ name: 'CPU', trigger_condition: 'cpu', action_type: 'restart_service', auto_trigger: 1 });
  const repo = createRemediationPlaybooksRepository({ pool });
  const pb = await repo.matchByAnomalyType('cpu');
  assert.equal(pb.name, 'CPU');
  assert.equal(pb.triggerCondition, 'cpu');
  assert.equal(pb.actionType, 'restart_service');
  assert.equal(pb.autoTrigger, true);
});

test('matchByAnomalyType returns null for an empty/unknown anomaly-type', async () => {
  const pool = makeFakePool();
  pool.seedPlaybook({ name: 'CPU', trigger_condition: 'cpu', action_type: 'x' });
  const repo = createRemediationPlaybooksRepository({ pool });
  assert.equal(await repo.matchByAnomalyType(''), null);
  assert.equal(await repo.matchByAnomalyType(null), null);
  assert.equal(await repo.matchByAnomalyType('mem'), null);
});

test('matchByAnomalyType ignores disabled playbooks', async () => {
  const pool = makeFakePool();
  pool.seedPlaybook({ name: 'off', trigger_condition: 'cpu', action_type: 'x', enabled: 0 });
  const repo = createRemediationPlaybooksRepository({ pool });
  assert.equal(await repo.matchByAnomalyType('cpu'), null);
});

test('recordRun + listRunsForIncident round-trips a run with the joined playbook name', async () => {
  const pool = makeFakePool();
  const pbId = pool.seedPlaybook({ name: 'PB', trigger_condition: 'cpu', action_type: 'run_probe' });
  const repo = createRemediationPlaybooksRepository({ pool });
  await repo.recordRun({ incidentCaseId: 42, playbookId: pbId, status: 'succeeded', resultText: 'ok', ranBy: 'op@x' });
  const runs = await repo.listRunsForIncident(42);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].resultText, 'ok');
  assert.equal(runs[0].playbookName, 'PB');
  assert.equal(runs[0].playbookActionType, 'run_probe');
});
