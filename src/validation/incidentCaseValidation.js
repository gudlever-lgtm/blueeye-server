'use strict';

const { STATUSES } = require('../incidentCases/stateMachine');

// Validates the PATCH /api/incidents/:id body. Only a target `status` (required,
// one of the four) and an optional free-text `comment` are accepted. Whether the
// transition itself is legal — and whether a comment is mandatory (reopen) — is
// decided by the state machine in the route, not here.
function validateStatusPatch(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};

  const status = b.status;
  if (typeof status !== 'string' || !STATUSES.includes(status)) {
    errors.push(`status must be one of: ${STATUSES.join(', ')}`);
  }

  let comment = null;
  if (b.comment !== undefined && b.comment !== null) {
    if (typeof b.comment !== 'string') errors.push('comment must be a string');
    else comment = b.comment.trim().slice(0, 512);
  }

  if (errors.length) return { errors };
  return { value: { status, comment: comment || null } };
}

module.exports = { validateStatusPatch };
