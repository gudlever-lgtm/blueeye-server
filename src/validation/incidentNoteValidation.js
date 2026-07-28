'use strict';

const { KINDS } = require('../repositories/incidentNotesRepository');

// Longest note we store. Matches the VARCHAR(4000) column: reject at the edge
// with a clear message rather than letting MySQL truncate silently, which on a
// work log would mean quietly losing the end of someone's handover.
const TEXT_MAX = 4000;

// Validates the POST /api/incidents/:id/notes body: { text, kind }.
//
// Both are required. `kind` is NOT defaulted — an operator writing "ruled out
// the switch" that silently lands as an observation would defeat the whole
// point of the pinned exclusion list, so an omitted kind is a 400, not a guess.
//
// `text` is trimmed and must be non-empty after trimming: a note of pure
// whitespace is an accident, and an append-only log cannot take it back.
function validateIncidentNote(body) {
  const errors = [];
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  let text = null;
  if (typeof b.text !== 'string') {
    errors.push('text is required and must be a string');
  } else {
    text = b.text.trim();
    if (text === '') errors.push('text must not be empty');
    else if (text.length > TEXT_MAX) errors.push(`text must be at most ${TEXT_MAX} characters`);
  }

  const kind = b.kind;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    errors.push(`kind must be one of: ${KINDS.join(', ')}`);
  }

  if (errors.length) return { errors };
  return { value: { text, kind } };
}

module.exports = { validateIncidentNote, TEXT_MAX };
