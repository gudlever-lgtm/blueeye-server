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
function createDispatcher({ config, channels = {}, licensed = () => true, logger = silentLogger, now = () => Date.now() }) {
  const lastSent = new Map(); // `${hostId}|${metric}|${kind}|${severity}` -> timestamp

  // Severity is part of the key so a cooldown started by a WARN never suppresses
  // a later CRIT escalation for the same metric — each severity throttles on its
  // own. (Repeated same-severity findings are still de-duped within the window.)
  const throttleKey = (f) => `${f.hostId}|${f.metric}|${f.kind}|${f.severity}`;

  async function dispatch(finding, group) {
    if (!licensed()) return { dispatched: false, reason: 'unlicensed', results: [] };
    if (!config || !config.enabled) return { dispatched: false, reason: 'disabled', results: [] };
    if (!finding) return { dispatched: false, reason: 'no-finding', results: [] };

    const key = throttleKey(finding);
    const last = lastSent.get(key);
    const ts = now();
    if (last !== undefined && ts - last < (config.cooldownMs || 0)) {
      return { dispatched: false, reason: 'throttled', results: [] };
    }

    const findingRank = rank(finding.severity);
    const results = [];
    let attempted = false;

    for (const [name, channel] of Object.entries(channels)) {
      const rule = config.channels && config.channels[name];
      if (!rule || !rule.enabled) continue;
      if (findingRank < rank(rule.minSeverity)) {
        results.push({ channel: name, ok: false, skipped: true, detail: 'below minSeverity' });
        continue;
      }
      attempted = true;
      try {
        const r = await channel.send(finding, group);
        results.push({ channel: name, ok: Boolean(r && r.ok), detail: r && r.detail });
      } catch (err) {
        // One channel's failure must not abort the rest.
        results.push({ channel: name, ok: false, detail: `threw: ${err.message}` });
      }
    }

    // Only start the cooldown once a channel actually matched and was attempted.
    if (attempted) lastSent.set(key, ts);
    const outcome = (r) => (r.ok ? 'ok' : r.skipped ? 'skip' : 'fail');
    const summary = results.map((r) => `${r.channel}:${outcome(r)}`).join(', ') || 'no channel';
    logger.info(`alerting: ${finding.metric} ${finding.severity} -> ${summary}`);
    return { dispatched: attempted, results };
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

  return { dispatch, describe, channelNames, test };
}

module.exports = { createDispatcher };
