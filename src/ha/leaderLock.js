'use strict';

const silentLogger = { info() {}, warn() {}, error() {} };

// MySQL advisory-lock based leader election for high-availability deployments.
//
// When several blueeye-server replicas run behind a load balancer, exactly ONE
// of them must own the singleton background work (retention rollup/purge,
// test-package scheduling, GeoIP auto-update). We elect that node with MySQL's
// session-scoped advisory lock: `GET_LOCK(name, 0)` returns 1 to the single
// session that wins and 0 to everyone else. The lock is held for as long as the
// owning DB connection lives, so we keep a DEDICATED connection out of the pool
// while we are leader and never run other queries on it.
//
// Failover is automatic: if the leader crashes (or its DB connection drops) the
// lock is released by the server, and on the next tick a follower's `GET_LOCK`
// succeeds and it promotes itself.
//
// Injecting `pool` (mysql2) keeps this unit testable — the test suite passes a
// fake pool that models GET_LOCK / RELEASE_LOCK / IS_USED_LOCK semantics.
function createLeaderLock({
  pool,
  lockName = 'blueeye_leader',
  nodeId,
  // GET_LOCK wait in seconds. 0 = non-blocking (return immediately), which is
  // what we want for a poll loop so a follower never parks a request thread.
  lockTimeoutSec = 0,
  logger = silentLogger,
  now = () => Date.now(),
  // Called with `true` when this node becomes leader and `false` when it loses
  // leadership. Wired by the coordinator to start/stop the singleton jobs.
  onChange = null,
} = {}) {
  let conn = null; // dedicated connection held WHILE leader
  let leader = false;
  let since = null;

  function notify(isLeader) {
    if (!onChange) return;
    try {
      onChange(isLeader);
    } catch (err) {
      logger.error(`ha: onChange handler threw (${err && err.message})`);
    }
  }

  // Try to win the lock. Idempotent: a no-op when already leader.
  async function acquire() {
    if (leader) return true;
    let c;
    try {
      c = await pool.getConnection();
    } catch (err) {
      logger.warn(`ha: could not get a DB connection to contend for leadership (${err.message})`);
      return false;
    }
    try {
      const [rows] = await c.query('SELECT GET_LOCK(?, ?) AS ok', [lockName, lockTimeoutSec]);
      const ok = rows && rows[0] && Number(rows[0].ok) === 1;
      if (ok) {
        conn = c;
        leader = true;
        since = now();
        logger.info(`ha: acquired leader lock "${lockName}" as node ${nodeId}`);
        notify(true);
        return true;
      }
      // Someone else holds it — return the connection to the pool.
      c.release();
      return false;
    } catch (err) {
      try { c.release(); } catch { /* ignore */ }
      logger.warn(`ha: leadership contention query failed (${err.message})`);
      return false;
    }
  }

  // Confirm we still own the lock on our dedicated connection. If the connection
  // died (network blip / DB restart) we treat that as a loss and demote, so a
  // healthy node can take over.
  async function verify() {
    if (!leader || !conn) return false;
    try {
      const [rows] = await conn.query(
        'SELECT IS_USED_LOCK(?) AS owner_cid, CONNECTION_ID() AS my_cid',
        [lockName]
      );
      const row = rows && rows[0];
      const ownerCid = row ? row.owner_cid : null;
      const myCid = row ? row.my_cid : null;
      if (ownerCid === null || String(ownerCid) !== String(myCid)) {
        logger.warn('ha: leader lock is no longer held by this node — demoting');
        await demote();
        return false;
      }
      return true;
    } catch (err) {
      logger.warn(`ha: leader health-check failed (${err.message}) — demoting`);
      await demote();
      return false;
    }
  }

  // Drop leadership. `release` issues RELEASE_LOCK first (a clean, voluntary
  // step-down); an unclean loss just discards the broken connection.
  async function demote(release = false) {
    const wasLeader = leader;
    leader = false;
    since = null;
    if (conn) {
      if (release) {
        try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch { /* ignore */ }
      }
      try { conn.release(); } catch { /* ignore */ }
      conn = null;
    }
    if (wasLeader) {
      logger.info(`ha: node ${nodeId} stepped down from leader`);
      notify(false);
    }
  }

  // One election tick: re-confirm leadership, or contend for it.
  async function tick() {
    if (leader) return verify();
    return acquire();
  }

  // Voluntary step-down (admin action / shutdown): release the lock so another
  // replica can pick it up immediately rather than after a lock timeout.
  async function release() {
    await demote(true);
  }

  function isLeader() {
    return leader;
  }

  function status() {
    return {
      nodeId,
      lockName,
      isLeader: leader,
      since: since ? new Date(since).toISOString() : null,
    };
  }

  return { tick, acquire, verify, release, demote, isLeader, status };
}

module.exports = { createLeaderLock };
