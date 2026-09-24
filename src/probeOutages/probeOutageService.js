'use strict';

const crypto = require('crypto');
const { groupRows, deriveSequenceState, METRICS } = require('./detection');
const { DIAGNOSTIC_TYPES } = require('../repositories/probeResultsRepository');
const { MAX_REFIRE_COOLDOWN_MS } = require('../eventCases/activityWindow');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// True when severity `a` is strictly more severe than `b` (critical > warning).
const isWorse = (a, b) => a === 'critical' && b === 'warning';

// Derives outages from active-probe results. Runs AFTER probe-results ingest
// (the active-probe twin of the analysis pipeline) — it does not persist probe
// rows itself; it reads the agent's recent rows, computes the DESIRED outage
// state per (metric, target) with threshold + debounce rules, then reconciles
// against the stored outages: opens new ones, resolves recovered ones, and
// never creates a duplicate active outage for the same tuple.
//
// Best-effort and resilient — a failure here must never break ingestion.
//
// NOTIFYING. An outage used to be recorded and reported on, and nobody was
// ever told: nothing dispatched it. Now:
//   * OPEN (and an escalation warning → critical) raises a finding
//     `probe_outage.<metric>` through the finding sink — stored, grouped into
//     the agent's event case, alerted (behind the alerting switch, the
//     maintenance silencer and the dispatcher cooldown), handed to the
//     integrations. The explanation names the threshold and how long the run
//     has lasted.
//   * CLOSE dispatches one recovery alert (same severity as the outage, so it
//     reaches the channels the opening did) through the same dispatcher —
//     which applies the same switch and silencer — and writes a system note
//     with the duration onto the event case the opening finding landed in.
//
// ONE FAULT, ONE ALERT. The probe pipeline (analysis/probePipeline.js) runs on
// the same rows first and raises `probe.reachability` / `probe.loss` /
// `probe.latency` for a failing target. Without care the same fault paged two
// or three times: the pipeline's finding, this outage's reachability finding,
// and a packet_loss outage on top (a target that does not answer has 100 %
// loss). So:
//   * a packet_loss outage is not opened (or escalated) for a target whose
//     reachability outage is open — the reachability outage already IS it;
//   * an outage finding whose agent + target the pipeline already raised within
//     the refire cooldown (MAX_REFIRE_COOLDOWN_MS — the pipeline's own
//     de-dupe horizon, so that finding is the live one) is stored, published and
//     grouped into the event case as usual, but sends no alert of its own. The
//     RECOVERY alert on close is still sent: the pipeline has no "recovered"
//     message, so it is the only one that says the fault is over.
//
// Diagnostic probe types (path_mtu, tls, rdns, dhcp — DIAGNOSTIC_TYPES) are
// not reachability samples of their target and never open an outage: a
// failing DHCP broadcast on eth0 is not "eth0 is down".
//
//   const svc = createProbeOutageService({ probeOutagesRepo, thresholdsRepo, agentsRepo, probeResultsRepo,
//     findingSink, findingStore, dispatcher, eventNotesRepo });
//   await svc.processAgent(agentId);
function createProbeOutageService({
  probeOutagesRepo,
  thresholdsRepo,
  agentsRepo,
  probeResultsRepo,
  // Optional notification path (all nullable → the outage is only recorded,
  // as before). `dispatcher` may be the dispatcher or a getter for it.
  findingSink = null,
  findingStore = null,
  dispatcher = null,
  eventNotesRepo = null,
  windowMs = 24 * 3600 * 1000, // how far back to look when reconciling
  now = () => new Date(),
  logger = silentLogger,
}) {
  const SEV = { critical: 'CRIT', warning: 'WARN' };
  const METRIC_TEXT = { reachability: 'reachability', latency: 'latency', packet_loss: 'packet loss' };
  const UNIT = { latency: ' ms', packet_loss: '%' };

  function minutesBetween(from, to) {
    return Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000));
  }

  // "warning ≥ 150 ms, critical ≥ 300 ms, 3 results in a row" — the rule the
  // outage was judged by, as the explanation states it.
  function thresholdText(metric, t) {
    const debounce = Number.isInteger(t.debounce_count) && t.debounce_count > 0 ? t.debounce_count : 3;
    if (metric === 'reachability') return `${debounce} failed probes in a row`;
    const u = UNIT[metric] || '';
    const parts = [];
    if (t.warning_value != null) parts.push(`warning ≥ ${t.warning_value}${u}`);
    if (t.critical_value != null) parts.push(`critical ≥ ${t.critical_value}${u}`);
    parts.push(`${debounce} results in a row`);
    return parts.join(', ');
  }

  function evidenceOf({ agentId, metric, target, severity, threshold, startedAt, at, outageId, resolvedAt = null }) {
    return {
      hostId: String(agentId),
      metric: `probe_outage.${metric}`,
      value: severity === 'critical' ? 2 : 1,
      ts: at,
      target,
      outageId,
      severity,
      startedAt: new Date(startedAt).toISOString(),
      resolvedAt: resolvedAt ? new Date(resolvedAt).toISOString() : null,
      durationSeconds: Math.max(0, Math.round((new Date(resolvedAt || at).getTime() - new Date(startedAt).getTime()) / 1000)),
      threshold: {
        warning: threshold.warning_value ?? null,
        critical: threshold.critical_value ?? null,
        debounce: threshold.debounce_count ?? null,
        scope: threshold.location_id != null ? 'location' : 'global',
      },
    };
  }

  // Raises the finding for an outage that just opened (or escalated).
  async function raiseOpen({ agentId, metric, target, severity, threshold, startedAt, outageId, escalated = false }) {
    if (!findingSink || typeof findingSink.emit !== 'function') return;
    const at = now();
    const alreadyAlerted = await pipelineRaised(agentId, metric, target, at);
    const mins = minutesBetween(startedAt, at);
    const what = `${METRIC_TEXT[metric] || metric} to ${target}`;
    const explanation = `${escalated ? 'Probe outage escalated to critical' : `Probe outage (${severity})`}: ${what} `
      + `has breached its threshold (${thresholdText(metric, threshold)}) since ${new Date(startedAt).toISOString()} `
      + `— ${mins} min so far.`;
    try {
      await findingSink.emit({
        id: crypto.randomUUID(),
        hostId: String(agentId),
        deviceId: null,
        interfaceId: null,
        metric: `probe_outage.${metric}`,
        severity: SEV[severity] || 'WARN',
        kind: 'THRESHOLD',
        observed: mins,
        baseline: null,
        deviation: null,
        window: [new Date(startedAt), at],
        explanation,
        evidence: [evidenceOf({ agentId, metric, target, severity, threshold, startedAt, at, outageId })],
        correlatedWith: [],
        createdAt: at,
        acked: false,
      }, { alert: !alreadyAlerted });
    } catch (err) {
      logger.warn(`outages: could not raise the finding for outage ${outageId} (${err.message})`);
    }
  }

  // The probe-pipeline findings that report the same fault as an outage of
  // `metric` (see "ONE FAULT, ONE ALERT" above).
  const PIPELINE_METRICS = {
    reachability: ['probe.reachability'],
    packet_loss: ['probe.loss', 'probe.reachability'],
    latency: ['probe.latency'],
  };

  // True when the probe pipeline raised a finding for this agent + target
  // within the refire cooldown — that finding was (or was eligible to be)
  // alerted, so the outage finding does not alert again. A store that cannot
  // be read answers false: alerting twice beats not alerting at all.
  async function pipelineRaised(agentId, metric, target, at) {
    if (!findingStore || typeof findingStore.list !== 'function') return false;
    const since = new Date(at.getTime() - MAX_REFIRE_COOLDOWN_MS);
    for (const m of PIPELINE_METRICS[metric] || []) {
      try {
        const rows = await findingStore.list(String(agentId), since, 200, undefined, { metric: m });
        if ((rows || []).some((f) => f && Array.isArray(f.evidence) && f.evidence[0]
          && String(f.evidence[0].target) === String(target))) return true;
      } catch (err) {
        logger.warn(`outages: could not check the probe findings of ${agentId} (${err.message})`);
        return false;
      }
    }
    return false;
  }

  // The event case the outage's opening finding landed in, or null.
  async function caseOf(agentId, metric, outageId, startedAt) {
    if (!findingStore || typeof findingStore.list !== 'function') return null;
    try {
      const since = new Date(new Date(startedAt).getTime() - 60 * 1000);
      const rows = await findingStore.list(String(agentId), since, 50, undefined, { metric: `probe_outage.${metric}` });
      const hit = (rows || []).find((f) => f && f.eventCaseId != null && Array.isArray(f.evidence)
        && f.evidence[0] && Number(f.evidence[0].outageId) === Number(outageId));
      return hit ? hit.eventCaseId : null;
    } catch (err) {
      logger.warn(`outages: could not find the event case of outage ${outageId} (${err.message})`);
      return null;
    }
  }

  // One recovery alert + a note on the event case, for an outage that closed.
  async function notifyClosed({ agentId, metric, target, active, threshold, resolvedAt }) {
    const d = typeof dispatcher === 'function' ? dispatcher() : dispatcher;
    const canAlert = d && typeof d.dispatch === 'function';
    const canNote = eventNotesRepo && typeof eventNotesRepo.append === 'function';
    if (!canAlert && !canNote) return;
    const startedAt = active.startedAt;
    const mins = minutesBetween(startedAt, resolvedAt);
    const severity = active.severity || 'warning';
    const text = `Probe outage resolved: ${METRIC_TEXT[metric] || metric} to ${target} recovered at `
      + `${new Date(resolvedAt).toISOString()} after ${mins} min (${severity}; threshold ${thresholdText(metric, threshold)}).`;
    const eventCaseId = await caseOf(agentId, metric, active.id, startedAt);
    if (canAlert) {
      try {
        // Finding-shaped, NOT stored: a recovery is not a new fault. Same
        // severity as the outage so it reaches the channels the opening did;
        // its own kind so the opening's cooldown does not swallow it.
        await d.dispatch({
          id: `probe-outage-${active.id}-resolved`,
          hostId: String(agentId),
          metric: `probe_outage.${metric}`,
          kind: 'RECOVERED',
          severity: SEV[severity] || 'WARN',
          explanation: text,
          deviation: null,
          eventCaseId,
          evidence: [evidenceOf({ agentId, metric, target, severity, threshold, startedAt, at: now(), outageId: active.id, resolvedAt })],
          createdAt: now(),
        }, null);
      } catch (err) {
        logger.warn(`outages: recovery alert failed for outage ${active.id} (${err.message})`);
      }
    }
    if (canNote && eventCaseId != null) {
      try {
        await eventNotesRepo.append({ eventCaseId, kind: 'observation', text, authorRole: 'system' });
      } catch (err) {
        logger.warn(`outages: could not note the recovery on event ${eventCaseId} (${err.message})`);
      }
    }
  }

  // Caches the effective threshold per (locationId, metric) for one pass.
  function thresholdLoader(locationId) {
    const cache = new Map();
    return async (metric) => {
      if (cache.has(metric)) return cache.get(metric);
      const t = await thresholdsRepo.getEffective(locationId, metric);
      cache.set(metric, t);
      return t;
    };
  }

  async function processAgent(agentId) {
    let agent;
    try {
      agent = await agentsRepo.findById(agentId);
    } catch (err) {
      logger.warn(`outages: could not load agent ${agentId} (${err.message})`);
      return { opened: 0, resolved: 0 };
    }
    if (!agent) return { opened: 0, resolved: 0 };
    const locationId = agent.location_id ?? null;

    let rows;
    try {
      // findByAgent returns oldest-first — exactly what the sequence walk wants.
      rows = await probeResultsRepo.findByAgent({
        agentId,
        from: new Date(now().getTime() - windowMs),
        limit: 5000,
      });
    } catch (err) {
      logger.warn(`outages: could not load probe rows for ${agentId} (${err.message})`);
      return { opened: 0, resolved: 0 };
    }
    if (!Array.isArray(rows) || rows.length === 0) return { opened: 0, resolved: 0 };
    // Diagnostics measure the path or the segment, not whether the target
    // answers (see DIAGNOSTIC_TYPES) — a failing DHCP/TLS test must not open a
    // critical reachability outage on "eth0" or a certificate host.
    rows = rows.filter((r) => !DIAGNOSTIC_TYPES.includes(r && r.type));
    if (rows.length === 0) return { opened: 0, resolved: 0 };

    const getThreshold = thresholdLoader(locationId);
    let opened = 0;
    let resolved = 0;
    // Targets with an open reachability outage after this pass. Reachability
    // groups are reconciled first so packet_loss can consult it.
    const unreachable = new Set();
    const ORDER = { reachability: 0, latency: 1, packet_loss: 2 };
    const groups = groupRows(rows).sort((a, b) => (ORDER[a.metric] ?? 9) - (ORDER[b.metric] ?? 9));

    for (const group of groups) {
      if (!METRICS.includes(group.metric)) continue;
      let threshold;
      try {
        threshold = await getThreshold(group.metric);
      } catch (err) {
        logger.warn(`outages: threshold lookup failed (${group.metric}): ${err.message}`);
        continue;
      }
      if (!threshold) continue; // no threshold configured ⇒ nothing to derive

      const desired = deriveSequenceState(group.rows, group.metric, threshold);

      let active;
      try {
        active = await probeOutagesRepo.findActive(agentId, group.metric, group.target);
      } catch (err) {
        logger.warn(`outages: active lookup failed (${err.message})`);
        continue;
      }

      if (group.metric === 'reachability'
        && (desired.open || (active && !(desired.lastRecoveryAt || desired.firstHealthyAt)))) unreachable.add(group.target);
      // 100 % loss to a target that does not answer IS the reachability outage;
      // a second, packet_loss outage would only page again for it. An already
      // open packet_loss outage is left to recover on its own.
      const coveredByReachability = group.metric === 'packet_loss' && unreachable.has(group.target);

      try {
        if (desired.open && coveredByReachability) {
          // nothing to open or escalate
        } else if (desired.open) {
          if (!active) {
            const outageId = await probeOutagesRepo.open({
              location_id: locationId,
              agent_id: agentId,
              metric: group.metric,
              severity: desired.severity,
              started_at: desired.startedAt,
              affected_target: group.target,
            });
            opened += 1;
            await raiseOpen({
              agentId, metric: group.metric, target: group.target, severity: desired.severity,
              threshold, startedAt: desired.startedAt, outageId,
            });
          } else if (isWorse(desired.severity, active.severity)) {
            // No duplicate — but escalate the existing outage when the run has
            // crossed into a higher severity (e.g. warning → critical), so the
            // reports/NIS2 draft don't keep showing the stale severity.
            const ok = await probeOutagesRepo.updateSeverity(active.id, desired.severity);
            if (ok !== false) {
              await raiseOpen({
                agentId, metric: group.metric, target: group.target, severity: desired.severity,
                threshold, startedAt: active.startedAt || desired.startedAt, outageId: active.id, escalated: true,
              });
            }
          }
        } else if (active) {
          // The service is healthy again. Prefer the recovery transition the
          // window actually saw; fall back to the first healthy sample for the
          // case where the failing run scrolled out of the lookback (so the
          // outage still resolves instead of lingering active forever).
          const recoveryAt = desired.lastRecoveryAt || desired.firstHealthyAt;
          if (recoveryAt) {
            const ok = await probeOutagesRepo.resolve(active.id, recoveryAt);
            if (ok) {
              resolved += 1;
              await notifyClosed({ agentId, metric: group.metric, target: group.target, active, threshold, resolvedAt: recoveryAt });
            }
          }
        }
      } catch (err) {
        logger.error(`outages: reconcile failed for ${group.metric}/${group.target} (${err.message})`);
      }
    }

    return { opened, resolved };
  }

  return { processAgent };
}

module.exports = { createProbeOutageService };
