'use strict';

const { rank } = require('./config');

const silentLogger = { info() {}, warn() {}, error() {} };

// Routes findings to the configured channels under two rules: a minimum
// severity per channel, and a cooldown/dedup per (hostId, metric, kind) so the
// same condition on the same host doesn't spam. One channel failing never stops
// the others — each send is caught individually.
//
//   const dispatcher = createDispatcher({ config, channels: { email, webhook, syslog } });
//   await dispatcher.dispatch(finding, group);
//
// `licensed()` gates the whole module; `channelLicensed(name)` gates an
// individual channel (so e.g. a plan may include `alerts_email` but not
// `alerts_webhook`). Both default to allow so callers that don't license per
// channel are unaffected.
function createDispatcher({ config, channels = {}, licensed = () => true, channelLicensed = () => true, logger = silentLogger, now = () => Date.now(), silencer = null, alertLog = null }) {
  const lastSent = new Map(); // `${hostId}|${metric}|${kind}|${severity}` -> timestamp
  let silencedBy = typeof silencer === 'function' ? silencer : null;

  // Severity is part of the key so a cooldown started by a WARN never suppresses
  // a later CRIT escalation for the same metric — each severity throttles on its
  // own. (Repeated same-severity findings are still de-duped within the window.)
  const throttleKey = (f) => `${f.hostId}|${f.metric}|${f.kind}|${f.severity}`;

  // Sends a finding-shaped subject to every enabled + licensed + severity-eligible
  // channel. Shared by dispatch() (findings) and dispatchCluster() (clusters). One
  // channel's failure never aborts the rest. Returns { attempted, results }.
  async function sendToChannels(subject, group) {
    const subjectRank = rank(subject.severity);
    const results = [];
    let attempted = false;
    for (const [name, channel] of Object.entries(channels)) {
      const rule = config.channels && config.channels[name];
      if (!rule || !rule.enabled) continue;
      if (!channelLicensed(name)) {
        results.push({ channel: name, ok: false, skipped: true, detail: 'channel not licensed' });
        continue;
      }
      if (subjectRank < rank(rule.minSeverity)) {
        results.push({ channel: name, ok: false, skipped: true, detail: 'below minSeverity' });
        continue;
      }
      attempted = true;
      try {
        const r = await channel.send(subject, group);
        results.push({ channel: name, ok: Boolean(r && r.ok), detail: r && r.detail });
      } catch (err) {
        results.push({ channel: name, ok: false, detail: `threw: ${err.message}` });
      }
    }
    return { attempted, results };
  }

  // Comma-separated names of the channels that sent OK (for the alert log).
  const okChannelNames = (results) => results.filter((r) => r.ok).map((r) => r.channel).join(',');

  // Best-effort append to the durable alert-dispatch log; never throws to the caller.
  function logAlert(row) {
    if (!alertLog || typeof alertLog.record !== 'function') return;
    Promise.resolve()
      .then(() => alertLog.record(row))
      .catch((err) => logger.warn(`alerting: could not record alert log (${err && err.message})`));
  }

  async function dispatch(finding, group) {
    if (!licensed()) return { dispatched: false, reason: 'unlicensed', results: [] };
    if (!config || !config.enabled) return { dispatched: false, reason: 'disabled', results: [] };
    if (!finding) return { dispatched: false, reason: 'no-finding', results: [] };

    // Maintenance/silencing: the finding is still recorded; we just don't notify.
    // Checked before the throttle so a silenced finding doesn't consume cooldown.
    if (silencedBy) {
      let win = null;
      try { win = await silencedBy(finding); } catch { win = null; }
      if (win) {
        logger.info(`alerting: ${finding.metric} ${finding.severity} suppressed by maintenance window ${win.id || win.name || ''}`);
        return { dispatched: false, reason: 'maintenance', window: win.id || win.name || true, results: [] };
      }
    }

    const key = throttleKey(finding);
    const last = lastSent.get(key);
    const ts = now();
    if (last !== undefined && ts - last < (config.cooldownMs || 0)) {
      return { dispatched: false, reason: 'throttled', results: [] };
    }

    const { attempted, results } = await sendToChannels(finding, group);

    // Only start the cooldown once a channel actually matched and was attempted.
    if (attempted) lastSent.set(key, ts);
    // Durable record so a cross-agent cluster alert can reference (not resend) the
    // members already alerted individually. Best-effort, fire-and-forget.
    if (attempted) {
      logAlert({
        subjectType: 'finding', subjectId: finding.id, hostId: finding.hostId,
        metric: finding.metric, severity: finding.severity, channels: okChannelNames(results), sentAt: new Date(ts),
      });
    }
    const outcome = (r) => (r.ok ? 'ok' : r.skipped ? 'skip' : 'fail');
    const summary = results.map((r) => `${r.channel}:${outcome(r)}`).join(', ') || 'no channel';
    logger.info(`alerting: ${finding.metric} ${finding.severity} -> ${summary}`);
    return { dispatched: attempted, results };
  }

  // Fires ONE cluster-level alert (Step 3) for a cross-agent incident cluster, reusing
  // the same channels as findings. Deduped DURABLY via the alert log so a cluster
  // alerts at most once even across restarts (the in-memory throttle wouldn't survive
  // a restart). The `cluster` is a finding-shaped object (metric/severity/explanation/
  // evidence) plus `clusterId`; `group` carries { advisory, memberFindingIds,
  // alreadyAlerted, ... } so the channels can reference the members already notified.
  // Bypasses the per-(host,metric) throttle and the maintenance silencer (a cluster
  // spans multiple hosts). Best-effort — a channel/log failure never throws.
  async function dispatchCluster(cluster, group) {
    if (!licensed()) return { dispatched: false, reason: 'unlicensed', results: [] };
    if (!config || !config.enabled) return { dispatched: false, reason: 'disabled', results: [] };
    if (!cluster || cluster.clusterId == null) return { dispatched: false, reason: 'no-cluster', results: [] };

    // Durable "once per cluster".
    if (alertLog && typeof alertLog.existsForCluster === 'function') {
      let already = false;
      try { already = await alertLog.existsForCluster(cluster.clusterId); } catch { already = false; }
      if (already) return { dispatched: false, reason: 'already-sent', results: [] };
    }

    const { attempted, results } = await sendToChannels(cluster, group);
    // Await the cluster record (unlike the fire-and-forget finding record) so the
    // durable "once per cluster" guard is visible to any subsequent call.
    if (attempted && alertLog && typeof alertLog.record === 'function') {
      try {
        await alertLog.record({
          subjectType: 'cluster', subjectId: cluster.clusterId, hostId: null,
          metric: cluster.metric, severity: cluster.severity, channels: okChannelNames(results), sentAt: new Date(now()),
        });
      } catch (err) {
        logger.warn(`alerting: could not record cluster alert log (${err && err.message})`);
      }
    }
    const outcome = (r) => (r.ok ? 'ok' : r.skipped ? 'skip' : 'fail');
    const summary = results.map((r) => `${r.channel}:${outcome(r)}`).join(', ') || 'no channel';
    logger.info(`alerting: cluster ${cluster.clusterId} ${cluster.severity} -> ${summary}`);
    return { dispatched: attempted, results };
  }

  // Fires a cluster LIFECYCLE event (opened/update/escalation/resolved — Fase 5)
  // to the channels. Unlike dispatchCluster (the once-per-cluster opened guard),
  // this fires each time the rollup engine decides an event is due; the engine
  // owns "opened once" via the cluster's stored alert state.
  //
  // Per-channel digest: a channel configured `digestMode: 'silent'` receives ONLY
  // opened/escalation/resolved — 'update' events are skipped for it (no per-member
  // noise). All other channels (default 'update') receive everything. `kind` is
  // stamped on the durable alert log. Bypasses the per-host throttle + silencer.
  async function dispatchClusterEvent(cluster, group, { kind = 'update' } = {}) {
    if (!licensed()) return { dispatched: false, reason: 'unlicensed', results: [] };
    if (!config || !config.enabled) return { dispatched: false, reason: 'disabled', results: [] };
    if (!cluster || cluster.clusterId == null) return { dispatched: false, reason: 'no-cluster', results: [] };

    const subjectRank = rank(cluster.severity);
    const results = [];
    let attempted = false;
    for (const [name, channel] of Object.entries(channels)) {
      const rule = (config.channels && config.channels[name]) || null;
      if (!rule || !rule.enabled) continue;
      if (!channelLicensed(name)) { results.push({ channel: name, ok: false, skipped: true, detail: 'channel not licensed' }); continue; }
      if (subjectRank < rank(rule.minSeverity)) { results.push({ channel: name, ok: false, skipped: true, detail: 'below minSeverity' }); continue; }
      // Digest: 'silent' channels skip mid-incident update noise.
      if (kind === 'update' && String(rule.digestMode || 'update') === 'silent') {
        results.push({ channel: name, ok: false, skipped: true, detail: 'silent digest' });
        continue;
      }
      attempted = true;
      try {
        const r = await channel.send({ ...cluster, clusterEvent: kind }, group);
        results.push({ channel: name, ok: Boolean(r && r.ok), detail: r && r.detail });
      } catch (err) {
        results.push({ channel: name, ok: false, detail: `threw: ${err.message}` });
      }
    }
    if (attempted) {
      logAlert({
        subjectType: 'cluster', subjectId: cluster.clusterId, hostId: kind,
        metric: `cluster.${kind}`, severity: cluster.severity, channels: okChannelNames(results), sentAt: new Date(now()),
      });
    }
    const outcome = (r) => (r.ok ? 'ok' : r.skipped ? 'skip' : 'fail');
    logger.info(`alerting: cluster ${cluster.clusterId} ${kind} ${cluster.severity} -> ${results.map((r) => `${r.channel}:${outcome(r)}`).join(', ') || 'no channel'}`);
    return { dispatched: attempted, results, kind };
  }

  // Sanitised view of the active channels + rules (no secrets) for the API.
  function describe() {
    const out = {};
    const ch = (config && config.channels) || {};
    for (const [name, c] of Object.entries(ch)) {
      out[name] = { enabled: Boolean(c.enabled), minSeverity: c.minSeverity };
      if (name === 'email') { out[name].to = c.to; out[name].from = c.from; out[name].smtpHost = c.smtp && c.smtp.host; }
      if (name === 'webhook') { out[name].url = c.url; out[name].signed = Boolean(c.secret); }
      if (name === 'syslog') { out[name].host = c.host; out[name].port = c.port; out[name].proto = c.proto; }
      // Surface runtime availability (e.g. an optional dependency like nodemailer
      // is missing) so the dashboard shows WHY an enabled channel won't deliver,
      // instead of the channel silently failing every send.
      const impl = channels[name];
      if (impl && typeof impl.status === 'function') {
        const st = impl.status() || {};
        out[name].available = st.available !== false;
        if (st.reason) out[name].reason = st.reason;
      }
    }
    return { enabled: Boolean(config && config.enabled), cooldownMs: config && config.cooldownMs, channels: out };
  }

  function channelNames() { return Object.keys(channels); }

  // Sends a synthetic test finding straight to one channel, bypassing the
  // severity/cooldown rules. Returns null for an unknown channel (router → 404).
  async function test(channelName) {
    const channel = channels[channelName];
    if (!channel) return null;
    const finding = {
      id: 'test', hostId: 'test', metric: 'alerting.test', kind: 'TEST', severity: 'WARN',
      explanation: 'BlueEye alerting testbesked', evidence: [{ test: true }], deviation: 0, createdAt: new Date(),
    };
    try {
      const r = await channel.send(finding, null);
      return { channel: channelName, ok: Boolean(r && r.ok), detail: r && r.detail };
    } catch (err) {
      return { channel: channelName, ok: false, detail: `threw: ${err.message}` };
    }
  }

  // Late-bind the silencer (server.js builds it after settingsService exists).
  function setSilencer(fn) { silencedBy = typeof fn === 'function' ? fn : null; }

  return { dispatch, dispatchCluster, dispatchClusterEvent, describe, channelNames, test, setSilencer };
}

module.exports = { createDispatcher };
