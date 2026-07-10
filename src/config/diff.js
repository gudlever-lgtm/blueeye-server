'use strict';

const { diffLines, structuredPatch } = require('diff');

// Diff-generation between two device-config snapshots. Uses the `diff` library
// (established — not hand-rolled) and shapes its output into a compact structure
// the risk classifier (point 3) and the history endpoint (point 5) build on:
//
//   {
//     changed: boolean,
//     stats: { added, removed },
//     changedLines: [ { op: '+'|'-', text } ],   // only the changed lines
//     patch: <unified-diff string>               // for display
//   }
//
// Inputs are raw text; a null/undefined side is treated as empty, so the very
// first snapshot diffs cleanly against "".

function normalize(text) {
  if (typeof text === 'string') return text;
  return text == null ? '' : String(text);
}

// Splits a diff part's value into lines, dropping the trailing empty element a
// final newline produces (so "b\n" → ["b"], not ["b", ""]).
function linesOf(value) {
  const lines = value.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function hunkToString(h) {
  const header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n`;
  return `${header}${h.lines.join('\n')}\n`;
}

function computeConfigDiff(oldText, newText, { context = 3 } = {}) {
  const a = normalize(oldText);
  const b = normalize(newText);

  const changedLines = [];
  let added = 0;
  let removed = 0;

  for (const part of diffLines(a, b)) {
    if (!part.added && !part.removed) continue;
    const op = part.added ? '+' : '-';
    for (const text of linesOf(part.value)) {
      changedLines.push({ op, text });
      if (op === '+') added += 1; else removed += 1;
    }
  }

  const changed = added > 0 || removed > 0;
  const patch = changed
    ? structuredPatch('config', 'config', a, b, '', '', { context }).hunks.map(hunkToString).join('')
    : '';

  return { changed, stats: { added, removed }, changedLines, patch };
}

module.exports = { computeConfigDiff };
