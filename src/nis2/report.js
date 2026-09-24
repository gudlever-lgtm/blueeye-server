'use strict';

const { riskBand } = require('./constants');
const { createT } = require('./i18n');
const { actionText } = require('./dashboard');
const { computeIncidentDeadlines } = require('./deadlines');

// Minimal HTML escape for the server-rendered, print-to-PDF report document.
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// The headline metrics frozen onto a report so the NEXT report can show the
// delta. Kept small + stable (only what "development since last report" needs).
function buildSnapshot(dashboard) {
  return {
    readinessScore: dashboard.readinessScore,
    openCriticalRisks: dashboard.openCriticalRisks,
    openHighMediumFindings: dashboard.openHighMediumFindings,
    incidentsLast30Days: dashboard.incidentsLast30Days,
    controlsWithoutEvidence: dashboard.controlsWithoutEvidence,
  };
}

// Computes the change of each snapshot metric vs a previous report's snapshot.
// Returns null when there's no comparable prior report.
function deltaFrom(previousSnapshot, current) {
  if (!previousSnapshot) return null;
  const d = {};
  for (const k of Object.keys(current)) {
    const before = Number(previousSnapshot[k]);
    const after = Number(current[k]);
    d[k] = { before: Number.isFinite(before) ? before : null, after, change: Number.isFinite(before) ? after - before : null };
  }
  return d;
}

// Plain-language management conclusion derived from the readiness score + the
// most pressing exposures. Deliberately short and non-technical. `locale`
// defaults to English, which is also what POST /reports freezes onto the stored
// record — the stored summary is one language by definition, and the live
// export re-renders it in whichever the reader asked for.
function managementConclusion(dashboard, locale) {
  const t = createT(locale);
  const s = dashboard.readinessScore;
  let posture;
  if (s >= 80) posture = t('concl.posture.good');
  else if (s >= 60) posture = t('concl.posture.gaps');
  else if (s >= 40) posture = t('concl.posture.partial');
  else posture = t('concl.posture.early');

  const parts = [t('concl.headline', { score: s, posture })];
  if (dashboard.openCriticalRisks > 0) {
    parts.push(t('concl.criticalRisks', { n: dashboard.openCriticalRisks }));
  }
  if (dashboard.controlsWithoutEvidence > 0) {
    parts.push(t('concl.noEvidence', { n: dashboard.controlsWithoutEvidence }));
  }
  if (dashboard.incidentsLast30Days > 0) {
    parts.push(t('concl.incidents', { n: dashboard.incidentsLast30Days }));
  }
  if (dashboard.openCriticalRisks === 0 && dashboard.controlsWithoutEvidence === 0) {
    parts.push(t('concl.clean'));
  }
  return parts.join(' ');
}

// Builds the structured executive report (a plain object of sections) from the
// computed dashboard + the underlying records, plus the previous report for the
// trend section. The router persists `snapshot` and renders `sections` to HTML.
function buildExecutiveReport({ dashboard, risks = [], controls = [], incidents = [], previous = null, locale }) {
  const t = createT(locale);
  const snapshot = buildSnapshot(dashboard);
  const delta = deltaFrom(previous && previous.snapshot, snapshot);

  const openRisks = risks
    .filter((r) => r.status === 'open' || r.status === 'mitigating')
    .sort((a, b) => b.riskScore - a.riskScore);
  const topRisks = openRisks.slice(0, 5);

  const significantIncidents = incidents
    .filter((i) => i.severity === 'high' || i.severity === 'critical' || i.nis2Relevant)
    .slice(0, 10);

  const missingControls = controls
    .filter((c) => !c.hasEvidence || c.status === 'Missing' || c.status === 'Overdue');

  return {
    locale: t.locale,
    title: t('title.executive'),
    generatedAt: dashboard.generatedAt,
    snapshot,
    summary: managementConclusion(dashboard, t.locale),
    sections: {
      overallStatus: {
        readinessScore: dashboard.readinessScore,
        categories: dashboard.categories,
        totals: dashboard.totals,
      },
      riskOverview: {
        openCriticalRisks: dashboard.openCriticalRisks,
        openHighMediumFindings: dashboard.openHighMediumFindings,
        topRisks,
      },
      significantIncidents,
      missingControls,
      development: delta,
      recommendedDecisions: dashboard.topActions,
      conclusion: managementConclusion(dashboard, t.locale),
    },
  };
}

