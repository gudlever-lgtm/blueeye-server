'use strict';

const { riskBand } = require('./constants');

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
// most pressing exposures. Deliberately short and non-technical.
function managementConclusion(dashboard) {
  const s = dashboard.readinessScore;
  let posture;
  if (s >= 80) posture = 'broadly in good shape';
  else if (s >= 60) posture = 'progressing but with gaps that need management attention';
  else if (s >= 40) posture = 'only partially prepared, with material gaps';
  else posture = 'at an early stage of NIS2 readiness, with significant gaps';

  const parts = [`Overall NIS2 readiness stands at ${s}%, meaning the organisation is ${posture}.`];
  if (dashboard.openCriticalRisks > 0) {
    parts.push(`${dashboard.openCriticalRisks} critical risk(s) remain open and warrant a documented management decision.`);
  }
  if (dashboard.controlsWithoutEvidence > 0) {
    parts.push(`${dashboard.controlsWithoutEvidence} control(s) lack current evidence and should be prioritised.`);
  }
  if (dashboard.incidentsLast30Days > 0) {
    parts.push(`${dashboard.incidentsLast30Days} security incident(s) were recorded in the last 30 days; any with a notification obligation must be reviewed promptly.`);
  }
  if (dashboard.openCriticalRisks === 0 && dashboard.controlsWithoutEvidence === 0) {
    parts.push('No critical risks are open and all controls carry evidence — focus can shift to sustaining and auditing the programme.');
  }
  return parts.join(' ');
}

// Builds the structured executive report (a plain object of sections) from the
// computed dashboard + the underlying records, plus the previous report for the
// trend section. The router persists `snapshot` and renders `sections` to HTML.
function buildExecutiveReport({ dashboard, risks = [], controls = [], incidents = [], previous = null }) {
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
    title: 'NIS2 Executive Report',
    generatedAt: dashboard.generatedAt,
    snapshot,
    summary: managementConclusion(dashboard),
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
      conclusion: managementConclusion(dashboard),
    },
  };
}

// ---- Print-ready HTML -----------------------------------------------------

function table(headers, rows) {
  if (!rows.length) return '<p class="muted">None.</p>';
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
// print CSS). Mirrors the BlueEye palette in a light, document-friendly form.
function renderExecutiveHtml(report, { org = 'Organisation' } = {}) {
  const s = report.sections;
  const cats = s.overallStatus.categories
    .map((c) => [c.category, c.controlCount, `${c.score}%`, c.status]);
  const risks = s.riskOverview.topRisks
    .map((r) => [r.title, r.category, riskBand(r.riskScore), r.riskScore, r.owner || '—', r.status]);
  const incidents = s.significantIncidents
    .map((i) => [i.incidentId, i.title, i.severity, i.status, i.nis2Relevant ? 'yes' : 'no', i.notificationRequired ? 'yes' : 'no']);
  const controls = s.missingControls
    .map((c) => [c.controlName, c.nis2Area, c.status, c.hasEvidence ? 'yes' : 'no', c.owner || '—']);
  const decisions = s.recommendedDecisions.map((a) => `<li><strong>[${esc(a.priority)}]</strong> ${esc(a.text)}</li>`).join('');

  let developmentHtml = '<p class="muted">No previous report to compare against — this is the baseline.</p>';
  if (s.development) {
    const d = s.development;
    developmentHtml = table(
      ['Metric', 'Change'],
      [
        ['Readiness score', deltaCell(d.readinessScore)],
        ['Open critical risks', deltaCell(d.openCriticalRisks)],
        ['Open high/medium findings', deltaCell(d.openHighMediumFindings)],
        ['Incidents (30d)', deltaCell(d.incidentsLast30Days)],
        ['Controls without evidence', deltaCell(d.controlsWithoutEvidence)],
      ]
    );
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
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
  <div class="meta">${esc(org)} · Generated ${esc(new Date(report.generatedAt).toLocaleString('en-GB'))}</div>

  <h2>1. Overall status</h2>
  <div class="kpis">
    <div class="kpi"><span class="muted">Readiness</span><b>${s.overallStatus.readinessScore}%</b></div>
    <div class="kpi"><span class="muted">Open critical risks</span><b>${s.riskOverview.openCriticalRisks}</b></div>
    <div class="kpi"><span class="muted">High/medium findings</span><b>${s.riskOverview.openHighMediumFindings}</b></div>
    <div class="kpi"><span class="muted">Controls w/o evidence</span><b>${s.missingControls.length}</b></div>
  </div>
  ${table(['Category', 'Controls', 'Score', 'Status'], cats)}

  <h2>2. Risk overview</h2>
  ${table(['Risk', 'Category', 'Band', 'Score', 'Owner', 'Status'], risks)}

  <h2>3. Significant incidents</h2>
  ${table(['Ref', 'Title', 'Severity', 'Status', 'NIS2', 'Notify'], incidents)}

  <h2>4. Missing controls</h2>
  ${table(['Control', 'Area', 'Status', 'Evidence', 'Owner'], controls)}

  <h2>5. Development since last report</h2>
  ${developmentHtml}

  <h2>6. Recommended management decisions</h2>
  ${decisions ? `<ul>${decisions}</ul>` : '<p class="muted">No outstanding actions.</p>'}

  <h2>7. Conclusion</h2>
  <p class="summary">${esc(s.conclusion)}</p>
</body></html>`;
}

// Shared print-ready document chrome (same palette/print CSS as the executive
// report) wrapping arbitrary body HTML — used by the register/readiness PDFs.
function renderDocument(title, org, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
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
  <div class="meta">${esc(org)} · Generated ${esc(new Date().toLocaleString('en-GB'))}</div>
  ${bodyHtml}
</body></html>`;
}

// Renders a multi-section table report (risk register / control evidence /
// incident register / readiness) into a print-ready HTML document. Each section
// is { heading, headers, rows } where rows is an array of cell-value arrays.
function renderRegisterHtml(title, sections, { org = 'Organisation' } = {}) {
  const body = sections.map((sec) => {
    const intro = sec.intro ? `<p class="muted">${esc(sec.intro)}</p>` : '';
    return `<h2>${esc(sec.heading)}</h2>${intro}${table(sec.headers, sec.rows)}`;
  }).join('\n');
  return renderDocument(title, org, body);
}

module.exports = {
  buildExecutiveReport, buildSnapshot, deltaFrom, managementConclusion,
  renderExecutiveHtml, renderRegisterHtml, esc,
};
