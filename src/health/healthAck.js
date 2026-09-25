'use strict';

// Acknowledging a Fleet verdict (migration 138).
//
// The verdict is computed on every request and stored nowhere, so an
// acknowledgement is held against a SIGNATURE of the verdict it covers rather
// than against a row id. While the agent's verdict still hashes to the same
// signature, the acknowledgement applies; the moment the verdict moves — a
// different status, or the same status for a different reason — it no longer
// matches and the agent reads unacknowledged again. That is the whole
// mechanism: nothing expires, nothing has to be swept, and a problem that
// changes shape is never hidden by an acknowledgement made for the old one.

const crypto = require('crypto');

// Only a verdict worth clearing can be acknowledged. `ok` needs no
// acknowledgement, and `unknown` (no probe data yet) is not a fault to clear —
// acknowledging it would hide an agent that has never reported.
const ACKABLE = new Set(['warn', 'bad', 'down', 'stale']);

function isAckable(status) { return ACKABLE.has(String(status || '')); }

// The status and the reason, because those two are what the reader saw when
// they cleared it. Evidence rows carry live numbers (a loss percentage moves on
// every probe), so including them would expire an acknowledgement seconds after
// it was made.
function healthSignature(health) {
  const status = String((health && health.status) || '');
  const reason = String((health && health.reason) || '');
  return crypto.createHash('sha256').update(`${status}\n${reason}`).digest('hex');
}

// Folds a stored acknowledgement into a verdict. Returns the health object
// unchanged when there is none, or when it was made for a different verdict.
function applyAck(health, ack) {
  if (!health || !ack || !isAckable(health.status)) return health;
  if (ack.signature !== healthSignature(health)) return health;
  return {
    ...health,
    ack: {
      at: ack.ackedAt,
      by: ack.ackedEmail || (ack.ackedBy ? `user #${ack.ackedBy}` : null),
      note: ack.note || null,
      status: ack.status,
    },
  };
}

module.exports = { healthSignature, applyAck, isAckable, ACKABLE };
