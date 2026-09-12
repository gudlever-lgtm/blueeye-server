'use strict';

// The Service Assurance guide states numbers. This checks they are the code's
// numbers.
//
// A guide is worth having only while it is true, and the way it stops being true
// is not that somebody rewrites it wrongly — it is that somebody changes a
// default and nobody remembers a document three directories away quotes it. So
// the quotable facts are asserted here, and a default that moves fails the build
// with the line to change.
//
// Only MECHANICAL claims. Prose is not testable and pretending otherwise would
// produce a test that fails on a rewording.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const GUIDE = path.join(__dirname, '..', 'docs', 'service-assurance-guide.md');
const guide = fs.readFileSync(GUIDE, 'utf8');

const { SCORE_WEIGHTS } = require('../src/serviceTests/health/serviceHealth');
const { MIN_SAMPLES } = require('../src/serviceTests/analysis/baseline');
const { MIN_FOR_RHYTHM } = require('../src/serviceTests/history/recurrence');
const { CAUSE } = require('../src/serviceTests/rootcause/rootCause');
const { STEP_TYPES } = require('../src/serviceTests/engine/dsl');
const { INTERVALS, ENTRY_TYPES, CRITICALITIES } = require('../src/serviceTests/validation');
const { NUMBER_BOUNDS, BOOLEAN_FIELDS } = require('../src/serviceTests/settings/defaults');
const { DENY_CIDRS } = require('../src/serviceTests/security/hostPolicy');

// A row of the guide's settings table: | `key` | default | … |
function settingsRow(key) {
  const escaped = key.replace(/[.]/g, '\\.');
  const match = new RegExp('\\|\\s*`' + escaped + '`\\s*\\|\\s*([^|]+?)\\s*\\|').exec(guide);
  return match ? match[1].trim() : null;
}

test('the health weights the guide publishes are the ones the score uses', () => {
  // The table exists so the number can be argued with. A table that disagrees
  // with the arithmetic is worse than no table.
  for (const [part, weight] of Object.entries(SCORE_WEIGHTS)) {
    const pct = `${Math.round(weight * 100)}%`;
    assert.ok(guide.includes(pct), `the guide does not list ${part} at ${pct}`);
  }
  assert.equal(
    Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(2), '1.00',
    'the weights no longer sum to 1, so the guide’s table cannot be right either'
  );
});

test('the counted vocabularies are counted correctly', () => {
  assert.ok(guide.includes(`${STEP_TYPES.length} step types`), `there are ${STEP_TYPES.length} step types`);
  assert.ok(guide.includes(`out of ${Object.keys(CAUSE).length}`), `there are ${Object.keys(CAUSE).length} causes`);
  assert.ok(/Five cadences/.test(guide) && INTERVALS.length === 5, `there are ${INTERVALS.length} cadences`);
});

test('every schedule cadence the product offers is named in the guide', () => {
  // Counting them right and listing them right are different mistakes.
  const named = { 60: 'every minute', 300: '5 minutes', 900: '15 minutes', 3600: 'hourly', 86400: 'daily' };
  for (const seconds of INTERVALS) {
    assert.ok(named[seconds], `a cadence of ${seconds}s exists and the guide does not name it`);
    assert.ok(guide.includes(named[seconds]), `the guide does not mention "${named[seconds]}"`);
  }
});

test('the allowlist entry types and journey criticalities are the real ones', () => {
  for (const type of ENTRY_TYPES) {
    assert.ok(new RegExp(`\`${type}\``).test(guide), `entry type ${type} is missing from the guide`);
  }
  for (const c of CRITICALITIES) {
    assert.ok(new RegExp(`\`${c}\``).test(guide), `criticality ${c} is missing from the guide`);
  }
});

test('the thresholds the guide quotes are the thresholds in the code', () => {
  assert.ok(guide.includes(`${MIN_SAMPLES} successful runs is the floor`), `the baseline floor is ${MIN_SAMPLES}`);
  assert.ok(guide.includes(`${MIN_FOR_RHYTHM} occurrences`), `a rhythm needs ${MIN_FOR_RHYTHM} occurrences`);
});

test('the settings table matches the shipped defaults', () => {
  const quoted = {
    'assurance.failureStreak': String(NUMBER_BOUNDS.assurance.failureStreak[0]),
    'assurance.certificateWarnDays': String(NUMBER_BOUNDS.assurance.certificateWarnDays[0]),
    'assurance.certificateCriticalDays': String(NUMBER_BOUNDS.assurance.certificateCriticalDays[0]),
    'assurance.incidentRetentionDays': String(NUMBER_BOUNDS.assurance.incidentRetentionDays[0]),
    'runner.concurrency': String(NUMBER_BOUNDS.runner.concurrency[0]),
    'discovery.maxPages': String(NUMBER_BOUNDS.discovery.maxPages[0]),
    'artifacts.retentionDays': String(NUMBER_BOUNDS.artifacts.retentionDays[0]),
  };
  for (const [key, value] of Object.entries(quoted)) {
    const row = settingsRow(key);
    assert.ok(row !== null, `${key} is not in the guide’s settings table`);
    assert.equal(row, value, `the guide says ${key} defaults to ${row}; it defaults to ${value}`);
  }
  // The booleans are quoted as on/off rather than true/false.
  for (const key of ['enabled', 'notify', 'groupAlerts']) {
    const row = settingsRow(`assurance.${key}`);
    assert.ok(row !== null, `assurance.${key} is not in the guide’s settings table`);
    assert.equal(row, BOOLEAN_FIELDS.assurance[key] ? 'on' : 'off', `assurance.${key}`);
  }
  assert.equal(settingsRow('runner.accessibility'), BOOLEAN_FIELDS.runner.accessibility ? 'on' : 'off');
});

test('the ranges the guide says can never be allowed are the ones the policy refuses', () => {
  // The most consequential table in the document: somebody reads it to decide
  // what they can put on an allowlist.
  // DENY_CIDRS holds parsed entries, not strings — each carries its own `cidr`.
  const refused = (DENY_CIDRS || []).map((entry) => (typeof entry === 'string' ? entry : entry.cidr)).join(' ');
  for (const range of ['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8']) {
    assert.ok(guide.includes(range), `the guide does not mention ${range}`);
    assert.ok(refused.includes(range), `${range} is in the guide but the host policy no longer refuses it`);
  }
});

test('every other Service Assurance document is listed, and every link resolves', () => {
  // The guide is the entry point. One that has stopped listing a document is one
  // that sends a reader looking, which is the failure mode this whole set had.
  const docsDir = path.join(__dirname, '..', 'docs');
  const siblings = fs.readdirSync(docsDir)
    .filter((f) => /^service-assurance.*\.md$/.test(f) && f !== 'service-assurance-guide.md');
  assert.ok(siblings.length >= 7, `only ${siblings.length} sibling documents found`);
  for (const file of siblings) {
    assert.ok(guide.includes(`(${file})`), `${file} is not listed in the guide`);
  }
  // And nothing listed has gone away.
  for (const link of guide.matchAll(/\]\((?!http)([^)]+\.md)\)/g)) {
    const target = path.resolve(docsDir, link[1]);
    assert.ok(fs.existsSync(target), `the guide links to ${link[1]}, which does not exist`);
  }
});

test('the worker command the guide gives is a real npm script', () => {
  // The one instruction in the document somebody types verbatim.
  const pkg = require('../package.json');
  const match = /npm run ([a-z-]+)\n```/.exec(guide);
  assert.ok(match, 'the guide no longer gives a worker command');
  assert.ok(pkg.scripts[match[1]], `the guide says "npm run ${match[1]}" and package.json has no such script`);
});