// ---- Print-ready HTML -----------------------------------------------------

function table(headers, rows, t = createT('en')) {
  if (!rows.length) return `<p class="muted">${esc(t('doc.none'))}</p>`;
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function deltaCell(d) {
  if (!d || d.change == null) return '—';
  const sign = d.change > 0 ? '+' : '';
  return `${d.before} → ${d.after} (${sign}${d.change})`;
}

// Renders the executive report to a standalone, self-contained HTML document
// suitable for the browser's "Print → Save as PDF" (no external assets, clean
// print CSS). Mirrors the BlueEyes palette in a light, document-friendly form.
function renderExecutiveHtml(report, { org, locale } = {}) {
  // The report object already knows the language it was built in; an explicit
  // `locale` only overrides it when a caller renders a stored report in another.
  const t = createT(locale || report.locale);
  const orgName = org || t('doc.org');
  const dash = t('doc.dash');
  const s = report.sections;
  const cats = s.overallStatus.categories
    .map((c) => [t.enum('cat', c.category), c.controlCount, `${c.score}%`, t.enum('catStatus', c.status)]);
  const risks = s.riskOverview.topRisks
    .map((r) => [r.title, t.enum('cat', r.category), t.enum('band', riskBand(r.riskScore)), r.riskScore, r.owner || dash, t.enum('riskStatus', r.status)]);
  const incidents = s.significantIncidents
    .map((i) => [i.incidentId, i.title, t.enum('severity', i.severity), t.enum('incidentStatus', i.status), t.yesNo(i.nis2Relevant), t.yesNo(i.notificationRequired)]);
  const controls = s.missingControls
    .map((c) => [c.controlName, t.enum('cat', c.nis2Area), t.enum('controlStatus', c.status), t.yesNo(c.hasEvidence), c.owner || dash]);
  const decisions = s.recommendedDecisions
    .map((a) => `<li><strong>[${esc(t.enum('priority', a.priority))}]</strong> ${esc(actionText(a, t))}</li>`).join('');

  let developmentHtml = `<p class="muted">${esc(t('exec.noBaseline'))}</p>`;
  if (s.development) {
    const d = s.development;
    developmentHtml = table(
      [t('col.metric'), t('col.change')],
      [
        [t('metric.readiness'), deltaCell(d.readinessScore)],
        [t('metric.criticalRisks'), deltaCell(d.openCriticalRisks)],
        [t('metric.findings'), deltaCell(d.openHighMediumFindings)],
        [t('metric.incidents30short'), deltaCell(d.incidentsLast30Days)],
        [t('metric.noEvidence'), deltaCell(d.controlsWithoutEvidence)],
      ],
      t
    );
  }

  return `<!DOCTYPE html>
<html lang="${esc(t.htmlLang)}"><head><meta charset="utf-8"/>
<title>${esc(report.title)}</title>
<style>
  :root { --ink:#1a2230; --muted:#5b6675; --line:#d7dde6; --accent:#2563a8; --bg:#fff; }
  * { box-sizing:border-box; }
  body { font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:var(--ink); background:var(--bg); margin:0; padding:32px; }
  h1 { font-size:24px; margin:0 0 4px; color:var(--accent); }
  h2 { font-size:17px; margin:28px 0 8px; border-bottom:2px solid var(--line); padding-bottom:4px; }
  .meta { color:var(--muted); font-size:12px; margin-bottom:16px; }
  .score { font-size:40px; font-weight:700; color:var(--accent); }
  .summary { background:#f3f7fb; border-left:4px solid var(--accent); padding:12px 16px; border-radius:4px; }
  table { border-collapse:collapse; width:100%; margin:8px 0; font-size:12.5px; }
  th,td { border:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; }
  th { background:#eef2f7; }
  .muted { color:var(--muted); }
  ul { margin:8px 0; padding-left:20px; }
  .kpis { display:flex; gap:16px; flex-wrap:wrap; margin:12px 0; }
  .kpi { border:1px solid var(--line); border-radius:6px; padding:10px 14px; min-width:120px; }
  .kpi b { display:block; font-size:22px; }
  @media print { body { padding:0; } h2 { page-break-after:avoid; } table { page-break-inside:avoid; } }
</style></head>
<body>
  <h1>${esc(report.title)}</h1>
  <div class="meta">${esc(orgName)} · ${esc(t('doc.generated', { when: new Date(report.generatedAt).toLocaleString(t.htmlLang) }))}</div>

  <h2>${esc(t('exec.s1'))}</h2>
  <div class="kpis">
    <div class="kpi"><span class="muted">${esc(t('exec.kpi.readiness'))}</span><b>${s.overallStatus.readinessScore}%</b></div>
    <div class="kpi"><span class="muted">${esc(t('exec.kpi.criticalRisks'))}</span><b>${s.riskOverview.openCriticalRisks}</b></div>
    <div class="kpi"><span class="muted">${esc(t('exec.kpi.findings'))}</span><b>${s.riskOverview.openHighMediumFindings}</b></div>
    <div class="kpi"><span class="muted">${esc(t('exec.kpi.noEvidence'))}</span><b>${s.missingControls.length}</b></div>
  </div>
  ${table([t('col.category'), t('col.controls'), t('col.score'), t('col.status')], cats, t)}

  <h2>${esc(t('exec.s2'))}</h2>
  ${table([t('col.risk'), t('col.category'), t('col.band'), t('col.score'), t('col.owner'), t('col.status')], risks, t)}

  <h2>${esc(t('exec.s3'))}</h2>
  ${table([t('col.ref'), t('col.title'), t('col.severity'), t('col.status'), t('col.nis2'), t('col.notify')], incidents, t)}

  <h2>${esc(t('exec.s4'))}</h2>
  ${table([t('col.control'), t('col.area'), t('col.status'), t('col.evidence'), t('col.owner')], controls, t)}

  <h2>${esc(t('exec.s5'))}</h2>
  ${developmentHtml}

  <h2>${esc(t('exec.s6'))}</h2>
  ${decisions ? `<ul>${decisions}</ul>` : `<p class="muted">${esc(t('exec.noActions'))}</p>`}

  <h2>${esc(t('exec.s7'))}</h2>
  <p class="summary">${esc(s.conclusion)}</p>
</body></html>`;
}

// Shared print-ready document chrome (same palette/print CSS as the executive
// report) wrapping arbitrary body HTML — used by the register/readiness PDFs.
function renderDocument(title, org, bodyHtml, t = createT('en')) {
  return `<!DOCTYPE html>
<html lang="${esc(t.htmlLang)}"><head><meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
  :root { --ink:#1a2230; --muted:#5b6675; --line:#d7dde6; --accent:#2563a8; --bg:#fff; }
  * { box-sizing:border-box; }
  body { font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color:var(--ink); background:var(--bg); margin:0; padding:32px; }
  h1 { font-size:24px; margin:0 0 4px; color:var(--accent); }
  h2 { font-size:17px; margin:28px 0 8px; border-bottom:2px solid var(--line); padding-bottom:4px; }
  .meta { color:var(--muted); font-size:12px; margin-bottom:16px; }
  table { border-collapse:collapse; width:100%; margin:8px 0; font-size:12.5px; }
  th,td { border:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; }
  th { background:#eef2f7; }
  .muted { color:var(--muted); }
  @media print { body { padding:0; } h2 { page-break-after:avoid; } table { page-break-inside:avoid; } }
</style></head>
<body>
  <h1>${esc(title)}</h1>
  <div class="meta">${esc(org)} · ${esc(t('doc.generated', { when: new Date().toLocaleString(t.htmlLang) }))}</div>
  ${bodyHtml}
</body></html>`;
}

// Renders a multi-section table report (risk register / control evidence /
// incident register / readiness) into a print-ready HTML document. Each section
// is { heading, headers, rows } where rows is an array of cell-value arrays.
function renderRegisterHtml(title, sections, { org, locale } = {}) {
  const t = createT(locale);
  const body = sections.map((sec) => {
    const intro = sec.intro ? `<p class="muted">${esc(sec.intro)}</p>` : '';
    return `<h2>${esc(sec.heading)}</h2>${intro}${table(sec.headers, sec.rows, t)}`;
  }).join('\n');
  return renderDocument(title, org || t('doc.org'), body, t);
}

// The incident register as print sections (GET /api/nis2/export/incident.html):
// the overview table it always had, then the Article 23 reporting record —
// suspected malicious act and cross-border impact (23(4)(a)), the authority's
// reference, when each of the three reports was actually submitted (and
// whether that beat its deadline), where the deadlines stand, and the event
// case the incident was drafted from (migrations 122/123).
//
// Two tables rather than one seventeen-column one: this is a document that is
// printed, and the second table is the part an authority asks about.
//
// Deadlines are COMPUTED here exactly as the dashboard computes them
// (src/nis2/deadlines.js), so the printout and the screen cannot disagree.
function incidentRegisterSections(rows, t, { now = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const dash = t('doc.dash');
  const when = (v) => (v ? new Date(v).toLocaleString(t.htmlLang) : dash);
  const submitted = (stage) => {
    if (!stage || !stage.submittedAt) return dash;
    const at = when(stage.submittedAt);
    return stage.onTime === false ? t('art23.late', { when: at }) : at;
  };
  const deadlineStatus = (d) => {
    if (!d.applicable) return t('art23.notRequired');
    if (!d.stages.length) return t('art23.noDetection');
    return t.enum('deadlineStatus', d.worstStatus);
  };
  const crossBorder = (i) => {
    if (!i.crossBorderImpact) return t.yesNo(false);
    return i.crossBorderDetails ? t('art23.crossBorderDetails', { details: i.crossBorderDetails }) : t.yesNo(true);
  };
  return [
    {
      heading: t('incident.heading', { n: list.length }),
      intro: t('incident.intro'),
      headers: [t('col.ref'), t('col.title'), t('col.severity'), t('col.detected'), t('col.resolved'), t('col.status'), t('col.nis2'), t('col.notify')],
      rows: list.map((i) => [i.incidentId, i.title, t.enum('severity', i.severity), when(i.detectedAt), when(i.resolvedAt), t.enum('incidentStatus', i.status), t.yesNo(i.nis2Relevant), t.yesNo(i.notificationRequired)]),
    },
    {
      heading: t('art23.heading', { n: list.length }),
      intro: t('art23.intro'),
      headers: [t('col.ref'), t('col.suspectedMalicious'), t('col.crossBorder'), t('col.authorityRef'), t('col.earlyWarningSubmitted'), t('col.notificationSubmitted'), t('col.finalReportSubmitted'), t('col.deadlineStatus'), t('col.eventCase')],
      rows: list.map((i) => {
        const d = computeIncidentDeadlines(i, { now });
        const stage = (name) => d.stages.find((s) => s.stage === name);
        return [
          i.incidentId,
          t.yesNo(i.suspectedMalicious),
          crossBorder(i),
          i.authorityReference || dash,
          // A recorded submission is shown even when the incident carries no
          // reporting duty — it happened, and the register says so.
          stage('early-warning') ? submitted(stage('early-warning')) : when(i.earlyWarningSubmittedAt),
          stage('notification') ? submitted(stage('notification')) : when(i.notificationSubmittedAt),
          stage('final-report') ? submitted(stage('final-report')) : when(i.finalReportSubmittedAt),
          deadlineStatus(d),
          i.eventCaseId != null ? t('art23.eventCase', { id: i.eventCaseId }) : dash,
        ];
      }),
    },
  ];
}

module.exports = {
  buildExecutiveReport, buildSnapshot, deltaFrom, managementConclusion,
  renderExecutiveHtml, renderRegisterHtml, incidentRegisterSections, esc,
};
