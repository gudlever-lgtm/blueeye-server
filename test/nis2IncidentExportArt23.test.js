'use strict';

// The printed incident register (GET /api/nis2/export/incident.html) carries
// the Article 23 record: the two statements the early warning must make
// (suspected malicious act, cross-border impact — 23(4)(a)), the authority's
// case reference, when each of the three reports was actually submitted and
// whether that beat its deadline, where the deadlines stand, and the event case
// the incident came from (migrations 122/123). Before this the CSV had them and
// the document an authority is handed did not.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeNis2IncidentsRepo, authHeader } = require('../test-support/fakes');
const I18n = require('../src/nis2/i18n');
const { incidentRegisterSections } = require('../src/nis2/report');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-09-20T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// Detected four days ago: early warning sent on time (10 h), notification sent
// LATE (80 h > 72 h), final report not sent (due a month after the
// notification, so still upcoming).
const REPORTED = {
  incidentId: 'INC-2026-007', title: 'Ransomware on file server', severity: 'critical', status: 'contained',
  nis2Relevant: true, notificationRequired: true, detectedAt: iso(NOW - 96 * HOUR),
  suspectedMalicious: true, crossBorderImpact: true, crossBorderDetails: 'Customers in SE and DE',
  authorityReference: 'CFCS-2026-0412',
  earlyWarningSubmittedAt: iso(NOW - 86 * HOUR), notificationSubmittedAt: iso(NOW - 16 * HOUR), finalReportSubmittedAt: null,
  eventCaseId: 41,
};
// No reporting duty, nothing recorded.
const MINOR = {
  incidentId: 'INC-2026-008', title: 'Lost badge', severity: 'low', status: 'closed',
  nis2Relevant: false, notificationRequired: false, detectedAt: iso(NOW - 2 * HOUR),
  suspectedMalicious: false, crossBorderImpact: false, crossBorderDetails: null, authorityReference: null,
  earlyWarningSubmittedAt: null, notificationSubmittedAt: null, finalReportSubmittedAt: null, eventCaseId: null,
};

const art23Row = (sections, ref) => {
  const sec = sections[1];
  const cols = sec.headers;
  const row = sec.rows.find((r) => r[0] === ref);
  return Object.fromEntries(cols.map((c, i) => [c, row[i]]));
};

test('the register keeps its overview table and adds the Article 23 table', () => {
  const t = I18n.createT('en');
  const sections = incidentRegisterSections([REPORTED, MINOR], t, { now: NOW });
  assert.equal(sections.length, 2);
  assert.equal(sections[0].heading, 'Incidents (2)');
  assert.deepEqual(sections[0].headers, ['Ref', 'Title', 'Severity', 'Detected', 'Resolved', 'Status', 'NIS2', 'Notify'], 'the overview a reader knows is unchanged');
  assert.equal(sections[1].heading, 'Article 23 reporting (2)');
  assert.deepEqual(sections[1].headers, [
    'Ref', 'Suspected malicious', 'Cross-border impact', 'Authority reference', 'Early warning sent',
    'Notification sent', 'Final report sent', 'Deadline status', 'Event case',
  ]);
});

test('every Art. 23 field reaches the row: late submissions say so, deadlines are computed', () => {
  const t = I18n.createT('en');
  const row = art23Row(incidentRegisterSections([REPORTED], t, { now: NOW }), 'INC-2026-007');
  assert.equal(row['Suspected malicious'], 'yes');
  assert.equal(row['Cross-border impact'], 'yes — Customers in SE and DE');
  assert.equal(row['Authority reference'], 'CFCS-2026-0412');
  assert.doesNotMatch(row['Early warning sent'], /late/, '10 h is inside the 24 h window');
  assert.match(row['Notification sent'], /\(late\)$/, '80 h is past the 72 h deadline');
  assert.equal(row['Final report sent'], '—');
  assert.equal(row['Deadline status'], 'upcoming', 'the final report is the one open stage, due a month after the notification');
  assert.equal(row['Event case'], 'case #41');
});

