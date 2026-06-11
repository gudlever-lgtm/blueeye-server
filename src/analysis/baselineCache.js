'use strict';

const fs = require('fs');
const path = require('path');

// On-disk cache of warmed-up analysis baselines (the rolling windows keyed by
// `${hostId}|${metric}|${bucket}`). Unlike the license cache, this stores a
// plain key→values object, so read() must NOT require the license envelope.
//
// Writes are asynchronous and coalesced: the baseline store calls write() on a
// timer (not per sample), and a write already in flight just records the latest
// snapshot to flush next — so persistence never blocks the ingest event loop.
// flushSync() exists for graceful shutdown, where we must land the file before
// the process exits.
function createBaselineFileCache(filePath) {
  let writing = false;
  let queued = null;

  function serialize(data) {
    return `${JSON.stringify(data)}\n`;
  }

  async function flushToDisk(data) {
    writing = true;
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, serialize(data), { mode: 0o600 });
    } catch {
      /* best effort — a missed baseline write only costs warm-up time */
    } finally {
      writing = false;
      if (queued !== null) {
        const next = queued;
        queued = null;
        flushToDisk(next);
      }
    }
  }

  return {
    read() {
      try {
        if (!fs.existsSync(filePath)) return null;
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return data && typeof data === 'object' ? data : null;
      } catch {
        return null;
      }
    },
    write(data) {
      if (writing) {
        queued = data;
        return;
      }
      flushToDisk(data);
    },
    // Synchronous write for shutdown — guarantees the snapshot is on disk.
    flushSync(data) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, serialize(data), { mode: 0o600 });
      } catch {
        /* best effort */
      }
    },
  };
}

module.exports = { createBaselineFileCache };
