'use strict';

// Minimal, dependency-free print-ready HTML for reports. The browser's
// "Print → Save as PDF" turns this into a PDF client-side — the same approach
// the NIS2 module uses, keeping the server free of any (US-vendor) PDF library.
// All interpolated values are HTML-escaped, so report data can never inject markup.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Renders a standalone, self-styled HTML document: a heading, an optional
// subtitle/meta line, and one table built from { columns:[{key,label}], rows:[] }.
function renderReportHtml({ title, subtitle = '', columns = [], rows = [] }) {
  const head = columns.map((c) => `<th>${escapeHtml(c.label || c.key)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${columns.map((c) => `<td>${escapeHtml(row[c.key])}</td>`).join('')}</tr>`)
    .join('');
  const generated = new Date().toISOString();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #555; margin: 0 0 18px; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; }
  tr:nth-child(even) td { background: #fafafa; }
  @media print { body { margin: 0; } @page { margin: 16mm; } }
</style></head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">${escapeHtml(subtitle)}${subtitle ? ' · ' : ''}Generated ${escapeHtml(generated)}</p>
  <table><thead><tr>${head}</tr></thead><tbody>${body || '<tr><td>No data</td></tr>'}</tbody></table>
</body></html>`;
}

module.exports = { renderReportHtml, escapeHtml };
