'use strict';

// Pure state machine for event_cases (point 4). Keeping the allowed
// transitions in one explainable table means the router, the repo guard and the
// auto-resolve job all agree on what is legal.
//
//   open          → investigating   (manually by operator/admin)
//   open          → resolved        (manually — see below)
//   investigating → resolved        (manually, or automatically after no new
//                                     anomalies link within the inactivity window)
//   resolved      → closed          (manually only — the VERIFIED state)
//   resolved      → investigating   (verification failed — manual only, requires
//                                     a comment saying what was still wrong)
//   closed        → open            (reopen — manual only, requires a free-text
//                                     comment which is stored in the audit trail)
//
// WHY resolved → investigating EXISTS. `resolved` and `closed` are two states on
// purpose: resolved means the fix is in, closed means somebody checked that it
// worked. The check can fail — and until this transition existed, saying so
// meant closing the case (asserting it was verified) and reopening it, which
// wrote a verification into the audit trail that never happened. The trail is
// the product here: a case that reads "closed, then reopened" says the fix was
// confirmed and later regressed, which is a different fault from one that was
// never fixed. So a failed check goes back to `investigating`, where the work
// actually is, and carries a comment saying what was still wrong.
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
  resolved: ['closed', 'investigating'],
  closed: ['open'],
};

function isStatus(s) {
  return STATUSES.includes(s);
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

// The two transitions that must carry a comment, and the reason is the same for
// both: each one contradicts something the case already says, and a trail that
// records the contradiction without the why is no better than no trail.
//
//   closed → open                a case that was verified is wrong again
//   resolved → investigating     the fix did not hold when it was checked
//
// The comment is not a stored column — it lives in the audit log.
function requiresComment(from, to) {
  if (from === 'closed' && to === 'open') return true;
  return from === 'resolved' && to === 'investigating';
}

module.exports = { STATUSES, TRANSITIONS, isStatus, canTransition, requiresComment };