test('an incident with no reporting duty says "not required", not "overdue" or a blank', () => {
  const t = I18n.createT('en');
  const row = art23Row(incidentRegisterSections([MINOR], t, { now: NOW }), 'INC-2026-008');
  assert.equal(row['Suspected malicious'], 'no');
  assert.equal(row['Cross-border impact'], 'no');
  assert.equal(row['Authority reference'], '—');
  assert.equal(row['Deadline status'], 'not required');
  assert.equal(row['Event case'], '—');
});

test('an overdue stage shows as overdue; all submitted shows as all submitted', () => {
  const t = I18n.createT('en');
  const overdue = { ...REPORTED, incidentId: 'X', earlyWarningSubmittedAt: null, notificationSubmittedAt: null };
  assert.equal(art23Row(incidentRegisterSections([overdue], t, { now: NOW }), 'X')['Deadline status'], 'overdue');
  const done = { ...REPORTED, incidentId: 'Y', finalReportSubmittedAt: iso(NOW - HOUR) };
  assert.equal(art23Row(incidentRegisterSections([done], t, { now: NOW }), 'Y')['Deadline status'], 'all submitted');
});

test('the Art. 23 table is Danish in the Danish document', () => {
  const t = I18n.createT('da');
  const sections = incidentRegisterSections([REPORTED, MINOR], t, { now: NOW });
  assert.equal(sections[1].heading, 'Indberetning efter artikel 23 (2)');
  const row = art23Row(sections, 'INC-2026-007');
  assert.equal(row['Mistanke om ondsindet handling'], 'ja');
  assert.equal(row['Grænseoverskridende virkning'], 'ja — Customers in SE and DE');
  assert.match(row['Underretning sendt'], /\(for sent\)$/);
  assert.equal(row['Fristens status'], 'kommende');
  assert.equal(row.Sag, 'sag #41');
  assert.equal(art23Row(sections, 'INC-2026-008')['Fristens status'], 'ikke påkrævet');
});

test('GET /api/nis2/export/incident.html prints the Art. 23 record, escaped, in both locales', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  await nis2IncidentsRepo.create({
    title: 'Ransomware on file server', severity: 'critical', status: 'contained',
    nis2Relevant: true, notificationRequired: true, detectedAt: new Date(Date.now() - 96 * HOUR).toISOString(),
    suspectedMalicious: true, crossBorderImpact: true, crossBorderDetails: 'Customers in <SE> & DE',
    authorityReference: 'CFCS-2026-0412', earlyWarningSubmittedAt: new Date(Date.now() - 86 * HOUR).toISOString(),
    eventCaseId: 41,
  });
  const app = makeApp({ nis2IncidentsRepo });

  const en = await request(app).get('/api/nis2/export/incident.html').set('Authorization', authHeader('viewer'));
  assert.equal(en.status, 200);
  for (const needle of ['Article 23 reporting (1)', 'Suspected malicious', 'Authority reference', 'CFCS-2026-0412', 'case #41', 'Deadline status']) {
    assert.ok(en.text.includes(needle), `missing: ${needle}`);
  }
  assert.ok(en.text.includes('Customers in &lt;SE&gt; &amp; DE'), 'free text is escaped');
  assert.ok(!en.text.includes('<SE>'));

  const da = await request(app).get('/api/nis2/export/incident.html?locale=da').set('Authorization', authHeader('viewer'));
  assert.equal(da.status, 200);
  for (const needle of ['Indberetning efter artikel 23 (1)', 'Myndighedsreference', 'sag #41', 'Fristens status']) {
    assert.ok(da.text.includes(needle), `missing (da): ${needle}`);
  }
  for (const leak of ['Article 23 reporting', 'Authority reference', 'Deadline status']) {
    assert.ok(!da.text.includes(leak), `English leaked into the Danish register: ${leak}`);
  }

  assert.equal((await request(app).get('/api/nis2/export/incident.html')).status, 401);
});
