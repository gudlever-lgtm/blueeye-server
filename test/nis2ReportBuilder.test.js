'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SOURCE_KEYS, sourcesFor, buildCustomReport, customReportToCsv } = require('../src/nis2/reportBuilder');
const { computeDashboard } = require('../src/nis2/dashboard');

const risk = (over = {}) => ({
  id: 1, title: 'r', category: 'Governance', affectedAsset: null, likelihood: 3, impact: 3,
  riskScore: 9, band: 'High', owner: 'o', status: 'open', mitigationPlan: null, dueDate: null, ...over,
});
const control = (over = {}) => ({
  id: 1, controlName: 'c', nis2Area: 'Governance', frequency: 'quarterly', status: 'OK',
  hasEvidence: true, owner: 'o', nextDue: null, ...over,
});
const incident = (over = {}) => ({
  id: 1, incidentId: 'INC-2026-0001', title: 'i', severity: 'high', status: 'open',
  detectedAt: '2026-06-01T00:00:00.000Z', nis2Relevant: true, notificationRequired: false, ...over,
});

test('sourcesFor hides admin-only sources from non-admins', () => {
  const asAdmin = sourcesFor(true).map((s) => s.key);
  const asUser = sourcesFor(false).map((s) => s.key);
  assert.ok(asAdmin.includes('audit'));
  assert.ok(!asUser.includes('audit'));
  assert.deepEqual([...SOURCE_KEYS].sort(), asAdmin.slice().sort());
});

test('buildCustomReport projects requested columns in order', () => {
  const report = buildCustomReport(
    { sections: [{ source: 'risks', filters: {}, columns: ['title', 'band', 'owner'] }] },
    { risks: [risk()] }
  );
  assert.equal(report.sections.length, 1);
  assert.deepEqual(report.sections[0].headers, ['Title', 'Band', 'Owner']);
  assert.deepEqual(report.sections[0].rows[0], ['r', 'High', 'o']);
});

test('buildCustomReport falls back to default columns when none requested', () => {
  const report = buildCustomReport({ sections: [{ source: 'controls', filters: {}, columns: [] }] }, { controls: [control()] });
  // Default control columns include controlName + status.
  assert.ok(report.sections[0].headers.includes('Control'));
  assert.ok(report.sections[0].headers.includes('Status'));
});

test('risk filters: band + minScore', () => {
  const risks = [
    risk({ id: 1, riskScore: 20, band: 'Critical' }),
    risk({ id: 2, riskScore: 9, band: 'High' }),
    risk({ id: 3, riskScore: 2, band: 'Low' }),
  ];
  const r = buildCustomReport({ sections: [{ source: 'risks', filters: { band: 'Critical' } }] }, { risks });
  assert.equal(r.sections[0].rowCount, 1);
  const r2 = buildCustomReport({ sections: [{ source: 'risks', filters: { minScore: '8' } }] }, { risks });
  assert.equal(r2.sections[0].rowCount, 2);
});

test('control filters: evidence present/missing', () => {
  const controls = [control({ id: 1, hasEvidence: true }), control({ id: 2, hasEvidence: false })];
  assert.equal(buildCustomReport({ sections: [{ source: 'controls', filters: { evidence: 'missing' } }] }, { controls }).sections[0].rowCount, 1);
  assert.equal(buildCustomReport({ sections: [{ source: 'controls', filters: { evidence: 'present' } }] }, { controls }).sections[0].rowCount, 1);
});

test('incident filters: severity, nis2Relevant and date range', () => {
  const incidents = [
    incident({ id: 1, severity: 'high', detectedAt: '2026-06-01T00:00:00Z', nis2Relevant: true }),
    incident({ id: 2, severity: 'low', detectedAt: '2026-01-01T00:00:00Z', nis2Relevant: false }),
  ];
  assert.equal(buildCustomReport({ sections: [{ source: 'incidents', filters: { severity: 'high' } }] }, { incidents }).sections[0].rowCount, 1);
  assert.equal(buildCustomReport({ sections: [{ source: 'incidents', filters: { nis2Relevant: 'yes' } }] }, { incidents }).sections[0].rowCount, 1);
  assert.equal(buildCustomReport({ sections: [{ source: 'incidents', filters: { from: '2026-05-01' } }] }, { incidents }).sections[0].rowCount, 1);
});

test('booleans render as yes/no', () => {
  const report = buildCustomReport(
    { sections: [{ source: 'incidents', columns: ['title', 'nis2Relevant', 'notificationRequired'] }] },
    { incidents: [incident({ nis2Relevant: true, notificationRequired: false })] }
  );
  assert.deepEqual(report.sections[0].rows[0], ['i', 'yes', 'no']);
});

test('summary + categories sections use the dashboard', () => {
  const dashboard = computeDashboard({ risks: [], controls: [control({ status: 'OK' })], incidents: [] });
  const report = buildCustomReport({ sections: [{ source: 'summary' }, { source: 'categories' }] }, { dashboard });
  assert.equal(report.sections.length, 2);
  assert.equal(report.sections[0].heading, 'Readiness summary');
  assert.ok(report.sections[0].rows.some((r) => r[0] === 'Readiness score'));
  assert.equal(report.sections[1].rows.length, 10); // ten categories
});

test('audit source is skipped when not admin (defence in depth)', () => {
  const report = buildCustomReport({ sections: [{ source: 'audit' }] }, { audit: [{ id: 1, action: 'create', entityType: 'risk' }] }, { isAdmin: false });
  assert.equal(report.sections.length, 0);
  const adminReport = buildCustomReport({ sections: [{ source: 'audit' }] }, { audit: [{ id: 1, action: 'create', entityType: 'risk', entityId: 1, userEmail: 'a@b', createdAt: 'x' }] }, { isAdmin: true });
  assert.equal(adminReport.sections.length, 1);
});

test('customReportToCsv emits a heading + header + rows per section', () => {
  const report = buildCustomReport({ sections: [{ source: 'risks', columns: ['title', 'band'] }] }, { risks: [risk()] });
  const csv = customReportToCsv(report);
  assert.match(csv, /# Risk register/);
  assert.match(csv, /Title,Band/);
  assert.match(csv, /r,High/);
});

test('customReportToCsv neutralises formula injection', () => {
  const report = buildCustomReport({ sections: [{ source: 'risks', columns: ['title'] }] }, { risks: [risk({ title: '=cmd()' })] });
  assert.match(customReportToCsv(report), /'=cmd\(\)/);
});
