'use strict';

// Minimal, dependency-free CSV serialisation. Values are stringified, arrays
// joined with ';', Dates rendered ISO, objects JSON-encoded; any field
// containing a comma, quote or newline is wrapped in double quotes (and inner
// quotes doubled) per RFC4180.
function cell(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (Array.isArray(value)) s = value.join(';');
  else if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  // Neutralise CSV/formula injection: a leading =, +, -, @, TAB or CR makes the
  // cell a formula in Excel/LibreOffice. Prefix a single quote so a value such
  // as an agent-reported hostname can't smuggle a formula into an opened export.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Serialises rows (array of plain objects) to a CSV string using the given
// ordered column keys. Always emits a header row.
function toCsv(columns, rows) {
  const header = columns.join(',');
  const body = (rows || []).map((row) => columns.map((c) => cell(row[c])).join(',')).join('\n');
  return body ? `${header}\n${body}\n` : `${header}\n`;
}

module.exports = { toCsv, cell };
