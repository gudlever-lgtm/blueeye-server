'use strict';

const { isValidRole, ALL_ROLES } = require('../auth/roles');

const HOST_MAX = 255;
const DN_MAX = 512;
const FILTER_MAX = 512;
const PW_MAX = 2000;

function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// PUT /api/ldap/config. host, baseDn are required; the bind password is
// write-only (omit to keep the stored one, clearBindPassword:true to wipe it).
// TLS is enforced here too as a defensive check: a non-local host with use_tls
// off is rejected at save time, so an insecure config can't be stored.
function validateLdapConfig(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  if (typeof input.host !== 'string' || input.host.trim() === '') {
    errors.host = 'host is required';
  } else if (input.host.trim().length > HOST_MAX) {
    errors.host = `host must be at most ${HOST_MAX} characters`;
  } else {
    value.host = input.host.trim();
  }

  if (input.port === undefined) {
    value.port = 389;
  } else {
    const p = Number(input.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.port = 'port must be an integer between 1 and 65535';
    else value.port = p;
  }

  value.useTls = input.useTls === undefined ? true : (input.useTls === true || input.useTls === 'true');

  if (input.bindDn === undefined || input.bindDn === null || input.bindDn === '') {
    value.bindDn = null;
  } else if (typeof input.bindDn !== 'string' || input.bindDn.length > DN_MAX) {
    errors.bindDn = `bindDn must be a string up to ${DN_MAX} characters`;
  } else {
    value.bindDn = input.bindDn.trim();
  }

  if (typeof input.baseDn !== 'string' || input.baseDn.trim() === '') {
    errors.baseDn = 'baseDn is required';
  } else if (input.baseDn.length > DN_MAX) {
    errors.baseDn = `baseDn must be at most ${DN_MAX} characters`;
  } else {
    value.baseDn = input.baseDn.trim();
  }

  if (input.userFilter === undefined || input.userFilter === null || input.userFilter === '') {
    value.userFilter = '(sAMAccountName={{username}})';
  } else if (typeof input.userFilter !== 'string' || input.userFilter.length > FILTER_MAX) {
    errors.userFilter = `userFilter must be a string up to ${FILTER_MAX} characters`;
  } else if (!input.userFilter.includes('{{username}}')) {
    errors.userFilter = 'userFilter must contain the {{username}} placeholder';
  } else {
    value.userFilter = input.userFilter.trim();
  }

  if (input.groupFilter === undefined || input.groupFilter === null || input.groupFilter === '') {
    value.groupFilter = null;
  } else if (typeof input.groupFilter !== 'string' || input.groupFilter.length > FILTER_MAX) {
    errors.groupFilter = `groupFilter must be a string up to ${FILTER_MAX} characters`;
  } else {
    value.groupFilter = input.groupFilter.trim();
  }

  value.enabled = input.enabled === true || input.enabled === 'true';

  // Bind password is write-only.
  if (input.clearBindPassword === true || input.clearBindPassword === 'true') {
    value.clearBindPassword = true;
  } else if (input.bindPassword !== undefined) {
    if (typeof input.bindPassword !== 'string') errors.bindPassword = 'bindPassword must be a string';
    else if (input.bindPassword.length > PW_MAX) errors.bindPassword = `bindPassword must be at most ${PW_MAX} characters`;
    else if (input.bindPassword !== '') value.bindPassword = input.bindPassword; // empty -> keep stored
  }

  // Defensive TLS check: never store a non-local plaintext config.
  if (!errors.host && !errors.useTls && value.useTls === false && !isLocalHost(value.host)) {
    errors.useTls = 'TLS (LDAPS) is required for a non-local host — refusing a plaintext bind';
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

// POST/PUT /api/ldap/role-map. groupDn + role are required.
function validateRoleMap(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  if (typeof input.groupDn !== 'string' || input.groupDn.trim() === '') {
    errors.groupDn = 'groupDn is required';
  } else if (input.groupDn.length > DN_MAX) {
    errors.groupDn = `groupDn must be at most ${DN_MAX} characters`;
  } else {
    value.groupDn = input.groupDn.trim();
  }

  if (!isValidRole(input.role)) {
    errors.role = `role must be one of: ${ALL_ROLES.join(', ')}`;
  } else {
    value.role = input.role;
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

module.exports = { validateLdapConfig, validateRoleMap };
