'use strict';

const { isValidRole, ALL_ROLES } = require('../auth/roles');

const EMAIL_MAX = 255;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(raw, errors) {
  if (raw === undefined || raw === null) {
    errors.email = 'email is required';
    return undefined;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.email = 'email must be a non-empty string';
    return undefined;
  }
  const email = raw.trim().toLowerCase();
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    errors.email = 'email must be a valid email address';
    return undefined;
  }
  return email;
}

// Structural check only: the password must be present and a string (→ 400).
// Strength rules (minimum length + character-class complexity) live in the
// always-on password policy (src/auth/password.js → checkPasswordPolicy) and
// are enforced by the route with a distinct 422, so the two concerns don't
// report under the same status code.
function validatePassword(raw, errors) {
  if (typeof raw !== 'string' || raw.length === 0) {
    errors.password = 'password must be a non-empty string';
    return undefined;
  }
  return raw;
}

function validateRole(raw, errors) {
  if (!isValidRole(raw)) {
    errors.role = `role must be one of: ${ALL_ROLES.join(', ')}`;
    return undefined;
  }
  return raw;
}

// POST /users — email, password and role are all required.
function validateUserCreate(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  value.email = validateEmail(input.email, errors);
  value.password = validatePassword(input.password, errors);
  value.role = validateRole(input.role, errors);

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

// PUT /users/:id — role is required; email and password are optional updates.
function validateUserUpdate(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  value.role = validateRole(input.role, errors);
  if (input.email !== undefined) {
    value.email = validateEmail(input.email, errors);
  }
  if (input.password !== undefined) {
    value.password = validatePassword(input.password, errors);
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

module.exports = { validateUserCreate, validateUserUpdate };
