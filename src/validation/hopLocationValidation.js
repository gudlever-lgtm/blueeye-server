'use strict';

const { isPrivate, isIpv4, ipv4ToInt } = require('../geo/privateIp');

// Input validation for the hop location corrections API (`hop_locations`,
// migration 144) — where an operator says a traceroute hop actually stands.
//
// Three rules carry the weight:
//   * the address must be PUBLIC. A private address is never geolocated
//     anywhere in this layer (docs/geo.md), so a correction for one would be a
//     row nothing ever reads — and a quiet contradiction of the privacy rule.
//   * the prefix must not be wider than /8. A correction is "this router" or
//     "this operator's block"; a /0 would move the entire internet to one city
//     with a single request, and no legitimate use needs it.
//   * the coordinates are a POINT, so both are required. A correction with half
//     a position is a worse answer than the GeoIP one it replaces.

const NOTE_MAX = 255;
const CITY_MAX = 100;
const MIN_PREFIX_LEN = 8;

function coord(raw, min, max, field, errors) {
  if (raw === undefined || raw === null || raw === '') {
    errors[field] = `${field} is required`;
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors[field] = `${field} must be a number between ${min} and ${max}`;
    return null;
  }
  return Math.round(n * 1e6) / 1e6;
}

// Accepts `ip` as a plain address or as CIDR ('193.162.153.0/24'); an explicit
// `prefixLen` field wins over the suffix when both are given.
function parseTarget(input, errors) {
  const raw = input.ip;
  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.ip = 'ip is required';
    return {};
  }
  const text = raw.trim();
  const slash = text.indexOf('/');
  const addr = slash === -1 ? text : text.slice(0, slash);
  let prefixLen = slash === -1 ? null : Number(text.slice(slash + 1));

  if (input.prefixLen !== undefined && input.prefixLen !== null && input.prefixLen !== '') {
    prefixLen = Number(input.prefixLen);
  }
  if (prefixLen === null) prefixLen = isIpv4(addr) ? 32 : 128;

  if (!isIpv4(addr) && !/^[0-9a-fA-F:]{2,45}$/.test(addr)) {
    errors.ip = 'ip must be an IPv4 or IPv6 address';
    return {};
  }
  if (isPrivate(addr)) {
    errors.ip = 'ip must be a public address — private addresses are never geolocated';
    return {};
  }
  const max = isIpv4(addr) ? 32 : 128;
  if (!Number.isInteger(prefixLen) || prefixLen < MIN_PREFIX_LEN || prefixLen > max) {
    errors.prefixLen = `prefixLen must be an integer between ${MIN_PREFIX_LEN} and ${max}`;
    return {};
  }
  // Stored at the network boundary, so 1.2.3.4/24 and 1.2.3.0/24 are one row
  // rather than two rows meaning the same thing.
  return { ip: isIpv4(addr) ? networkAddress(addr, prefixLen) : addr, prefixLen };
}

// Masks an IPv4 address down to its prefix: 1.2.3.4/24 -> 1.2.3.0.
function networkAddress(addr, prefixLen) {
  const n = ipv4ToInt(addr);
  if (n === null) return addr;
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  const lo = (n & mask) >>> 0;
  return [lo >>> 24, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255].join('.');
}

// Returns `{ value }` ready for the repository, or `{ errors }` — never both.
function validateHopLocationInput(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  const { ip, prefixLen } = parseTarget(input, errors);
  if (ip) { value.ip = ip; value.prefixLen = prefixLen; }

  value.lat = coord(input.lat !== undefined ? input.lat : input.latitude, -90, 90, 'lat', errors);
  value.lng = coord(input.lng !== undefined ? input.lng : input.longitude, -180, 180, 'lng', errors);

  if (input.city === undefined || input.city === null || input.city === '') {
    value.city = null;
  } else if (typeof input.city !== 'string' || input.city.trim().length > CITY_MAX) {
    errors.city = `city must be a string of at most ${CITY_MAX} characters`;
  } else {
    value.city = input.city.trim();
  }

  if (input.country === undefined || input.country === null || input.country === '') {
    value.country = null;
  } else if (typeof input.country !== 'string' || !/^[A-Za-z]{2}$/.test(input.country.trim())) {
    errors.country = 'country must be a two-letter ISO-3166 code';
  } else {
    value.country = input.country.trim().toUpperCase();
  }

  if (input.note === undefined || input.note === null || input.note === '') {
    value.note = null;
  } else if (typeof input.note !== 'string' || input.note.length > NOTE_MAX) {
    errors.note = `note must be a string of at most ${NOTE_MAX} characters`;
  } else {
    value.note = input.note.trim();
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

module.exports = { validateHopLocationInput, NOTE_MAX, CITY_MAX, MIN_PREFIX_LEN };
