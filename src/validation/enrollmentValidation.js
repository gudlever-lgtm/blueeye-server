'use strict';

const HOSTNAME_MAX = 255;
const PLATFORM_MAX = 64;
const ARCH_MAX = 32;
// Upper bound on a code's lifetime: 30 days.
const MAX_TTL_MINUTES = 30 * 24 * 60;

// Validates the body of POST /enrollment-codes. location_id and
// expiresInMinutes are optional; expiresInMinutes is left undefined when
// omitted so the caller can apply its configured default.
function validateCreateCode(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  if (input.location_id === undefined || input.location_id === null) {
    value.location_id = null;
  } else if (!Number.isInteger(input.location_id) || input.location_id <= 0) {
    errors.location_id = 'location_id must be a positive integer or null';
  } else {
    value.location_id = input.location_id;
  }

  if (input.expiresInMinutes === undefined || input.expiresInMinutes === null) {
    value.expiresInMinutes = undefined;
  } else if (
    !Number.isInteger(input.expiresInMinutes) ||
    input.expiresInMinutes <= 0 ||
    input.expiresInMinutes > MAX_TTL_MINUTES
  ) {
    errors.expiresInMinutes = `expiresInMinutes must be an integer between 1 and ${MAX_TTL_MINUTES}`;
  } else {
    value.expiresInMinutes = input.expiresInMinutes;
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

function requireString(input, field, max, errors) {
  if (typeof input[field] !== 'string' || input[field].trim() === '') {
    errors[field] = `${field} is required`;
    return undefined;
  }
  const trimmed = input[field].trim();
  if (trimmed.length > max) {
    errors[field] = `${field} must be at most ${max} characters`;
    return undefined;
  }
  return trimmed;
}

// Validates the body of POST /agents/enroll. This comes from an unauthenticated
// agent, so every field is validated strictly.
function validateEnroll(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  value.code = requireString(input, 'code', 64, errors);
  value.hostname = requireString(input, 'hostname', HOSTNAME_MAX, errors);
  value.platform = requireString(input, 'platform', PLATFORM_MAX, errors);
  value.arch = requireString(input, 'arch', ARCH_MAX, errors);

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

module.exports = { validateCreateCode, validateEnroll };
