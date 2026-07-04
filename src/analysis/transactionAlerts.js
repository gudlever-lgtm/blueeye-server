'use strict';

// Pure threshold evaluation for a transaction result. Produces an alerting
// `finding` (the same contract the dispatcher consumes: hostId/metric/kind/
// severity/explanation/evidence) or null when no threshold is crossed.
//
// Debounce/dedup is NOT done here — the dispatcher throttles per
// `${hostId}|${metric}|${kind}|${severity}` within its cooldown, so a stable
// choice of those fields per (agent, test, threshold-type) is what keeps one
// ongoing problem from spamming.
//
//   recentStatuses: the most recent statuses for (test, agent), NEWEST-FIRST,
//   including the current result (the caller inserts before evaluating).
function evaluateTransactionAlert({ test, agentId, result, recentStatuses = [] }) {
  const thr = test && test.thresholds ? test.thresholds : null;
  if (!thr) return null;

  const evidence = [{
    testId: test.id,
    testName: test.name,
    agentId,
    status: result.status,
    latencyMs: result.latency_ms ?? null,
    target: test.name,
  }];

  // consecutive_fails: count the leading run of non-ok statuses.
  if (Number.isInteger(thr.consecutive_fails) && thr.consecutive_fails > 0) {
    let streak = 0;
    for (const s of recentStatuses) { if (s !== 'ok') streak += 1; else break; }
    if (streak >= thr.consecutive_fails) {
      return {
        id: `tx-fail-${test.id}-${agentId}`,
        hostId: String(agentId),
        metric: 'transaction.fail',
        kind: 'TRANSACTION_FAIL',
        severity: 'CRIT',
        explanation: `Transaktionstest "${test.name}" fejlede ${streak} gange i træk (tærskel ${thr.consecutive_fails}).`,
        evidence,
        deviation: streak,
        createdAt: new Date(),
      };
    }
  }

  // latency_ms: only meaningful for a successful run that was too slow.
  if (Number.isInteger(thr.latency_ms) && thr.latency_ms > 0
      && result.status === 'ok' && result.latency_ms != null && result.latency_ms > thr.latency_ms) {
    return {
      id: `tx-latency-${test.id}-${agentId}`,
      hostId: String(agentId),
      metric: 'transaction.latency',
      kind: 'TRANSACTION_LATENCY',
      severity: 'WARN',
      explanation: `Transaktionstest "${test.name}" latenstid ${result.latency_ms} ms overskred tærskel ${thr.latency_ms} ms.`,
      evidence,
      deviation: result.latency_ms - thr.latency_ms,
      createdAt: new Date(),
    };
  }

  return null;
}

module.exports = { evaluateTransactionAlert };
