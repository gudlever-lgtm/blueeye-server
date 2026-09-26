'use strict';

const crypto = require('crypto');

// The two keys that decide whether the fleet will ever accept anything from this
// server again — and the guard that notices when one of them moves.
//
//   'license'       the vendor root from blueeye-licens (src/license/publicKey.js).
//                   Licence proofs are verified against it, and a proof is what
//                   tells an agent which key this server may sign with.
//   'agent_release' the agent-release signing key (src/enroll/releaseKeyService.js).
//                   Every installed agent PINS its fingerprint and refuses an
//                   update or a privileged command signed by anything else.
//
// WHY THIS IS A SEPARATE THING FROM "is a key configured". Both keys are already
// reported by the API, and both are already used correctly. What nothing watched
// was whether they are the SAME ones as yesterday. A key change breaks nothing on
// the server: it boots, the dashboard loads, enrollment codes still generate. The
// damage lands on the agents, one at a time, the next time each is asked to take
// an update — as "signature did not verify" on a host nobody is looking at. By
// the time that is noticed the change is weeks old and nobody remembers making
// it. So the fingerprints are recorded, compared on every boot, and a difference
// is stated in the loudest terms the product has.
//
// It WARNS, it never blocks. An admin recovering a server from backup, or
// deliberately rotating after a compromise, is doing the right thing and must not
// be locked out by the alarm about it — the same reasoning that keeps a 401 from
// being terminal on the agent side. What the guard owes that admin is the number
// of agents about to go deaf, not a closed door.

const KIND_LICENSE = 'license';
const KIND_AGENT_RELEASE = 'agent_release';
const KINDS = [KIND_LICENSE, KIND_AGENT_RELEASE];

// The fingerprint form used everywhere in this stack for a public key: SHA-256
// over the PEM text, lowercase hex. It must agree with releaseKeyService (which
// hashes the PEM it stores) and with the agent's release/fingerprint.js, because
// the numbers are compared across the wire.
function fingerprintOfPem(pem) {
  if (typeof pem !== 'string' || !pem.trim()) return null;
  return crypto.createHash('sha256').update(pem).digest('hex');
}

