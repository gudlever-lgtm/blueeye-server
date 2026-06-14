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
