'use strict';

// Pure state machine for event_cases (point 4). Keeping the allowed
// transitions in one explainable table means the router, the repo guard and the
// auto-resolve job all agree on what is legal.
//
//   open          → investigating   (manually by operator/admin)
//   open          → resolved        (manually — see below)
//   investigating → resolved        (manually, or automatically after no new
//                                     anomalies link within the inactivity window)
//   resolved      → closed          (manually only)
//   closed        → open            (reopen — manual only, requires a free-text
//                                     comment which is stored in the audit trail)
//
// WHY open → resolved EXISTS. The chain used to be strictly
// open → investigating → resolved, on the reasoning that something has to be
// looked at before it can be called fixed. In practice most events are read and
// dismissed in one go — a link that flapped once, a probe that recovered on its
// own — and forcing them through `investigating` recorded a step nobody
// performed. That is worse than not recording it: an audit trail where every
// event was "investigated" says nothing about the ones that actually were.
//
// It matters most in bulk. An operator clearing a screen of open events had to
// run two passes, and the intermediate state was pure ceremony.
//
// Any transition not listed here is rejected (409 at the API). Playbook-driven
// auto-transitions are intentionally absent — there is no playbook subsystem.

const STATUSES = ['open', 'investigating', 'resolved', 'closed'];

const TRANSITIONS = {
  open: ['investigating', 'resolved'],
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
