'use strict';

const fs = require('fs');
const path = require('path');

// On-disk cache of the last VALID, signature-verified license validation. Stores
// { payload, signature, verifiedAt }. Written with owner-only permissions.
function createFileCache(filePath) {
  return {
    read() {
      try {
        if (!fs.existsSync(filePath)) return null;
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data && data.payload && typeof data.verifiedAt === 'number') return data;
        return null;
      } catch {
        return null;
      }
    },
    write(data) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        /* best effort */
      }
    },
  };
}

// An in-memory cache (used by tests).
function createMemoryCache(initial = null) {
  let store = initial;
  return {
    read() {
      return store;
    },
    write(data) {
      store = data;
    },
  };
}

module.exports = { createFileCache, createMemoryCache };
