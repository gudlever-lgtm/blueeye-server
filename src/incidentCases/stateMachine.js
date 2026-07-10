'use strict';

// Pure state machine for incident_cases (point 4). Keeping the allowed
// transitions in one explainable table means the router, the repo guard and the
// auto-resolve job all agree on what is legal.
//
//   open          → investigating   (manually by operator/admin)
//   investigating → resolved        (manually, or automatically after no new
//                                     anomalies link within the inactivity window)
//   resolved      → closed          (manually only)
//   closed        → open            (reopen — manual only, requires a free-text
//                                     comment which is stored in the audit trail)
//
// Any transition not listed here is rejected (409 at the API). Playbook-driven
// auto-transitions are intentionally absent — there is no playbook subsystem.

const STATUSES = ['open', 'investigating', 'resolved', 'closed'];

const TRANSITIONS = {
  open: ['investigating'],
  investigating: ['resolved'],
  resolved: ['closed'],
  closed: ['open'],
};

function isStatus(s) {
  return STATUSES.includes(s);
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

// Reopen (closed → open) must carry a comment; it is the only transition that
// requires one. The comment is not a stored column — it lives in the audit log.
function requiresComment(from, to) {
  return from === 'closed' && to === 'open';
}

module.exports = { STATUSES, TRANSITIONS, isStatus, canTransition, requiresComment };
