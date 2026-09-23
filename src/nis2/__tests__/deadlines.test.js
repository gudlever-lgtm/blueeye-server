'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeIncidentDeadlines, deadlineOverview, isApplicable } = require('../deadlines');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-06-14T12:00:00Z');
const at = (hoursAgo) => new Date(NOW - hoursAgo * HOUR).toISOString();

test('non-applicable incidents get no deadlines', () => {
  assert.equal(isApplicable({ severity: 'low' }), false);
  const r = computeIncidentDeadlines({ detectedAt: at(1), severity: 'low' }, { now: NOW });
  assert.equal(r.applicable, false);
  assert.equal(r.stages.length, 0);
});

test('an old significant incident is overdue on the early stages', () => {
  const r = computeIncidentDeadlines({ detectedAt: at(100), notificationRequired: true }, { now: NOW });
  assert.equal(r.applicable, true);
  const byStage = Object.fromEntries(r.stages.map((s) => [s.stage, s.status]));
  assert.equal(byStage['early-warning'], 'overdue'); // 24h, anchored 100h ago
  assert.equal(byStage.notification, 'overdue'); // 72h
  assert.equal(byStage['final-report'], 'upcoming'); // 30d, still far off
  assert.equal(r.worstStatus, 'overdue');
  assert.ok(r.nextDueAt, 'nextDueAt points at the first non-overdue stage');
});

test('a fresh incident is upcoming; due-soon kicks in near a deadline', () => {
  const fresh = computeIncidentDeadlines({ detectedAt: at(1), nis2Relevant: true }, { now: NOW });
  assert.equal(fresh.worstStatus, 'upcoming'); // early warning still ~23h away
  // 20h after detection, the 24h early-warning deadline is 4h away → due-soon.
  const near = computeIncidentDeadlines({ detectedAt: at(20), nis2Relevant: true }, { now: NOW, dueSoonHours: 12 });
  assert.equal(near.stages.find((s) => s.stage === 'early-warning').status, 'due-soon');
});

test('deadlineOverview ranks overdue first and counts by worst status', () => {
  const incidents = [
    { id: 1, detectedAt: at(1), nis2Relevant: true }, // upcoming
    { id: 2, detectedAt: at(100), notificationRequired: true }, // overdue
    { id: 3, severity: 'low' }, // not applicable → excluded
  ];
  const ov = deadlineOverview(incidents, { now: NOW });
  assert.equal(ov.summary.total, 2);
  assert.equal(ov.summary.overdue, 1);
  assert.equal(ov.summary.upcoming, 1);
  assert.equal(ov.incidents[0].id, 2); // overdue sorts first
});

// --- submission (migration 122) ---------------------------------------------------

test('a submitted stage is "submitted", says whether it was on time, and stops counting as overdue', () => {
  const r = computeIncidentDeadlines({
    detectedAt: at(100), notificationRequired: true,
    earlyWarningSubmittedAt: at(90), // 10 h after detection — on time
    notificationSubmittedAt: at(10), // 90 h after detection — 18 h late
  }, { now: NOW });
  const by = Object.fromEntries(r.stages.map((s) => [s.stage, s]));
  assert.equal(by['early-warning'].status, 'submitted');
  assert.equal(by['early-warning'].onTime, true);
  assert.equal(by.notification.status, 'submitted');
  assert.equal(by.notification.onTime, false, 'late is recorded, not hidden');
  assert.equal(by['final-report'].status, 'upcoming');
  assert.equal(r.worstStatus, 'upcoming', 'nothing open is overdue any more');
});

test('the final report is due one month after the notification was SUBMITTED, once that is known', () => {
  const r = computeIncidentDeadlines({ detectedAt: at(100), notificationRequired: true, notificationSubmittedAt: at(40) }, { now: NOW });
  const fin = r.stages.find((s) => s.stage === 'final-report');
  assert.equal(fin.dueFrom, 'notification-submitted');
  assert.equal(Date.parse(fin.dueAt), Date.parse(at(40)) + 30 * 24 * HOUR);
  // Unknown submission: anchored on detection, which is never later than the law.
  const before = computeIncidentDeadlines({ detectedAt: at(100), notificationRequired: true }, { now: NOW });
  assert.equal(before.stages.find((s) => s.stage === 'final-report').dueFrom, 'detection');
});

test('everything submitted reads "submitted" and sorts after open duties', () => {
  const done = { id: 1, detectedAt: at(800), notificationRequired: true, earlyWarningSubmittedAt: at(790), notificationSubmittedAt: at(760), finalReportSubmittedAt: at(100) };
  const r = computeIncidentDeadlines(done, { now: NOW });
  assert.equal(r.worstStatus, 'submitted');
  assert.equal(r.nextDueAt, null);
  const ov = deadlineOverview([done, { id: 2, detectedAt: at(1), nis2Relevant: true }], { now: NOW });
  assert.equal(ov.summary.submitted, 1);
  assert.equal(ov.summary.upcoming, 1);
  assert.equal(ov.incidents[0].id, 2);
});
