'use strict';

// Post-remediation verification (Fase 3). After a playbook is run against an open
// cluster's targets, we schedule a verification run; once the settle window has
// elapsed a leader-only sweep re-checks the affected targets for FRESH findings
// of the relevant finding-types and records the outcome:
//
//   cleared (no fresh symptoms)  → 'passed'  → suggest resolution in the UI
//   symptoms persist             → 'failed'  → cluster stays open (readings kept)
//   re-check could not run        → 'error'  (surfaced, never silent)
//
// It NEVER auto-resolves a cluster — clustering/verification informs; a human
// decides. All outcomes are audit-logged via the existing hash-chained audit and
// surfaced on the cluster timeline (the 'verification' source reads these rows).
//
// "Re-run the relevant anomaly checks" is done locally + explainably against the
// existing finding store: a fresh, unacknowledged finding of a relevant type on
// an affected target AFTER the playbook ran means the symptom did not clear.

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const DEFAULT_SETTLE_SECONDS = 5 * 60;
const MAX_READINGS = 20;

function toMs(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function createVerificationService({
  verificationRunsRepo,
  findingStore,
  auditLogger = null,
  publishCluster = () => {},
  now = () => new Date(),
  logger = silentLogger,
}) {
  // Records a verification run for a just-executed playbook. Returns the created
  // run (or null on failure — the caller decides how loud to be).
  async function schedule({
    clusterId, playbookId = null, runbookId = null, triggeredBy = 'system',
    affectedTargets = [], findingTypes = [], settleSeconds = DEFAULT_SETTLE_SECONDS,
  }) {
    const executedAt = now();
    const settle = Number.isFinite(settleSeconds) && settleSeconds >= 0 ? Math.round(settleSeconds) : DEFAULT_SETTLE_SECONDS;
    const dueAt = new Date(executedAt.getTime() + settle * 1000);
    try {
      const id = await verificationRunsRepo.create({
        clusterId, playbookId, runbookId, triggeredBy,
        affectedTargets, findingTypes, settleSeconds: settle, executedAt, dueAt,
      });
      return await verificationRunsRepo.findById(id);
    } catch (err) {
      logger.warn(`verification: could not schedule for cluster ${clusterId} (${err.message})`);
      return null;
    }
  }

  // Re-checks one run: fresh, unacknowledged findings of a relevant type on the
  // affected targets, created AFTER the playbook ran. Returns { status, readings }.
  async function recheck(run) {
    const since = new Date(toMs(run.executedAt));
    const wantTypes = new Set((run.findingTypes || []).map(String));
    const readings = [];
    let checked = 0;
    for (const target of run.affectedTargets || []) {
      let fresh = [];
      try {
        fresh = await findingStore.list(String(target), since, 200); // eslint-disable-line no-await-in-loop
      } catch (err) {
        logger.warn(`verification: finding lookup failed for target ${target} (${err.message})`);
        return { status: 'error', readings: null };
      }
      checked += 1;
      for (const f of Array.isArray(fresh) ? fresh : []) {
        if (!f || f.acked) continue;                 // an acknowledged finding is not an active symptom
        if (!wantTypes.has(String(f.metric))) continue;
        readings.push({
          target: String(target), metric: f.metric, severity: f.severity,
          observed: f.observed ?? null, deviation: f.deviation ?? null, at: f.createdAt || null,
        });
      }
    }
    if (checked === 0) return { status: 'error', readings: null }; // nothing to check against
    return readings.length
      ? { status: 'failed', readings: readings.slice(0, MAX_READINGS) }
      : { status: 'passed', readings: null };
  }

  // Audit + WS-publish one completed verification (best-effort).
  async function announce(run, outcome) {
    const action = `verification_${outcome.status}`;
    const detail = outcome.status === 'passed'
      ? `Verification passed — no fresh symptoms on ${(run.affectedTargets || []).length} target(s) after settle.`
      : outcome.status === 'failed'
        ? `Verification failed — ${outcome.readings.length} symptom(s) persist (${[...new Set(outcome.readings.map((r) => r.metric))].join(', ')}).`
        : 'Verification could not run (re-check error).';
    if (auditLogger && typeof auditLogger.record === 'function') {
      try {
        await auditLogger.record(null, {
          category: 'incident', action, target: String(run.clusterId),
          actorEmail: 'system', actorRole: 'system', detail,
        });
      } catch (err) { logger.warn(`verification: audit failed (${err.message})`); }
    }
    try {
      publishCluster({ id: run.clusterId, verification: { id: run.id, status: outcome.status, suggestResolve: outcome.status === 'passed' } });
    } catch { /* best-effort */ }
  }

  // One sweep: complete every due-pending run. Never auto-resolves. Returns a
  // summary { checked, passed, failed, error }. Never throws.
  async function runDue() {
    const summary = { checked: 0, passed: 0, failed: 0, error: 0 };
    let due = [];
    try {
      due = await verificationRunsRepo.listDuePending(now());
    } catch (err) {
      logger.warn(`verification: could not list due runs (${err.message})`);
      return summary;
    }
    for (const run of due) {
      try {
        const outcome = await recheck(run);
        const ok = await verificationRunsRepo.complete(run.id, {
          status: outcome.status, readings: outcome.readings, completedAt: now(),
        });
        if (!ok) continue; // lost the race to another sweep
        summary.checked += 1;
        summary[outcome.status] += 1;
        await announce(run, outcome);
      } catch (err) {
        logger.warn(`verification: could not complete run ${run.id} (${err.message})`);
      }
    }
    if (summary.checked) logger.info(`verification: completed ${summary.checked} run(s) — ${summary.passed} passed, ${summary.failed} failed, ${summary.error} error.`);
    return summary;
  }

  return { schedule, recheck, runDue, DEFAULT_SETTLE_SECONDS };
}

module.exports = { createVerificationService, DEFAULT_SETTLE_SECONDS };
