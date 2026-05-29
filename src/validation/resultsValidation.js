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

module.exports = { validateResults };
