'use strict';

const { computeInterfaceHealth } = require('./interfaceHealth');
const { diffInterfaceStates, isReversal } = require('./interfaceStateDiff');

// Records interface state transitions at the results-ingest seam (Fase 2b).
//
// WHY HERE. Interfaces are not persisted in this codebase — health is computed
// on the fly from `results.payload.traffic`. The changes feed therefore could
// not report interface up/down, the dimension a technician asks about most.
//
// Polling current state to reconstruct that history was explicitly ruled out: a
// poller sees whatever is true when it looks, misses everything in between, and
// produces a change log that quietly lies about timing. This instead hooks the
// one place that sees EVERY observation — the ingest path where state is already
// being determined — and records the change as it happens.
//
// Best-effort throughout, exactly like the LLDP topology-change service it
// mirrors: an agent's results report is its lifeline, and a bookkeeping side
// effect must never be able to cost it.

// A reversal within this window is a flap, not two independent changes.
const DEFAULT_FLAP_WINDOW_SECONDS = 300;

function createInterfaceStateService({
  interfaceStatesRepo,
  flapWindowSeconds = DEFAULT_FLAP_WINDOW_SECONDS,
  now = () => new Date(),
  logger = null,
} = {}) {
  // Picks the traffic payload out of a batch of results. An agent posts a batch;
  // the LAST traffic sample is the current one, and diffing against an older
  // sample in the same batch would emit transitions the agent already superseded.
  function latestTraffic(results) {
    let latest = null;
    for (const r of Array.isArray(results) ? results : []) {
      const traffic = r && r.payload && r.payload.traffic;
      if (traffic && Array.isArray(traffic.interfaces)) latest = traffic;
    }
    return latest;
  }

  // Processes one results report. Returns { transitions, flapped } for tests and
  // callers that want to know; swallows its own errors otherwise.
  async function processResults(agentId, results) {
    const out = { transitions: [], flapped: 0 };
    if (!interfaceStatesRepo) return out;

    const traffic = latestTraffic(results);
    if (!traffic) return out; // a probe-only or flow-only report has no interfaces

    const at = now();
    const current = computeInterfaceHealth(traffic);
    if (!current.length) return out;

    const prevStates = await interfaceStatesRepo.statesForAgent(agentId);
    const { transitions, states } = diffInterfaceStates(prevStates, current, { at });

    // The snapshot is upserted even when nothing changed — last_seen moving is
    // what lets retention distinguish "still there and steady" from "gone".
    await interfaceStatesRepo.upsertStates(agentId, states, { at });

    if (!transitions.length) return out;

    const flapSince = new Date(at.getTime() - flapWindowSeconds * 1000);
    for (const t of transitions) {
      // Does this reverse a recent transition on the same interface? If so it is
      // a flap: collapse onto that row rather than adding a second one. An
      // interface bouncing every 20 seconds is ONE finding — "flapping 14×" —
      // not 14 rows nobody can read.
      let previous = null;
      try {
        previous = await interfaceStatesRepo.latestForIface({ agentId, iface: t.iface, since: flapSince });
      } catch (err) {
        if (logger) logger.warn(`interface-state: flap lookup failed for agent ${agentId} (${err.message})`);
      }

      const asRow = previous
        ? { iface: previous.iface, from_status: previous.fromStatus, to_status: previous.toStatus }
        : null;
      const candidate = { iface: t.iface, from_status: t.fromStatus, to_status: t.toStatus };

      // Collapse when this reverses the previous transition — OR when that row
      // is ALREADY marked flapping.
      //
      // The second clause matters: a collapsed row keeps describing the FIRST
      // direction it saw (ok→down), so the third bounce (ok→down again) does not
      // reverse it and would open a second row, then a third. Once an interface
      // is known to be bouncing inside the window, every further transition on it
      // belongs to that same finding — "flapping 14×" — which is the whole point
      // of collapsing in the first place.
      if (asRow && (isReversal(asRow, candidate) || previous.flapping)) {
        await interfaceStatesRepo.markFlapping(previous.id, { at });
        out.flapped += 1;
        continue;
      }

      const id = await interfaceStatesRepo.insertTransition(agentId, t);
      out.transitions.push({ ...t, id });
    }

    return out;
  }

  return { processResults, latestTraffic };
}

module.exports = { createInterfaceStateService, DEFAULT_FLAP_WINDOW_SECONDS };
