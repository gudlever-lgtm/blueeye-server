'use strict';

const { ALL_ROLES } = require('../auth/roles');

// Validates the body for creating an API token: { name, role?, expiresAt? }.
// Returns { value } on success or { errors } (a field→message map). Pure.
function validateApiTokenCreate(body) {
  const errors = {};
  const input = body && typeof body === 'object' ? body : {};

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) errors.name = 'name is required';
  else if (name.length > 120) errors.name = 'name must be at most 120 characters';

  let role = 'viewer';
  if (input.role !== undefined && input.role !== null && input.role !== '') {
    if (!ALL_ROLES.includes(input.role)) errors.role = `role must be one of: ${ALL_ROLES.join(', ')}`;
    else role = input.role;
  }

  let expiresAt = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '') {
    const d = new Date(input.expiresAt);
    if (Number.isNaN(d.getTime())) errors.expiresAt = 'expiresAt must be a valid date';
    else if (d.getTime() <= Date.now()) errors.expiresAt = 'expiresAt must be in the future';
    else expiresAt = d;
  }

  if (Object.keys(errors).length) return { errors };
  return { value: { name, role, expiresAt } };
}

module.exports = { validateApiTokenCreate };
