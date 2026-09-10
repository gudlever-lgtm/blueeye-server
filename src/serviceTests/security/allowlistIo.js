'use strict';

const { toCsv } = require('../../lib/csv');
const { validateEntry } = require('./hostPolicy');

// Import and export for the per-application host allowlist.
//
// Operators arrive with a list — a spreadsheet column of hostnames, a range from
// the network team — so typing entries one at a time is not the normal path
// (docs/service-assurance.md §6). Export reuses src/lib/csv.js, which already carries
// the formula-injection guard. Import is parsed here rather than in a shared lib
// so the module keeps its extraction boundary.
//
// The import contract is deliberately strict: EVERY row is validated before
// ANYTHING is written, and one bad row rejects the whole file with the offending
// line numbers. A half-applied allowlist is a security control in an unknown
// state, which is worse than a rejected paste.

const MAX_ENTRIES = 1000;
const MAX_BYTES = 1024 * 1024; // 1 MB
const COLUMNS = ['type', 'value', 'note'];

// A tolerant line/CSV reader. Accepts:
//   10.20.0.0/16
//   cidr,10.20.0.0/16,Kundens LAN
//   "host","portal.kunde.dk","Frontend"
// plus a header row, blank lines and # comments. Quotes are honoured; a bare
// value column is enough, and the type is then inferred by parseEntry.
function parseLines(text) {
  const rows = [];
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cells = splitCsvLine(trimmed);
    // Skip a header row, however it is capitalised.
    if (i === 0 && cells.length > 1 && /^(type|entry_type)$/i.test(cells[0]) && /^value$/i.test(cells[1])) continue;
    if (cells.length === 1) {
      rows.push({ line: i + 1, type: null, value: cells[0], note: null });
    } else {
      // A single column that happens to contain a comma is not a thing here:
      // with 2+ cells the first is the type when it names one, else it is the value.
      const first = cells[0].toLowerCase();
      if (['host', 'ip', 'cidr'].includes(first)) {
        rows.push({ line: i + 1, type: first, value: cells[1] || '', note: cells[2] || null });
      } else {
        rows.push({ line: i + 1, type: null, value: cells[0], note: cells[1] || null });
      }
    }
  }
  return rows;
}

// Minimal RFC4180-ish single-line splitter: quoted cells, doubled quotes inside.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else inQuotes = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',' || ch === ';' || ch === '\t') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter((c, idx) => c !== '' || idx === 0);
}

// Validates a pasted list against the deny-list and the caps.
//
// Returns { value: { entries, added, unchanged, total_addresses } } or
// { errors } keyed by line number, so the UI can point at the offending row.
// The address cap is applied to the WHOLE resulting set, not per row — importing
// twenty /24s must not sneak past a limit that a single /19 would hit.
function validateImport(text, { settings, existing = [] } = {}) {
  const bytes = Buffer.byteLength(String(text == null ? '' : text), 'utf8');
  if (bytes > MAX_BYTES) {
    return { errors: { file: `the list is too large (${Math.round(bytes / 1024)} KB; the limit is ${MAX_BYTES / 1024} KB)` } };
  }
  const rows = parseLines(text);
  if (!rows.length) return { errors: { file: 'the list is empty' } };
  if (rows.length > MAX_ENTRIES) {
    return { errors: { file: `too many entries (${rows.length}; the limit is ${MAX_ENTRIES})` } };
  }

  const errors = {};
  const accepted = [];
  const seen = new Set();
  // Grows as rows are accepted, so the cap is judged against the running total.
  const running = existing.slice();

  for (const row of rows) {
    const { value, errors: rowErrors } = validateEntry(row.value, row.type, { settings, existing: running });
    if (rowErrors) {
      errors[`line ${row.line}`] = `${row.value || '(empty)'}: ${rowErrors.value}`;
      continue;
    }
    if (seen.has(value.value)) continue; // a duplicate inside the file is not an error
    seen.add(value.value);
    const entry = { ...value, note: row.note ? String(row.note).slice(0, 255) : null, line: row.line };
    accepted.push(entry);
    running.push(value);
  }

  if (Object.keys(errors).length) return { errors };

  const existingValues = new Set(existing.map((e) => e.value));
  return {
    value: {
      entries: accepted.map(({ line, ...e }) => e), // eslint-disable-line no-unused-vars
      added: accepted.filter((e) => !existingValues.has(e.value)).length,
      unchanged: accepted.filter((e) => existingValues.has(e.value)).length,
      total: accepted.length,
    },
  };
}

// CSV for download. Reuses toCsv so the formula-injection guard applies — an
// entry note beginning with `=` must not execute when the file is opened in a
// spreadsheet.
function toCsvExport(entries) {
  // toCsv takes rows as objects keyed by the column names, not positional arrays.
  const rows = (entries || []).map((e) => ({ type: e.entry_type, value: e.value, note: e.note || '' }));
  return toCsv(COLUMNS, rows);
}

module.exports = { validateImport, toCsvExport, parseLines, splitCsvLine, MAX_ENTRIES, MAX_BYTES, COLUMNS };
