'use strict';

const NAME_MAX = 255;
const DESCRIPTION_MAX = 2000;

// Validates and normalises the body of a create/update location request.
// Returns either `{ value }` (normalised, ready for the repository) or
// `{ errors }` (a field -> message map) — never both.
function validateLocationInput(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  // name — required, non-empty, trimmed.
  if (input.name === undefined || input.name === null) {
    errors.name = 'name is required';
  } else if (typeof input.name !== 'string' || input.name.trim() === '') {
    errors.name = 'name must be a non-empty string';
  } else if (input.name.trim().length > NAME_MAX) {
    errors.name = `name must be at most ${NAME_MAX} characters`;
  } else {
    value.name = input.name.trim();
  }

  // description — optional; null when omitted.
  if (input.description === undefined || input.description === null) {
    value.description = null;
  } else if (typeof input.description !== 'string') {
    errors.description = 'description must be a string or null';
  } else if (input.description.length > DESCRIPTION_MAX) {
    errors.description = `description must be at most ${DESCRIPTION_MAX} characters`;
  } else {
    value.description = input.description;
  }

  // address — optional string.
  if (input.address === undefined || input.address === null || input.address === '') {
    value.address = null;
  } else if (typeof input.address !== 'string' || input.address.length > 512) {
    errors.address = 'address must be a string up to 512 characters';
  } else {
    value.address = input.address.trim();
  }

  // latitude/longitude — optional, but if one is given both must be valid.
  value.latitude = parseCoord(input.latitude, -90, 90, 'latitude', errors);
  value.longitude = parseCoord(input.longitude, -180, 180, 'longitude', errors);
  if ((value.latitude === null) !== (value.longitude === null) && !errors.latitude && !errors.longitude) {
    errors.latitude = 'latitude and longitude must be provided together';
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

// Parses an optional coordinate within [min,max]; '' / null / undefined -> null.
function parseCoord(raw, min, max, field, errors) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors[field] = `${field} must be a number between ${min} and ${max}`;
    return null;
  }
  return n;
}

// Parses a route :id param into a positive integer, or null if invalid.
function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

module.exports = { validateLocationInput, parseId };
