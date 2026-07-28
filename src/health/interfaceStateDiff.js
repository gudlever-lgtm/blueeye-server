'use strict';

// Pure diff of interface state between two observations (Fase 2b).
//
// Takes the previously-stored states for an agent and the interfaces just
// computed by computeInterfaceHealth, and returns the transitions between them.
// No I/O, no clock (the caller passes `at`), no database — so the promotion
// rules below are testable exactly.

const { IFACE_RANK } = require('./interfaceHealth');

// How a transition maps to a change-feed severity.
//
// A link going DOWN on a real interface is the thing a technician is usually
// looking for, so it is CRIT. Degradation (errors, saturation) is WARN.
// Recovery is INFO — good news must never be surfaced at the severity of the
// fault it ended, or the page stays red for things that are now fine.
function severityFor(from, to, virtual) {
  if (to === 'down') return virtual ? 'INFO' : 'CRIT';
  if (to === 'bad') return 'WARN';
  if (to === 'warn') return 'WARN';
  // to === 'ok'
  if (from === 'down' || from === 'bad') return 'INFO';
  return 'INFO';
}

function summaryFor(iface, from, to, virtual) {
  if (from == null) return `${iface} first seen ${to}`;
  if (to === 'down') {
    // A down virtual interface (docker0, veth…) is idle, not faulty; saying so
    // is what stops the feed reading like an outage every time a container exits.
    return virtual ? `${iface} (virtual) went down` : `${iface} link went down`;
  }
  if (from === 'down') return `${iface} link came back up`;
  return `${iface} went ${from} → ${to}`;
}

// True when `b` reverses `a` — the same interface returning to where it was.
// That is what a flap IS, and detecting it is what keeps an interface bouncing
// every 20 seconds from filling the change feed with unreadable noise.
function isReversal(a, b) {
  return Boolean(a && b
    && a.iface === b.iface
    && a.from_status === b.to_status
    && a.to_status === b.from_status);
}

// Compares stored states against freshly-computed interfaces.
//
//   prevStates: [{ iface, status, oper_status, virtual }]
//   current:    computeInterfaceHealth() output
//
// Returns { transitions, states } where `states` is the full current set to
// upsert (including unchanged ones — their last_seen still moves).
//
// DELIBERATELY NOT EMITTED:
//   * A first-ever sighting is a transition with from_status NULL only when the
//     interface starts in a non-ok state. An interface that appears healthy is
//     not news, and announcing every interface on every new agent would bury the
//     real changes on the day an agent is enrolled.
//   * A DISAPPEARED interface. An interface missing from one report is far more
//     often a collection hiccup (an SNMP timeout, a truncated payload) than an
//     interface that ceased to exist, and "eth0 vanished" is an alarming thing
//     to say wrongly. Its stored state simply stops being refreshed and ages out.
function diffInterfaceStates(prevStates, current, { at } = {}) {
  const prevByIface = new Map();
  for (const p of Array.isArray(prevStates) ? prevStates : []) {
    if (p && p.iface != null) prevByIface.set(String(p.iface), p);
  }

  const transitions = [];
  const states = [];

  for (const iface of Array.isArray(current) ? current : []) {
    if (!iface || iface.iface == null) continue;
    const name = String(iface.iface);
    const to = iface.status;
    const virtual = !!iface.virtual;
    const prev = prevByIface.get(name);

    states.push({
      iface: name,
      status: to,
      operStatus: iface.operStatus || null,
      virtual,
    });

    if (!prev) {
      // First sighting: only worth a row if it is already unhealthy.
      if (to !== 'ok') {
        transitions.push({
          iface: name,
          fromStatus: null,
          toStatus: to,
          operStatus: iface.operStatus || null,
          severity: severityFor(null, to, virtual),
          summary: summaryFor(name, null, to, virtual),
          detectedAt: at,
          virtual,
        });
      }
      continue;
    }

    if (prev.status === to) continue; // no change

    transitions.push({
      iface: name,
      fromStatus: prev.status,
      toStatus: to,
      operStatus: iface.operStatus || null,
      severity: severityFor(prev.status, to, virtual),
      summary: summaryFor(name, prev.status, to, virtual),
      detectedAt: at,
      virtual,
    });
  }

  return { transitions, states };
}

// True when a transition is a worsening (used by callers that only care about
// degradation). Exported because "did this get worse or better" is the question
// every consumer asks, and three of them re-deriving it from IFACE_RANK would
// drift.
function isWorsening(fromStatus, toStatus) {
  const a = IFACE_RANK[fromStatus];
  const b = IFACE_RANK[toStatus];
  if (a === undefined || b === undefined) return false;
  return b < a; // lower rank = worse (down=0 … ok=3)
}

module.exports = { diffInterfaceStates, severityFor, summaryFor, isReversal, isWorsening };
