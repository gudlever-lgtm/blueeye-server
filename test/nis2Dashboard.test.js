'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeDashboard, recommendedActions } = require('../src/nis2/dashboard');
const { buildExecutiveReport, deltaFrom, managementConclusion, renderExecutiveHtml, renderRegisterHtml } = require('../src/nis2/report');
const { riskBand } = require('../src/nis2/constants');

const risk = (over = {}) => ({
  id: 1, title: 'r', category: 'Governance', likelihood: 3, impact: 3,
  riskScore: 9, owner: null, status: 'open', mitigationPlan: null, ...over,
});
const control = (over = {}) => ({
  id: 1, controlName: 'c', nis2Area: 'Governance', status: 'OK', hasEvidence: true, ...over,
});
const incident = (over = {}) => ({
  id: 1, incidentId: 'INC-2026-0001', title: 'i', severity: 'high',
  detectedAt: new Date().toISOString(), status: 'open', nis2Relevant: false,
  notificationRequired: false, ...over,
});

// ---- riskBand --------------------------------------------------------------

test('riskBand maps scores to the 5x5 matrix bands', () => {
  assert.equal(riskBand(1), 'Low');
  assert.equal(riskBand(3), 'Low');
  assert.equal(riskBand(4), 'Medium');
  assert.equal(riskBand(8), 'High');
  assert.equal(riskBand(15), 'Critical');
  assert.equal(riskBand(25), 'Critical');
});

// ---- computeDashboard ------------------------------------------------------

test('readiness score is the mean of scored categories (OK=100, Partial=50, Missing=0)', () => {
  const controls = [
    control({ id: 1, nis2Area: 'Governance', status: 'OK' }),
    control({ id: 2, nis2Area: 'Governance', status: 'Partial' }),  // Governance avg = 75
    control({ id: 3, nis2Area: 'Access Control', status: 'Missing', hasEvidence: false }), // = 0
  ];
  const d = computeDashboard({ risks: [], controls, incidents: [] });
  // Two scored categories: 75 and 0 -> mean 38 (round).
  assert.equal(d.readinessScore, 38);
  const gov = d.categories.find((c) => c.category === 'Governance');
  assert.equal(gov.score, 75);
  assert.equal(gov.status, 'partial');
  const empty = d.categories.find((c) => c.category === 'Documentation');
  assert.equal(empty.controlCount, 0);
  assert.equal(empty.status, 'no-data');
});

test('counts open critical and high/medium risks, ignoring accepted/closed', () => {
  const risks = [
    risk({ id: 1, likelihood: 5, impact: 5, riskScore: 25, status: 'open' }),     // Critical, open
    risk({ id: 2, likelihood: 4, impact: 2, riskScore: 8, status: 'mitigating' }), // High, open
    risk({ id: 3, likelihood: 2, impact: 2, riskScore: 4, status: 'open' }),       // Medium, open
    risk({ id: 4, likelihood: 5, impact: 5, riskScore: 25, status: 'accepted' }),  // Critical but accepted
  ];
  const d = computeDashboard({ risks, controls: [], incidents: [] });
  assert.equal(d.openCriticalRisks, 1);
  assert.equal(d.openHighMediumFindings, 2);
  assert.equal(d.totals.openRisks, 3);
});

test('incidentsLast30Days counts only recent incidents', () => {
  const old = new Date(Date.now() - 40 * 86400_000).toISOString();
  const recent = new Date(Date.now() - 5 * 86400_000).toISOString();
  const d = computeDashboard({ risks: [], controls: [], incidents: [
    incident({ id: 1, detectedAt: old }), incident({ id: 2, detectedAt: recent }),
  ] });
  assert.equal(d.incidentsLast30Days, 1);
});

test('controlsWithoutEvidence counts no-evidence OR missing/overdue', () => {
  const controls = [
    control({ id: 1, status: 'OK', hasEvidence: true }),                 // fine
    control({ id: 2, status: 'OK', hasEvidence: false }),                // no evidence
    control({ id: 3, status: 'Overdue', hasEvidence: true }),            // overdue
    control({ id: 4, status: 'Missing', hasEvidence: false }),           // missing
  ];
  const d = computeDashboard({ risks: [], controls, incidents: [] });
  assert.equal(d.controlsWithoutEvidence, 3);
});

test('recommendedActions ranks critical risk + notification obligation highest, max 5', () => {
  const risks = [risk({ id: 1, title: 'Crit', riskScore: 20, status: 'open', mitigationPlan: null })];
  const controls = [control({ id: 1, status: 'Overdue', hasEvidence: false })];
  const incidents = [incident({ id: 1, notificationRequired: true, status: 'open' })];
  const d = computeDashboard({ risks, controls, incidents });
  assert.ok(d.topActions.length >= 1 && d.topActions.length <= 5);
  // The unmitigated critical risk (weight 100) should lead.
  assert.match(d.topActions[0].text, /critical risk/i);
  assert.equal(d.topActions[0].priority, 'critical');
});

// ---- report builder --------------------------------------------------------

test('deltaFrom computes per-metric change vs the previous snapshot', () => {
  const prev = { readinessScore: 40, openCriticalRisks: 3, openHighMediumFindings: 5, incidentsLast30Days: 2, controlsWithoutEvidence: 7 };
  const curr = { readinessScore: 55, openCriticalRisks: 1, openHighMediumFindings: 5, incidentsLast30Days: 0, controlsWithoutEvidence: 4 };
  const d = deltaFrom(prev, curr);
  assert.equal(d.readinessScore.change, 15);
  assert.equal(d.openCriticalRisks.change, -2);
  assert.equal(d.incidentsLast30Days.change, -2);
  assert.equal(deltaFrom(null, curr), null);
});

test('managementConclusion is plain-language and reflects the score band', () => {
  const high = managementConclusion(computeDashboard({ controls: [control({ status: 'OK' })] }));
  assert.match(high, /readiness stands at 100%/);
  const low = computeDashboard({ risks: [], controls: [], incidents: [] });
  assert.match(managementConclusion(low), /early stage/);
});

test('buildExecutiveReport + renderExecutiveHtml produce a self-contained document', () => {
  const data = {
    risks: [risk({ id: 1, title: 'Top risk', riskScore: 20, status: 'open' })],
    controls: [control({ id: 1, status: 'Missing', hasEvidence: false })],
    incidents: [incident({ id: 1, severity: 'critical', nis2Relevant: true })],
  };
  const dashboard = computeDashboard(data);
  const report = buildExecutiveReport({ ...data, dashboard, previous: null });
  assert.equal(report.sections.riskOverview.topRisks[0].title, 'Top risk');
  const html = renderExecutiveHtml(report, { org: 'Acme A/S' });
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /NIS2 Executive Report/);
  assert.match(html, /Acme A\/S/);
  assert.match(html, /Top risk/);
});

test('renderExecutiveHtml escapes HTML in record fields', () => {
  const data = { risks: [risk({ id: 1, title: '<script>alert(1)</script>', riskScore: 20, status: 'open' })], controls: [], incidents: [] };
  const report = buildExecutiveReport({ ...data, dashboard: computeDashboard(data), previous: null });
  const html = renderExecutiveHtml(report);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('renderRegisterHtml renders a multi-section table document', () => {
  const html = renderRegisterHtml('NIS2 Risk Register Report', [
    { heading: 'Risks (1)', headers: ['ID', 'Title'], rows: [[1, 'r']] },
  ], { org: 'Org' });
  assert.match(html, /NIS2 Risk Register Report/);
  assert.match(html, /<th>Title<\/th>/);
});
