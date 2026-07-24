'use strict';

const { createScanner } = require('./scanner');

// Scheduled active-discovery sweep (leader-only singleton). Probes the
// admin-configured CIDR scope for devices passive collection misses, upserts the
// live hosts as candidates (never auto-enrolled), and writes every sweep to the
// hash-chained audit log with scope, start, end and result count.
//
// Refuses to run when scope is unconfigured or exceeds the address cap — the
// scanner validates this BEFORE probing, and the refusal is itself audited.
// Best-effort: a run never throws out of the interval.

function createDiscoverySweepJob({ discoveredDevicesRepo, scanner = createScanner(), auditLogger = null, config, logger = null, now = () => new Date() }) {
  let timer = null;
  let running = false;

  async function audit(action, detail, target) {
    if (!auditLogger || typeof auditLogger.record !== 'function') return null;
    return auditLogger.record(null, {
      category: 'discovery', action, actorRole: 'system',
      target: String(target || '').slice(0, 255),
      detail: String(detail || '').slice(0, 512),
    });
  }

  async function run() {
    if (running) return null;
    running = true;
    const startedAt = now();
    const scope = (config.cidrs || []).join(',');
    try {
      let result;
      try {
        result = await scanner.scan({ cidrs: config.cidrs, addressCap: config.addressCap, ratePerSec: config.rateLimit, portList: config.ports });
      } catch (err) {
        if (err && err.code) {
          await audit('discovery_sweep_refused', `reason=${err.code} scope=${scope || '(none)'}`, scope);
          if (logger && logger.warn) logger.warn(`discovery: refused (${err.code})`);
          return { refused: true, reason: err.code };
        }
        throw err;
      }

      for (const c of result.candidates) {
        await discoveredDevicesRepo.upsertCandidate({ ip: c.ip, hostname: c.hostname, openPorts: c.openPorts, icmp: c.icmp, seenAt: startedAt }); // eslint-disable-line no-await-in-loop
      }
      const endedAt = now();
      await audit(
        'discovery_sweep',
        `addresses=${result.addresses} probed=${result.probed.length} found=${result.candidates.length} start=${startedAt.toISOString()} end=${endedAt.toISOString()}`,
        scope,
      );
      if (logger && logger.info) logger.info(`discovery: swept ${result.addresses} addrs, ${result.candidates.length} candidates`);
      return { addresses: result.addresses, probed: result.probed.length, found: result.candidates.length, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() };
    } catch (err) {
      if (logger && logger.warn) logger.warn(`discovery: sweep failed (${err && err.message})`);
      return null;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    if (!config.enabled) { if (logger && logger.info) logger.info('discovery: disabled (DISCOVERY_ENABLED=false)'); return; }
    run().catch(() => {});
    timer = setInterval(() => run().catch(() => {}), (config.intervalMinutes || 60) * 60 * 1000);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { run, start, stop };
}

module.exports = { createDiscoverySweepJob };
