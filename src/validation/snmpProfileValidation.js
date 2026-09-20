'use strict';

const { VERSIONS } = require('./snmpDeviceValidation');

// Validation for an SNMP credential profile (migration 112).
//
// Written by an ADMIN, so the risk is not a hostile value — it is a
// configuration that looks right and cannot work. The two that matter:
//
//   * a v3 profile with no user, which cannot authenticate at all;
//   * a priv key with no auth key. SNMPv3 cannot encrypt without
//     authenticating, so that combination is not a weaker security level, it
//     is an impossible one, and a device will refuse it.
//
// Both are refused here rather than discovered when a switch stops answering.

const NAME_MAX = 190;
const SECRET_MAX = 255;
const AUTH_PROTOS = ['md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512'];
const PRIV_PROTOS = ['des', 'aes', 'aes256b', 'aes256r'];
// Every version a profile may carry. `VERSIONS` from the device validator is
// v1/v2c; a profile may also be v3.
const PROFILE_VERSIONS = [...VERSIONS, '3'];

// SNMPv3 keys have a protocol minimum of eight characters (RFC 3414). A device
// will refuse a shorter one, so accepting it here only moves the failure.
const V3_KEY_MIN = 8;

function str(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

// `create` requires a name and a version; `update` is a patch and validates
// only the keys present. The cross-field rules run on the MERGED shape, so a
// patch that removes an auth key from an authPriv profile is caught.
function validateSnmpProfile(raw, { partial = false, existing = null } = {}) {
  const errors = {};
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const value = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has('name') || !partial) {
    const name = str(body.name, NAME_MAX);
    if (!name) errors.name = 'name is required';
    else value.name = name;
  }

  if (has('version') || !partial) {
    const version = body.version === undefined ? '2c' : String(body.version);
    if (!PROFILE_VERSIONS.includes(version)) {
      errors.version = `version must be one of: ${PROFILE_VERSIONS.join(', ')}`;
    } else {
      value.version = version;
    }
  }

  if (has('locationId')) {
    if (body.locationId === null) {
      // Explicitly the GLOBAL default — the profile a device falls back to when
      // its site has none of its own.
      value.locationId = null;
    } else {
      const n = Number(body.locationId);
      if (!Number.isInteger(n) || n < 1) errors.locationId = 'locationId must be a positive integer';
      else value.locationId = n;
    }
  }

  // A secret is OMITTED to leave it alone and explicitly null to clear it —
  // the same rule the device row follows, so that renaming a profile cannot
  // silently wipe its credentials.
  for (const key of ['community', 'v3AuthKey', 'v3PrivKey']) {
    if (!has(key)) continue;
    if (body[key] === null || body[key] === '') { value[key] = null; continue; }
    const secret = str(body[key], SECRET_MAX);
    if (!secret) { errors[key] = `${key} must be a non-empty string or null`; continue; }
    if (key !== 'community' && secret.length < V3_KEY_MIN) {
      errors[key] = `${key} must be at least ${V3_KEY_MIN} characters (SNMPv3 requires it)`;
      continue;
    }
    value[key] = secret;
  }

  if (has('v3User')) {
    value.v3User = body.v3User === null ? null : str(body.v3User, NAME_MAX);
    if (body.v3User !== null && !value.v3User) errors.v3User = 'v3User must be a non-empty string or null';
  }
  if (has('v3Context')) value.v3Context = body.v3Context === null ? null : str(body.v3Context, NAME_MAX);

  for (const [key, allowed] of [['v3AuthProto', AUTH_PROTOS], ['v3PrivProto', PRIV_PROTOS]]) {
    if (!has(key)) continue;
    if (body[key] === null) { value[key] = null; continue; }
    if (!allowed.includes(body[key])) errors[key] = `${key} must be one of: ${allowed.join(', ')}`;
    else value[key] = body[key];
  }

  // The cross-field rules, on the MERGED shape.
  const merged = { ...(existing || {}), ...value };
  const version = merged.version || (existing && existing.version) || '2c';

  if (version === '3') {
    // `hasV3User` is how an existing profile reports its user without returning
    // it; a create has the value itself.
    const user = merged.v3User !== undefined ? merged.v3User : (existing && existing.v3User);
    if (!user) errors.v3User = 'a v3 profile needs a user';
  } else if (!partial && !value.community) {
    errors.community = 'a v1/v2c profile needs a community string';
  }

  // An explicit null in the patch CLEARS the key, so it must not fall back to
  // what the profile had. Only an OMITTED key keeps the existing state — which
  // is the same omitted-leaves-alone rule the secrets themselves follow.
  const keyState = (key, existingFlag) => {
    if (Object.prototype.hasOwnProperty.call(value, key)) return value[key] !== null;
    return !!(existing && existing[existingFlag]);
  };
  const authSet = keyState('v3AuthKey', 'hasV3AuthKey');
  const privSet = keyState('v3PrivKey', 'hasV3PrivKey');
  const authProto = merged.v3AuthProto !== undefined ? merged.v3AuthProto : (existing && existing.v3AuthProto);
  const privProto = merged.v3PrivProto !== undefined ? merged.v3PrivProto : (existing && existing.v3PrivProto);

  // SNMPv3 CANNOT encrypt without authenticating. This is not a weaker
  // security level; it is one that does not exist, and a device refuses it.
  if (privSet && !authSet) {
    errors.v3PrivKey = 'SNMPv3 cannot encrypt without authenticating — set an auth key too, or clear the priv key';
  }
  if (authSet && !authProto) errors.v3AuthProto = 'an auth key needs an auth protocol';
  if (privSet && !privProto) errors.v3PrivProto = 'a priv key needs a priv protocol';

  if (Object.keys(errors).length) return { errors };
  return { value };
}

module.exports = {
  validateSnmpProfile,
  AUTH_PROTOS,
  PRIV_PROTOS,
  PROFILE_VERSIONS,
  V3_KEY_MIN,
};
