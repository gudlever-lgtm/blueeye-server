'use strict';

const MAX_RESULTS = 1000;
const MAX_PAYLOAD_BYTES = 65535;

// Validates POST /agents/results: { results: [ {...}, ... ] }. Each element is
// a JSON object (a single test result payload).
function validateResults(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  if (!Array.isArray(input.results)) {
    return { errors: { results: 'results must be an array' } };
  }
  if (input.results.length === 0) {
    return { errors: { results: 'results must not be empty' } };
  }
  if (input.results.length > MAX_RESULTS) {
    return { errors: { results: `results must contain at most ${MAX_RESULTS} items` } };
  }

  for (let i = 0; i < input.results.length; i += 1) {
    const item = input.results[i];
    if (item === null || typeof item !== 'object') {
      return { errors: { results: `results[${i}] must be a JSON object` } };
    }
    let serialized;
    try {
      serialized = JSON.stringify(item);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
      return { errors: { results: `results[${i}] is not serialisable or is too large` } };
    }
  }

  return { value: { results: input.results } };
}

const MAX_RANGE_LIMIT = 5000;

// Validates the time-range query for history lookups: ?from=&to=&limit=.
// from/to are ISO date strings (optional); limit is a positive integer capped
// at MAX_RANGE_LIMIT. Returns { value: { from, to, limit } } or { errors }.
function validateTimeRange(query) {
  const q = query && typeof query === 'object' ? query : {};
  const errors = {};
  const value = { from: null, to: null, limit: 1000 };

  for (const key of ['from', 'to']) {
    if (q[key] === undefined || q[key] === null || q[key] === '') continue;
    const d = new Date(q[key]);
    if (Number.isNaN(d.getTime())) {
      errors[key] = `${key} must be a valid date`;
    } else {
      value[key] = d;
    }
  }

  if (value.from && value.to && value.from.getTime() > value.to.getTime()) {
    errors.range = 'from must be before to';
  }

  if (q.limit !== undefined && q.limit !== null && q.limit !== '') {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_RANGE_LIMIT) {
      errors.limit = `limit must be an integer between 1 and ${MAX_RANGE_LIMIT}`;
    } else {
      value.limit = n;
    }
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

module.exports = { validateResults, validateTimeRange };
