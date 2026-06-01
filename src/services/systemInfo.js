'use strict';

const fs = require('fs');

// Server-side storage info: free/used space on the drive where the app/Docker
// volume lives, and the MySQL database size. No external dependencies — uses
// fs.statfs and information_schema.
//
// Note on Docker: the DB volume is mounted in the *db* container, so the server
// process can't statfs it directly. We therefore (a) read DB size over SQL, and
// (b) statfs a configurable path (default the server's own data dir) — in a
// typical single-host deploy the volumes share the same physical drive.
function createSystemInfo({ db, diskPath = '/data', statfs = fs.statfs } = {}) {
  // Disk usage for the configured path.
  function getDisk() {
    return new Promise((resolve) => {
      statfs(diskPath, (err, st) => {
        if (err || !st) {
          resolve({ path: diskPath, available: false, error: err ? err.message : 'unavailable' });
          return;
        }
        const blockSize = st.bsize;
        const total = st.blocks * blockSize;
        const free = st.bfree * blockSize; // free to root
        const avail = st.bavail * blockSize; // free to unprivileged users
        const used = total - free;
        resolve({
          path: diskPath,
          available: true,
          totalBytes: total,
          usedBytes: used,
          freeBytes: avail,
          usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
        });
      });
    });
  }

  // Database size from information_schema: total, and the largest tables.
  async function getDatabase() {
    const name = db && db.databaseName ? db.databaseName : undefined;
    const [totals] = await db.pool.query(
      `SELECT
         COALESCE(SUM(data_length + index_length), 0) AS bytes,
         COALESCE(SUM(data_length), 0) AS dataBytes,
         COALESCE(SUM(index_length), 0) AS indexBytes,
         COUNT(*) AS tables
       FROM information_schema.tables
       WHERE table_schema = DATABASE()`
    );
    const [tableRows] = await db.pool.query(
      `SELECT table_name AS name,
              (data_length + index_length) AS bytes,
              table_rows AS \`rows\`
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
       ORDER BY (data_length + index_length) DESC
       LIMIT 20`
    );
    const t = totals[0] || {};
    return {
      name: name || null,
      totalBytes: Number(t.bytes) || 0,
      dataBytes: Number(t.dataBytes) || 0,
      indexBytes: Number(t.indexBytes) || 0,
      tableCount: Number(t.tables) || 0,
      tables: tableRows.map((r) => ({
        name: r.name,
        bytes: Number(r.bytes) || 0,
        rows: Number(r.rows) || 0,
      })),
    };
  }

  // Both, with the database part being resilient (errors surface as { error }).
  async function getStorage() {
    const disk = await getDisk();
    let database;
    try {
      database = await getDatabase();
    } catch (err) {
      database = { available: false, error: err.message };
    }
    return { at: new Date().toISOString(), disk, database };
  }

  return { getDisk, getDatabase, getStorage };
}

module.exports = { createSystemInfo };
