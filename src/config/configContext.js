'use strict';

const { computeConfigDiff } = require('./diff');
const { classifyConfigDiff } = require('./risk');
const { maskConfigLine } = require('./mask');

// Aggregation cap on changed lines returned in an API diff.
const MAX_DIFF_LINES = 300;

// Builds a masked, risk-classified diff between two config texts for API
// exposure. NEVER returns raw config text — only masked changed lines, counts
// and the rule-based risk verdict.
function maskedDiff(oldText, newText) {
  const diff = computeConfigDiff(oldText, newText);
  const risk = classifyConfigDiff(diff);
  return {
    changed: diff.changed,
    stats: diff.stats,
    risk: risk.risk,
    riskReasons: risk.reasons,
    changedLines: diff.changedLines.slice(0, MAX_DIFF_LINES).map((l) => ({ op: l.op, text: maskConfigLine(l.text) })),
  };
}

module.exports = { maskedDiff, MAX_DIFF_LINES };
