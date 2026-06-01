'use strict';

// Shared enums for the analysis module. Plain frozen objects (CommonJS) so they
// are safe to reuse as constant references across detector, store and API.

// Severity of a finding, in ascending order of urgency.
const Severity = Object.freeze({
  INFO: 'INFO',
  WARN: 'WARN',
  CRIT: 'CRIT',
});

// What kind of condition produced the finding.
const FindingKind = Object.freeze({
  ANOMALY: 'ANOMALY', // statistical deviation from baseline (z-score)
  THRESHOLD: 'THRESHOLD', // crossed a configured absolute threshold
  FLATLINE: 'FLATLINE', // metric stopped changing (sensor/agent stall)
  CORRELATED: 'CORRELATED', // grouped with other findings by the correlator
});

module.exports = { Severity, FindingKind };
