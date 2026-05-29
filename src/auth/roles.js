'use strict';

// The three roles supported by the system, in ascending order of privilege.
const ROLES = Object.freeze({
  ADMIN: 'admin',
  OPERATOR: 'operator',
  VIEWER: 'viewer',
});

const ALL_ROLES = Object.freeze(Object.values(ROLES));

function isValidRole(role) {
  return ALL_ROLES.includes(role);
}

module.exports = { ROLES, ALL_ROLES, isValidRole };
