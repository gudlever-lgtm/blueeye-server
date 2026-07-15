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

const NAME_MAX = 120;

// Optional display name — used only in the one-time-password email greeting
// (BlueEye keys users by email; there is no name column). Trimmed; length-capped.
function validateName(raw, errors) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    errors.name = 'name must be a string';
    return undefined;
  }
  const name = raw.trim();
  if (name.length > NAME_MAX) {
    errors.name = `name must be at most ${NAME_MAX} characters`;
    return undefined;
  }
  return name || undefined;
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

// POST /users/local — admin creates a local user who receives a one-time
// password by email. email + role are required; name is optional (email only).
// No password field: the server generates the one-time password itself.
function validateLocalUserCreate(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  value.email = validateEmail(input.email, errors);
  value.role = validateRole(input.role, errors);
  const name = validateName(input.name, errors);
  if (name !== undefined) value.name = name;

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

// POST /auth/change-password — the current (one-time or normal) password plus a
// new one. Both must be present non-empty strings; the new password's strength is
// enforced separately by the route (checkPasswordPolicy → 422).
function validatePasswordChange(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  if (typeof input.currentPassword !== 'string' || input.currentPassword.length === 0) {
    errors.currentPassword = 'currentPassword must be a non-empty string';
  } else {
    value.currentPassword = input.currentPassword;
  }
  if (typeof input.newPassword !== 'string' || input.newPassword.length === 0) {
    errors.newPassword = 'newPassword must be a non-empty string';
  } else {
    value.newPassword = input.newPassword;
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

module.exports = {
  validateUserCreate,
  validateUserUpdate,
  validateLocalUserCreate,
  validatePasswordChange,
};
