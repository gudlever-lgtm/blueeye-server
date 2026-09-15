'use strict';

// The NIS2 documents are the one export where the language is not cosmetic: an
// executive report goes to management, and an Article 23 notification is built
// from the incident register for a national authority. This suite pins the
// server-side translation — that the locale actually reaches the document, that
// it cannot leak between concurrent requests, and that an unknown locale still
// produces a report instead of an error.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeNis2RisksRepo, makeNis2ControlsRepo, makeNis2IncidentsRepo, authHeader,
} = require('../test-support/fakes');
const I18n = require('../src/nis2/i18n');
const { computeDashboard, actionText } = require('../src/nis2/dashboard');
const { buildExecutiveReport, renderExecutiveHtml, managementConclusion } = require('../src/nis2/report');
const { sourcesFor, buildCustomReport } = require('../src/nis2/reportBuilder');

const EXPORTS = ['executive', 'readiness', 'risk', 'control', 'incident'];

async function seededApp() {
  const nis2RisksRepo = makeNis2RisksRepo();
  const nis2ControlsRepo = makeNis2ControlsRepo();
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  await nis2RisksRepo.create({
    title: 'Unpatched VPN gateway', category: 'Access Control', affectedAsset: 'vpn-01',
    likelihood: 5, impact: 5, owner: 'CISO', status: 'open',
  });
  await nis2ControlsRepo.create({
    controlName: 'Quarterly access review', nis2Area: 'Access Control',
    owner: 'IT', frequency: 'quarterly', status: 'Overdue',
  });
  await nis2IncidentsRepo.create({
    title: 'Phishing wave', severity: 'high', status: 'investigating',
    nis2Relevant: true, notificationRequired: true, detectedAt: new Date().toISOString(),
  });
  return makeApp({ nis2RisksRepo, nis2ControlsRepo, nis2IncidentsRepo });
}

// ---- catalogue -------------------------------------------------------------

test('the report catalogue is in parity across locales, including placeholders', () => {
  for (const locale of I18n.LOCALES) {
    assert.deepEqual(I18n.missingKeys(locale), [], `${locale} catalogue incomplete`);
  }
  const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort();
  for (const k of Object.keys(I18n.STRINGS.en)) {
    for (const locale of I18n.LOCALES) {
      assert.deepEqual(placeholders(I18n.STRINGS[locale][k]), placeholders(I18n.STRINGS.en[k]), `placeholder mismatch: ${k} (${locale})`);
    }
  }
});

test('resolveLocale accepts a bare locale, a BCP-47 tag and an Accept-Language header, and never throws', () => {
  assert.equal(I18n.resolveLocale('da'), 'da');
  assert.equal(I18n.resolveLocale('da-DK'), 'da');
  assert.equal(I18n.resolveLocale('da,en;q=0.8'), 'da');
  assert.equal(I18n.resolveLocale('fr-FR,fr;q=0.9,da;q=0.5'), 'da');
  for (const junk of ['', 'xx', 'zz-ZZ', null, undefined, 42, {}, []]) {
    assert.equal(I18n.resolveLocale(junk), 'en', `junk locale: ${JSON.stringify(junk)}`);
  }
});

test('an enum value with no translation renders as itself, not as a catalogue key', () => {
  const t = I18n.createT('da');
  assert.equal(t.enum('controlStatus', 'Overdue'), 'Overskredet');
  assert.equal(t.enum('controlStatus', 'SomethingNewInTheSchema'), 'SomethingNewInTheSchema');
  assert.equal(t.enum('controlStatus', null), '');
});

test('createT holds no shared state: two locales built side by side do not affect each other', () => {
  const en = I18n.createT('en');
  const da = I18n.createT('da');
  assert.equal(en('title.executive'), 'NIS2 Executive Report');
  assert.equal(da('title.executive'), 'NIS2-ledelsesrapport');
  assert.equal(en('title.executive'), 'NIS2 Executive Report', 'building a second translator changed the first');
});

// ---- the documents ---------------------------------------------------------

