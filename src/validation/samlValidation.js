'use strict';

const { isValidRole, ALL_ROLES } = require('../auth/roles');

const VALUE_MAX = 512;

// POST/PUT /api/saml/role-map. claimValue + role are required. claimValue is the
// value of the configured SAML role attribute the IdP asserts (e.g. "blueeye-admins").
function validateRoleMap(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  if (typeof input.claimValue !== 'string' || input.claimValue.trim() === '') {
    errors.claimValue = 'claimValue is required';
  } else if (input.claimValue.length > VALUE_MAX) {
    errors.claimValue = `claimValue must be at most ${VALUE_MAX} characters`;
  } else {
    value.claimValue = input.claimValue.trim();
  }

  if (!isValidRole(input.role)) {
    errors.role = `role must be one of: ${ALL_ROLES.join(', ')}`;
  } else {
    value.role = input.role;
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

module.exports = { validateRoleMap };
