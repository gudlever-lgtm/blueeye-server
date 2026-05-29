'use strict';

const DISPLAY_NAME_MAX = 255;
const NOTES_MAX = 2000;
const META_MAX_BYTES = 65535;

// Validates the server-managed fields of an agent. Only these four fields are
// accepted; any agent-reported fields in the body are ignored. Omitted fields
// default to null (PUT = replace the managed metadata).
function validateAgentManagedInput(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  // display_name — string or null.
  if (input.display_name === undefined || input.display_name === null) {
    value.display_name = null;
  } else if (typeof input.display_name !== 'string' || input.display_name.trim() === '') {
    errors.display_name = 'display_name must be a non-empty string or null';
  } else if (input.display_name.trim().length > DISPLAY_NAME_MAX) {
    errors.display_name = `display_name must be at most ${DISPLAY_NAME_MAX} characters`;
  } else {
    value.display_name = input.display_name.trim();
  }

  // location_id — positive integer or null (existence is checked in the route).
  if (input.location_id === undefined || input.location_id === null) {
    value.location_id = null;
  } else if (!Number.isInteger(input.location_id) || input.location_id <= 0) {
    errors.location_id = 'location_id must be a positive integer or null';
  } else {
    value.location_id = input.location_id;
  }

  // notes — string or null.
  if (input.notes === undefined || input.notes === null) {
    value.notes = null;
  } else if (typeof input.notes !== 'string') {
    errors.notes = 'notes must be a string or null';
  } else if (input.notes.length > NOTES_MAX) {
    errors.notes = `notes must be at most ${NOTES_MAX} characters`;
  } else {
    value.notes = input.notes;
  }

  // meta — JSON object/array or null.
  if (input.meta === undefined || input.meta === null) {
    value.meta = null;
  } else if (typeof input.meta !== 'object') {
    errors.meta = 'meta must be a JSON object or null';
  } else {
    let serialized;
    try {
      serialized = JSON.stringify(input.meta);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      errors.meta = 'meta must be JSON-serialisable';
    } else if (Buffer.byteLength(serialized, 'utf8') > META_MAX_BYTES) {
      errors.meta = 'meta is too large';
    } else {
      value.meta = input.meta;
    }
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

module.exports = { validateAgentManagedInput };