test('the executive report renders end to end in Danish: title, conclusion, headings, enums and <html lang>', () => {
  const data = {
    risks: [{ id: 1, title: 'R', category: 'Access Control', riskScore: 20, status: 'mitigating', owner: 'IT' }],
    controls: [{ id: 1, controlName: 'C', nis2Area: 'Access Control', status: 'Overdue', hasEvidence: false }],
    incidents: [{ incidentId: 'INC-1', title: 'I', severity: 'high', status: 'investigating', nis2Relevant: true, detectedAt: new Date().toISOString() }],
  };
  const dashboard = computeDashboard(data);
  const report = buildExecutiveReport({ ...data, dashboard, previous: null, locale: 'da' });
  const html = renderExecutiveHtml(report);

  assert.equal(report.locale, 'da');
  assert.equal(report.title, I18n.STRINGS.da['title.executive']);
  assert.match(html, /<html lang="da-DK"/);
  assert.ok(html.includes(I18n.STRINGS.da['exec.s7']), 'section headings are not translated');
  assert.ok(html.includes(I18n.STRINGS.da['cat.Access Control']), 'the NIS2 areas are not translated');
  assert.ok(html.includes(I18n.STRINGS.da['controlStatus.Overdue']), 'control status is not translated');
  assert.ok(html.includes(I18n.STRINGS.da['riskStatus.mitigating']), 'risk status is not translated');
  assert.ok(html.includes(I18n.STRINGS.da['doc.yes']), 'the generated yes/no is not translated');
  // Nothing from the English document may survive into the Danish one.
  for (const leak of ['Overall status', 'Recommended management decisions', 'No previous report']) {
    assert.ok(!html.includes(leak), `English leaked into the Danish report: ${leak}`);
  }
});

test('a recommended action is translated with its NIS2 area, not half-translated', () => {
  const d = computeDashboard({ controls: [{ nis2Area: 'Access Control', controlName: 'MFA review', status: 'Overdue', hasEvidence: false }] });
  const action = d.topActions[0];
  // The English `text` is still on the record — GET /dashboard has always
  // returned it and the dashboard screen still reads it.
  assert.equal(action.text, 'Perform the overdue control "MFA review" (Access Control)');
  assert.equal(actionText(action, I18n.createT('da')), 'Udfør den overskredne kontrol "MFA review" (Adgangsstyring)');
});

test('managementConclusion says the same thing in both locales and mentions every live exposure', () => {
  const dashboard = { readinessScore: 45, openCriticalRisks: 2, controlsWithoutEvidence: 3, incidentsLast30Days: 1 };
  for (const locale of I18n.LOCALES) {
    const text = managementConclusion(dashboard, locale);
    assert.ok(text.includes('45'), `${locale}: score missing`);
    assert.ok(text.includes('2') && text.includes('3') && text.includes('1'), `${locale}: a count is missing`);
    assert.ok(!text.includes('{'), `${locale}: an unfilled placeholder survived: ${text}`);
  }
  assert.notEqual(managementConclusion(dashboard, 'en'), managementConclusion(dashboard, 'da'));
});

// ---- routes ----------------------------------------------------------------

test('every /export/*.html honours ?locale=da (200) and defaults to English', async () => {
  const app = await seededApp();
  for (const name of EXPORTS) {
    const da = await request(app).get(`/api/nis2/export/${name}.html?locale=da`).set('Authorization', authHeader('viewer'));
    assert.equal(da.status, 200, `${name}: ${da.status}`);
    assert.match(da.headers['content-type'], /text\/html/);
    assert.match(da.text, /<html lang="da-DK"/, `${name} did not render in Danish`);

    const en = await request(app).get(`/api/nis2/export/${name}.html`).set('Authorization', authHeader('viewer'));
    assert.equal(en.status, 200, `${name}: ${en.status}`);
    assert.match(en.text, /<html lang="en-GB"/, `${name} did not default to English`);
  }
});

test('an export falls back to Accept-Language when no ?locale is given (200)', async () => {
  const app = await seededApp();
  const res = await request(app).get('/api/nis2/export/executive.html')
    .set('Authorization', authHeader('viewer')).set('Accept-Language', 'da-DK,da;q=0.9,en;q=0.5');
  assert.equal(res.status, 200);
  assert.match(res.text, /<html lang="da-DK"/);
});

test('an unknown or hostile ?locale still renders an English document (200), never a 400 or a 500', async () => {
  const app = await seededApp();
  for (const bad of ['fr', 'zz-ZZ', '../../etc/passwd', '<script>alert(1)</script>', 'a'.repeat(500)]) {
    const res = await request(app).get(`/api/nis2/export/executive.html?locale=${encodeURIComponent(bad)}`)
      .set('Authorization', authHeader('viewer'));
    assert.equal(res.status, 200, `locale=${bad} → ${res.status}`);
    assert.match(res.text, /<html lang="en-GB"/);
    assert.ok(!res.text.includes('<script>alert(1)</script>'), 'the locale parameter reached the document unescaped');
  }
});

test('the exports keep their auth and role gates whatever the locale (401/404)', async () => {
  const app = await seededApp();
  for (const name of EXPORTS) {
    assert.equal((await request(app).get(`/api/nis2/export/${name}.html?locale=da`)).status, 401, `${name} leaked without a token`);
  }
  const missing = await request(app).get('/api/nis2/export/nope.html?locale=da').set('Authorization', authHeader('viewer'));
  assert.equal(missing.status, 404);
});

