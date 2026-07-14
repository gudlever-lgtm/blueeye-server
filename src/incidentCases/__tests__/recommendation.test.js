'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMatchingPlaybook, buildHistoricalMatches, shouldGenerateAi, resolutionSeconds,
} = require('../recommendation');

test('buildMatchingPlaybook: null when no playbook matched', () => {
  assert.equal(buildMatchingPlaybook(null, []), null);
});

test('buildMatchingPlaybook: suggests a manual playbook (auto_trigger false → manual text)', () => {
  const pb = { id: 3, name: 'Runbook', actionType: 'manual', autoTrigger: false, manualActionText: 'do X' };
  const out = buildMatchingPlaybook(pb, []);
  assert.equal(out.already_run, false);
  assert.equal(out.auto_trigger, false);
  assert.equal(out.manual_action_text, 'do X');
});

test('buildMatchingPlaybook: auto-trigger playbook does not leak manual text', () => {
  const pb = { id: 4, name: 'Auto', actionType: 'restart_service', autoTrigger: true, manualActionText: 'ignored' };
  const out = buildMatchingPlaybook(pb, []);
  assert.equal(out.auto_trigger, true);
  assert.equal(out.manual_action_text, null);
});

test('buildMatchingPlaybook: shows the run RESULT when it already ran on this incident', () => {
  const pb = { id: 5, name: 'PB', actionType: 'run_probe', autoTrigger: false, manualActionText: 'm' };
  const runs = [{ playbookId: 5, status: 'succeeded', resultText: 'ok', ranAt: '2026-06-01T00:00:00.000Z', ranBy: 'op' }];
  const out = buildMatchingPlaybook(pb, runs);
  assert.equal(out.already_run, true);
  assert.equal(out.run.status, 'succeeded');
  assert.equal(out.run.result_text, 'ok');
  assert.equal(out.manual_action_text, undefined); // suggestion fields dropped
});

test('resolutionSeconds: computes span, null on missing/negative', () => {
  assert.equal(resolutionSeconds('2026-05-05T00:00:00Z', '2026-05-05T01:00:00Z'), 3600);
  assert.equal(resolutionSeconds(null, '2026-05-05T01:00:00Z'), null);
  assert.equal(resolutionSeconds('2026-05-05T02:00:00Z', '2026-05-05T01:00:00Z'), null);
});

test('buildHistoricalMatches: annotates timesSeen (pattern frequency) + playbook used', () => {
  const ranked = [
    { id: 1, title: 'A', primaryMetric: 'cpu', firstEventAt: '2026-05-05T00:00:00Z', resolvedAt: '2026-05-05T01:00:00Z', score: 5, matchedOn: ['device', 'anomalyType'], closedByEmail: 'a@x' },
  ];
  const resolvedCandidates = [
    { id: 1, primaryMetric: 'cpu' }, { id: 7, primaryMetric: 'cpu' }, { id: 8, primaryMetric: 'mem' },
  ];
  const runsByIncident = { 1: [{ playbookId: 2, playbookName: 'PB', playbookActionType: 'run_probe', status: 'succeeded' }] };
  const out = buildHistoricalMatches(ranked, { runsByIncident, resolvedCandidates });
  assert.equal(out[0].timesSeen, 2); // two resolved cpu incidents
  assert.equal(out[0].resolutionTimeSeconds, 3600);
  assert.equal(out[0].playbook.name, 'PB');
  assert.equal(out[0].playbook.status, 'succeeded');
});

test('buildHistoricalMatches: playbook null when no run recorded', () => {
  const ranked = [{ id: 1, title: 'A', primaryMetric: 'cpu', score: 3, matchedOn: ['device'] }];
  const out = buildHistoricalMatches(ranked, { runsByIncident: {}, resolvedCandidates: [{ id: 1, primaryMetric: 'cpu' }] });
  assert.equal(out[0].playbook, null);
});

// The ordering predicate — the heart of "playbook/historik first, AI only as a
// last resort". A match at (a) OR (b) suppresses the AI call unless forced.
test('shouldGenerateAi: only when NO playbook AND NO history', () => {
  assert.equal(shouldGenerateAi({ matchingPlaybook: null, historicalMatches: [] }), true);
});

test('shouldGenerateAi: playbook found → no AI', () => {
  assert.equal(shouldGenerateAi({ matchingPlaybook: { playbook_id: 1 }, historicalMatches: [] }), false);
});

test('shouldGenerateAi: history present → no AI', () => {
  assert.equal(shouldGenerateAi({ matchingPlaybook: null, historicalMatches: [{ id: 1 }] }), false);
});

test('shouldGenerateAi: force_ai overrides even when a playbook + history exist', () => {
  assert.equal(shouldGenerateAi({ matchingPlaybook: { playbook_id: 1 }, historicalMatches: [{ id: 1 }], forceAi: true }), true);
});
