'use strict';

// Deterministic JSON serialisation used to verify signed license proofs.
//
// Rules: object keys sorted alphabetically (recursively), no whitespace, UTF-8.
// This is a BYTE-FOR-BYTE copy of blueeye-licens' src/lib/canonicalize.js. It
// MUST stay identical: the license server signs the bytes produced here, and
// this server reproduces the same bytes to verify the signature offline. Do not
// "improve" or reformat this independently of the license server.
function canonicalize(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}

module.exports = { canonicalize };
