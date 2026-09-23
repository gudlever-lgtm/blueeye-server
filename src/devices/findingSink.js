'use strict';

// The one place a RULE-BASED device finding goes once something has decided to
// raise it: stored, pushed to the dashboards, grouped into an event case,
// alerted on, handed to the outbound integrations.
//
// WHY THIS EXISTS. The counter path gets all of that from the analysis
// pipeline's batch handling, because its findings come out of the detector. The
// findings raised by a fixed rule on a switch — a loop, a link going down, a port
// flapping, a half-duplex port collecting late collisions — do not go through
// the detector, and until now each of them wired the steps it happened to
// remember: the loop detector stored, published and grouped, and never alerted
// (the dispatcher was not wired at all). A loop on the core switch opened an
// event case and paged nobody.
//
// One sink, the same steps in the same order as the pipeline's, so a finding
// about a switch reaches exactly the places a finding about a host does:
//
//   store -> publish -> event case -> alert (behind the alerting flag,
//   suppressed when an open cluster already covers the host) -> integrations
//
// Every step after the store is best-effort. The store is not: a finding that
// could not be saved is not raised, and `emit` answers null so the caller does
// not start a refractory period for something nobody will ever see.
//
// `dispatcher` may be the dispatcher or a function returning it. The server
// builds the SNMP ingest before the alerting dispatcher exists, so it hands in a
// getter; reading it at emit time is what makes that late binding work.

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function createDeviceFindingSink({
  findingStore = null,
  eventCaseService = null,
  publishFinding = () => {},
  dispatcher = null,
  alertingEnabled = false,
  integrationTrigger = null,
  clusterAlertGate = null,
  // Findings are an analysis feature: the same licence + config gate the
  // detector path applies. A live getter, so a runtime change applies.
  enabled = () => true,
  logger = silentLogger,
} = {}) {
  const log = logger || silentLogger;

  function resolveDispatcher() {
    const d = typeof dispatcher === 'function' ? dispatcher() : dispatcher;
    return d && typeof d.dispatch === 'function' ? d : null;
  }

  function isOn(flag) {
    return typeof flag === 'function' ? Boolean(flag()) : Boolean(flag);
  }

  async function suppressed(finding) {
    if (!clusterAlertGate || typeof clusterAlertGate.suppressedCluster !== 'function') return false;
    try {
      if (typeof clusterAlertGate.ensureFresh === 'function') await clusterAlertGate.ensureFresh();
    } catch { /* a stale gate falls back to alerting per finding */ }
    try { return Boolean(clusterAlertGate.suppressedCluster(finding)); } catch { return false; }
  }

  // Raises one finding. Returns it, or null when it was not stored.
  async function emit(finding) {
    if (!finding || !isOn(enabled)) return null;
    if (findingStore) {
      try {
        await findingStore.save(finding);
      } catch (err) {
        log.error(`device-finding: could not save ${finding.metric} (${err.message})`);
        return null;
      }
    }
    try { publishFinding(finding.hostId, { type: 'finding', payload: finding }); } catch (err) {
      log.warn(`device-finding: publish failed (${err.message})`);
    }
    if (eventCaseService && typeof eventCaseService.assignFinding === 'function') {
      try { await eventCaseService.assignFinding(finding); } catch (err) {
        log.warn(`device-finding: event assignment failed for ${finding.id} (${err.message})`);
      }
    }
    const quiet = await suppressed(finding);
    const d = resolveDispatcher();
    if (d && isOn(alertingEnabled) && !quiet) {
      try { await d.dispatch(finding, null); } catch (err) {
        log.warn(`device-finding: dispatch failed for ${finding.id} (${err.message})`);
      }
    }
    if (!quiet && integrationTrigger && typeof integrationTrigger.emitFinding === 'function') {
      try { integrationTrigger.emitFinding(finding).catch(() => {}); } catch { /* never affects ingestion */ }
    }
    return finding;
  }

  return { emit };
}

module.exports = { createDeviceFindingSink };