function isFingerprint(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function shortFp(fp) {
  return isFingerprint(fp) ? `${fp.slice(0, 12)}…` : String(fp ?? '');
}

// --- The decision, as a pure function ---------------------------------------
// Given what was recorded for a kind and what the server is holding now, what is
// the state? Separated from storage so it can be reasoned about (and tested)
// without a database.
//
//   'absent'    nothing configured now and nothing recorded — not an error; a
//               fresh server before its key is generated looks exactly like this.
//   'cleared'   something was recorded and there is nothing now. The key was
//               deleted. Every pinned agent is now un-updatable, and no new one
//               can be onboarded.
//   'first'     first time this server has seen a key for this kind. Recorded,
//               no warning: there is nothing to have changed from.
//   'unchanged' the normal answer, on every boot, forever.
//   'restored'  the key is back to the last real one this server held, after a
//               spell with none. Not an alarm — the fleet's pins are valid again.
//   'changed'   the fingerprint differs from the recorded one. This is the alarm.
//
// `persist` says whether this verdict is news that has to be written down. A
// deleted key stays 'cleared' on every boot after the one that deleted it, and
// re-recording it each time would inflate change_count and re-arm a warning an
// admin has already acknowledged.
//
// A row whose fingerprint is CLEARED_FINGERPRINT is a key that WAS deleted; the
// last real value it held is in previous_fingerprint, and that is what a new key
// is judged against — so delete-then-generate is a change, which is exactly what
// the fleet experiences.
function assessKeyIdentity({ recorded = null, current = null } = {}) {
  const now = isFingerprint(current) && current !== CLEARED_FINGERPRINT ? current : null;
  const stored = recorded && isFingerprint(recorded.fingerprint) ? recorded.fingerprint : null;
  const storedIsCleared = stored === CLEARED_FINGERPRINT;
  const was = storedIsCleared
    ? (isFingerprint(recorded.previous_fingerprint) ? recorded.previous_fingerprint : null)
    : stored;

  if (!now && !was) return { state: 'absent', fingerprint: null, previous: null, persist: false };
  if (!now) return { state: 'cleared', fingerprint: null, previous: was, persist: !storedIsCleared };
  if (!was) return { state: 'first', fingerprint: now, previous: null, persist: true };
  if (now === was) {
    return storedIsCleared
      ? { state: 'restored', fingerprint: now, previous: null, persist: true }
      : { state: 'unchanged', fingerprint: now, previous: null, persist: false };
  }
  return { state: 'changed', fingerprint: now, previous: was, persist: true };
}

// Does this state warrant the warning? 'cleared' does, for the same reason
// 'changed' does — from an agent's point of view the two are the same event.
function isDrift(state) {
  return state === 'changed' || state === 'cleared';
}

// A key that was deleted has no fingerprint of its own, so the row stores 64
// zeroes: a value no SHA-256 of a real PEM produces. It is also what an
// acknowledgement of a deletion is recorded against.
const CLEARED_FINGERPRINT = '0'.repeat(64);

// Has an admin already signed off on THIS value? Acknowledgement is per
// fingerprint, so dismissing today's change cannot silence tomorrow's.
function isAcknowledged(row, state, fingerprint) {
  if (!row || !row.acknowledged_fingerprint) return false;
  if (state === 'cleared') return row.acknowledged_fingerprint === CLEARED_FINGERPRINT;
  return row.acknowledged_fingerprint === fingerprint;
}

// --- The guard ---------------------------------------------------------------
//
// `check()` is called once at startup and again after any operation that can move
// a key (generate, delete, a licence validation that swapped the anchor). It is
// the only writer: the recorded fingerprint is updated to what is true NOW, and
// the previous value is kept alongside it so the warning can name both.
//
// The verdict is also held in memory, because that is what the API reads on every
// request and what the dashboard banner is drawn from — a warning that costs a
// query per page view is a warning someone eventually removes for being slow.
function createKeyIdentityGuard({ repo, logger = console, now = () => new Date() } = {}) {
  // kind -> verdict
  let state = new Map();

  function log(level, msg) {
    if (logger && typeof logger[level] === 'function') logger[level](msg);
  }

  // The sentence an operator reads in the server log, in the dashboard banner and
  // in the audit trail. Deliberately the same text in all three: an operator who
  // finds one of them and searches for the wording must land on the others.
  function explain(kind, verdict, impact) {
    const which = kind === KIND_LICENSE ? 'licence trust anchor' : 'agent signing key';
    if (verdict.state === 'cleared') {
      return kind === KIND_LICENSE
        ? 'The licence trust anchor this server was running with is GONE. No licence proof can be verified, '
          + 'so this server can no longer prove to any agent which key it may sign with.'
        : 'The agent signing key this server was running with has been DELETED. '
          + `${impactPhrase(impact)} No agent can be onboarded or updated until a key exists again, and every agent `
          + 'that pinned the old one must be re-pinned even then.';
    }
    return `The ${which} has CHANGED (was ${shortFp(verdict.previous)}, now ${shortFp(verdict.fingerprint)}). `
      + (kind === KIND_LICENSE
        ? 'Licence proofs signed against the old anchor no longer verify, and agents embed the old one — '
          + 'they will refuse the authorisation this server relays.'
        : `${impactPhrase(impact)} Each of them refuses any update or privileged command signed with the new key `
          + 'until it is re-pinned (Fleet → the agent → Re-pin, or the one-liner under Settings → Updates).');
  }

  function impactPhrase(impact) {
    if (!impact || typeof impact.pinnedToPrevious !== 'number') return 'Agents pinned to the old key are affected.';
    const n = impact.pinnedToPrevious;
    if (n === 0) return 'No connected agent reports having pinned the old key.';
    return `${n} agent${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} the old key pinned.`;
  }

  // Compare one kind against what is recorded, persist the new truth, and return
  // the verdict. Never throws: a guard that takes the server down when its own
  // bookkeeping fails is worse than the drift it watches for.
  async function check({ kind, fingerprint = null, impact = null } = {}) {
    if (!KINDS.includes(kind)) throw new Error(`unknown trust key kind: ${kind}`);
    const current = isFingerprint(fingerprint) ? fingerprint : null;
    let recorded = null;
    try {
      recorded = repo ? await repo.get(kind) : null;
    } catch (err) {
      log('warn', `trust keys: could not read the recorded ${kind} fingerprint (${err.message}) — drift cannot be judged this boot.`);
      return null;
    }

    const verdict = assessKeyIdentity({ recorded, current });
    const drift = isDrift(verdict.state);
    const at = now();

    try {
      if (verdict.persist && (verdict.state === 'first' || verdict.state === 'restored')) {
        await repo.record({ kind, fingerprint: verdict.fingerprint, firstSeenAt: at });
      } else if (verdict.persist) {
        await repo.recordChange({ kind, fingerprint: verdict.fingerprint, previous: verdict.previous, changedAt: at });
      }
    } catch (err) {
      log('warn', `trust keys: could not record the ${kind} fingerprint (${err.message}).`);
    }

    const entry = {
      kind,
      state: verdict.state,
      fingerprint: verdict.fingerprint,
      previous: verdict.previous,
      drift,
      // A change that is news arrives UNacknowledged: the value being
      // acknowledged is one nobody has seen yet. A drift already on record keeps
      // whatever an admin signed off on, so a deleted key does not re-alarm on
      // every restart.
      acknowledged: verdict.persist ? false : isAcknowledged(recorded, verdict.state, verdict.fingerprint),
      firstSeenAt: recorded && recorded.first_seen_at ? recorded.first_seen_at : (verdict.state === 'first' ? at : null),
      changedAt: (drift && verdict.persist) ? at : (recorded && recorded.changed_at) || null,
      changeCount: (Number(recorded && recorded.change_count) || 0) + ((drift && verdict.persist) ? 1 : 0),
      impact: impact || null,
      message: drift ? explain(kind, verdict, impact) : null,
    };
    state.set(kind, entry);

    if (drift) {
      // The loudest thing a background process can do. Banner text, log text and
      // audit text are the same sentence on purpose.
      log('error', `TRUST_KEY_CHANGED (${kind}): ${entry.message}`);
    }
    return entry;
  }

  // Record an admin's acknowledgement of the CURRENT value for a kind. Returns the
  // updated entry, or null when there is nothing in drift to acknowledge.
  async function acknowledge({ kind, userId = null } = {}) {
    const entry = state.get(kind);
    if (!entry || !entry.drift || entry.acknowledged) return null;
    const value = entry.state === 'cleared' ? CLEARED_FINGERPRINT : entry.fingerprint;
    await repo.acknowledge({ kind, fingerprint: value, at: now(), userId });
    const next = { ...entry, acknowledged: true };
    state.set(kind, next);
    return next;
  }

  // What the API and the dashboard read. Always answers for both kinds, so a
  // client never has to distinguish "no drift" from "not checked yet".
  function status() {
    const out = { drift: false, unacknowledgedDrift: false, keys: {} };
    for (const kind of KINDS) {
      const entry = state.get(kind) || { kind, state: 'unknown', fingerprint: null, previous: null, drift: false, acknowledged: false, impact: null, message: null };
      out.keys[kind] = entry;
      if (entry.drift) {
        out.drift = true;
        if (!entry.acknowledged) out.unacknowledgedDrift = true;
      }
    }
    return out;
  }

  // Test/reset seam. Not used in production; the guard is built once per process.
  function reset() { state = new Map(); }

  return { check, acknowledge, status, reset };
}

module.exports = {
  createKeyIdentityGuard,
  assessKeyIdentity,
  isDrift,
  isAcknowledged,
  fingerprintOfPem,
  isFingerprint,
  shortFp,
  KIND_LICENSE,
  KIND_AGENT_RELEASE,
  KINDS,
  CLEARED_FINGERPRINT,
};