test('a report generated in Danish stores its Danish title and summary (201)', async () => {
  const app = await seededApp();
  const res = await request(app).post('/api/nis2/reports?locale=da')
    .set('Authorization', authHeader('operator')).send({ reportType: 'executive' });
  assert.equal(res.status, 201);
  assert.equal(res.body.title, I18n.STRINGS.da['title.executive']);
  assert.ok(res.body.summary.includes('NIS2-modenhed'), `summary was not Danish: ${res.body.summary}`);
});

test('the Report Generator source catalogue is translated (200) and its filter VALUES stay untranslated', async () => {
  const app = await seededApp();
  const res = await request(app).get('/api/nis2/custom-reports/sources?locale=da').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  const byKey = Object.fromEntries(res.body.sources.map((s) => [s.key, s]));
  assert.equal(byKey.risks.label, I18n.STRINGS.da['src.risks.label']);
  assert.equal(byKey.risks.columns.find((c) => c.key === 'owner').label, I18n.STRINGS.da['col.owner']);

  // A translated dropdown must still filter on the value the register stores,
  // or picking "under håndtering" would match nothing.
  const status = byKey.risks.filters.find((f) => f.key === 'status');
  assert.deepEqual(status.options.map((o) => o.value), ['', 'open', 'mitigating', 'accepted', 'closed']);
  assert.equal(status.options.find((o) => o.value === 'mitigating').label, I18n.STRINGS.da['riskStatus.mitigating']);
});

test('a custom report translates its headings and headers but hands back the register\'s own values', () => {
  const spec = { sections: [{ source: 'risks', columns: ['title', 'status'] }] };
  const data = { risks: [{ id: 1, title: 'R', status: 'mitigating', riskScore: 20, hasEvidence: false }] };
  const report = buildCustomReport(spec, data, { isAdmin: false, locale: 'da' });
  const sec = report.sections[0];
  assert.equal(sec.heading, I18n.STRINGS.da['risk.heading'].replace('{n}', '1'));
  assert.deepEqual(sec.headers, [I18n.STRINGS.da['col.title'], I18n.STRINGS.da['col.status']]);
  assert.deepEqual(sec.rows, [['R', 'mitigating']], 'the Generator rewrote a stored value');
});

test('a custom export renders in the requested locale (200) and rejects the audit source for non-admins (403)', async () => {
  const app = await seededApp();
  const ok = await request(app).post('/api/nis2/custom-reports/export?locale=da')
    .set('Authorization', authHeader('viewer'))
    .send({ format: 'html', sections: [{ source: 'risks' }] });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /<html lang="da-DK"/);

  const denied = await request(app).post('/api/nis2/custom-reports/export?locale=da')
    .set('Authorization', authHeader('viewer'))
    .send({ format: 'html', sections: [{ source: 'audit' }] });
  assert.equal(denied.status, 403);
});

test('two concurrent exports in different languages do not cross over', async () => {
  const app = await seededApp();
  const [da, en] = await Promise.all([
    request(app).get('/api/nis2/export/executive.html?locale=da').set('Authorization', authHeader('viewer')),
    request(app).get('/api/nis2/export/executive.html?locale=en').set('Authorization', authHeader('viewer')),
  ]);
  assert.equal(da.status, 200);
  assert.equal(en.status, 200);
  assert.match(da.text, /<html lang="da-DK"/);
  assert.match(en.text, /<html lang="en-GB"/);
  assert.ok(da.text.includes(I18n.STRINGS.da['exec.s1']));
  assert.ok(en.text.includes(I18n.STRINGS.en['exec.s1']));
});

test('a repository failure during a localized export is a 500, not a half-rendered document', async () => {
  const nis2RisksRepo = makeNis2RisksRepo();
  nis2RisksRepo.findAll = async () => { throw new Error('db down'); };
  const res = await request(makeApp({ nis2RisksRepo })).get('/api/nis2/export/risk.html?locale=da')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 500);
  assert.ok(!/<html/.test(res.text), 'a failed export still sent document markup');
});

test('sourcesFor hides the admin-only audit source from non-admins in every locale', () => {
  for (const locale of I18n.LOCALES) {
    assert.ok(!sourcesFor(false, locale).some((s) => s.key === 'audit'), `${locale}: audit source leaked to a non-admin`);
    assert.ok(sourcesFor(true, locale).some((s) => s.key === 'audit'), `${locale}: audit source missing for an admin`);
  }
});
