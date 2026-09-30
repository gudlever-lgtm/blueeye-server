'use strict';

const crypto = require('crypto');

// "The switches have been shouting about this for ten minutes" — as a finding.
//
// THE GAP THIS CLOSES. The agents already receive, parse and classify what the
// network equipment says about security: a login that failed (`auth.failure`),
// traffic an ACL dropped (`acl.denied`), a port that saw a MAC it was not
// configured for (`port.security_violation`), a VPN that would not come up
// (`vpn.negotiation_failed`). The classifier is in the agent
// (src/syslog/classify.js, src/traps/translate.js), the vocabulary is in
// deviceEventCatalog.js under a group literally called `security`, and the rows
// land in device_events with a severity and an occurrence count.
//
// And then nothing happened. They were a screen. Two hundred failed logins
// against the core switch in five minutes looked exactly like two hundred rows,
// and an operator found out by scrolling. Every other class of fault in this
// product becomes a finding — stored, grouped into an event case, alerted on,
// carried to ITSM — and this one did not, although it is the one class where
// the delay costs the most.
//
// WHAT IT IS, AND WHAT IT IS NOT. This is a RATE RULE, not a detector of
// intent. It says "this happened N times in M minutes, which is more than the
// threshold", names the device, and stops. It does not decide the traffic was
// malicious, does not score, does not classify an attack. A brute-force
// attempt and a monitoring system with a stale password produce the same rows,
// and the explanation says so by stating the count and the window rather than
// a verdict. That is the same contract every other finding here has: the
// numbers, and the reader draws the conclusion.
//
// WHY A RATE AND NOT A BASELINE. The median/MAD machinery needs a warm-up
// (ANALYSIS_MIN_SAMPLES) against a value that moves. Failed logins are zero
// almost all the time, so the baseline is a constant and every first event is a
// "step off a constant" — a WARN per login failure, which is noise. A fixed
// rate with a window is the honest shape for a counter that is normally idle,
// and it works on the first day rather than after a fortnight of learning.
//
// WHERE IT RUNS. Called by the device-event ingest AFTER the rows are stored
// (src/devices/deviceEventIngest.js), like the switch-port history: the events
// are already safe, and nothing here can fail or slow the write it watches.
// The window is in memory — a restart forgets a partial burst, which is the
// right failure mode for a rate cap, and a burst that is still going re-arms
// within one window.

// One rule per event type. `windowMinutes` is how far back the count reaches,
// `warn` / `crit` are the occurrence counts that raise. The defaults are set so
// that ordinary operational noise — a technician mistyping a password, an ACL
// dropping the usual scan traffic from the internet — stays under them, and a
// sustained attempt does not.
//
// Every number is overridable per rule (SECURITY_EVENT_RULES, below), because
// what is ordinary differs wildly between a quiet OT network and an edge
// firewall that logs every dropped packet.
const DEFAULT_RULES = Object.freeze({
  // A password guessed at, or a management station with a stale credential.
  // Ten in ten minutes is already someone retrying by hand; fifty is a script.
  'auth.failure': { metric: 'security.auth_failure', windowMinutes: 10, warn: 10, crit: 50 },
  // An ACL dropping traffic is its job, so the bar is much higher: this fires
  // on a rate, and a rate this far above idle means something is knocking
  // repeatedly at a door that is closed.
  'acl.denied': { metric: 'security.acl_denied', windowMinutes: 10, warn: 50, crit: 250 },
  // Port security triggers when a port sees a MAC it was not configured for.
  // It is rare and deliberate, so three of them is already a pattern.
  'port.security_violation': { metric: 'security.port_violation', windowMinutes: 15, warn: 3, crit: 10 },
  // A VPN that will not negotiate is either misconfigured or being probed.
  'vpn.negotiation_failed': { metric: 'security.vpn_failure', windowMinutes: 15, warn: 5, crit: 20 },
});

// How long after raising for one (sender, rule) the detector stays quiet about
// it. Without this a burst that keeps going raises on every batch — thirty
// findings for one incident — and the event case that groups them is no
// substitute for not making them.
const DEFAULT_COOLDOWN_MINUTES = 30;

// A ceiling on how many (sender, rule) windows are tracked at once, so a fleet
// that suddenly logs from ten thousand addresses cannot grow the map without
// bound. The oldest window is dropped first; a sender that is still active
// re-enters on its next event.
const MAX_TRACKED = 5000;

const MINUTE_MS = 60 * 1000;

function toInt(v, d) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; }

// Reads the rule table from the environment. SECURITY_EVENT_RULES is a
// compact per-rule override list, so an operator tunes one threshold without
// restating the others:
//
//   SECURITY_EVENT_RULES="auth.failure:5/30/60,acl.denied:200/1000/10"
//                         ^type       ^warn ^crit ^windowMinutes
//
// An entry naming an unknown event type is kept: the agent's classifier ships
// ahead of this table (deviceEventCatalog.js says so), and refusing a type the
// server has not heard of would mean an agent upgrade could not be acted on.
// An entry that does not parse is dropped and logged rather than taking the
// whole table down with it.
function parseRules(spec, base = DEFAULT_RULES, onBadEntry = () => {}) {
  const rules = {};
  for (const [type, r] of Object.entries(base)) rules[type] = { ...r };
  for (const raw of String(spec == null ? '' : spec).split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const m = /^([a-z0-9._-]+)\s*:\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)$/i.exec(entry);
    if (!m) { onBadEntry(entry); continue; }
    const [, type, warn, crit, windowMinutes] = m;
    const w = Number(warn);
    const c = Number(crit);
    const win = Number(windowMinutes);
    if (w < 1 || c < w || win < 1) { onBadEntry(entry); continue; }
    rules[type] = {
      metric: (rules[type] && rules[type].metric) || `security.${type.replace(/[^a-z0-9]+/gi, '_')}`,
      windowMinutes: win,
      warn: w,
      crit: c,
    };
  }
  return rules;
}

function loadSecurityEventConfig(env = process.env, logger = null) {
  const warn = (msg) => { if (logger && typeof logger.warn === 'function') logger.warn(msg); };
  return {
    // ON by default. The events are already being collected and stored; the
    // only thing this adds is saying so, and an operator who does not want to
    // hear it has severity rules and alert routing to say so precisely.
    enabled: env.SECURITY_EVENT_ALERTS_ENABLED !== 'false',
    cooldownMinutes: Math.max(1, toInt(env.SECURITY_EVENT_COOLDOWN_MINUTES, DEFAULT_COOLDOWN_MINUTES)),
    rules: parseRules(env.SECURITY_EVENT_RULES, DEFAULT_RULES, (entry) => {
      warn(`security-events: ignoring unparseable SECURITY_EVENT_RULES entry "${entry}" (expected type:warn/crit/windowMinutes)`);
    }),
    maxTracked: Math.max(100, toInt(env.SECURITY_EVENT_MAX_TRACKED, MAX_TRACKED)),
  };
}

// Who sent it, as one key. The polled switch when the ingest resolved one
// (`s<id>`), else the agent host (`d<id>`), else the address — the same
// identity ladder the dedup key uses, so a sender is one sender in both.
function senderKey(event) {
  if (event.snmpDeviceId != null) return `s${event.snmpDeviceId}`;
  if (event.deviceId != null) return `d${event.deviceId}`;
  return `ip:${event.sourceIp}`;
}

// How a sender is named in the explanation. The device's own hostname when it
// gave one (it is what the technician will search for), else the address.
function senderLabel(event) {
  return event.deviceHostname || event.sourceIp || 'an unidentified device';
}

function createSecurityEventDetector({
  // Where a raised finding goes: store -> publish -> event case -> alert ->
  // integrations (src/devices/findingSink.js). Without one the detector is
  // inert, which is what a server built without analysis wants.
  findingSink = null,
  licensed = () => true,
  config = loadSecurityEventConfig({}),
  logger = null,
  now = () => new Date(),
} = {}) {
  // `${senderKey}|${eventType}` -> { hits: [{ t, n }], lastRaisedAt }
  const windows = new Map();

  const warn = (msg) => { if (logger && typeof logger.warn === 'function') logger.warn(msg); };

  function isOn() {
    try { return !!(config && config.enabled) && !!licensed(); } catch { return false; }
  }

  // Drops the least recently touched windows once the map is over its ceiling.
  // Map iteration is insertion-ordered and every touch re-inserts, so the head
  // of the iteration is the oldest.
  function evict() {
    if (windows.size <= config.maxTracked) return;
    const over = windows.size - config.maxTracked;
    let i = 0;
    for (const key of windows.keys()) {
      windows.delete(key);
      i += 1;
      if (i >= over) break;
    }
  }

  // Adds one sighting and answers the total inside the rule's window.
  function record(key, rule, at, occurrences) {
    let w = windows.get(key);
    if (!w) w = { hits: [], lastRaisedAt: 0 };
    windows.delete(key);
    const cutoff = at.getTime() - rule.windowMinutes * MINUTE_MS;
    w.hits = w.hits.filter((h) => h.t > cutoff);
    w.hits.push({ t: at.getTime(), n: occurrences });
    windows.set(key, w);
    evict();
    return w;
  }

  function buildFinding({ event, rule, eventType, severity, total, at }) {
    const hostId = String(event.agentId);
    const deviceId = event.snmpDeviceId != null ? Number(event.snmpDeviceId) : null;
    const who = senderLabel(event);
    const where = event.ifname ? ` on ${event.ifname}` : '';
    const labels = {
      eventType,
      sourceIp: event.sourceIp || null,
      deviceHostname: event.deviceHostname || null,
      ifname: event.ifname || null,
      transport: event.transport || null,
      windowMinutes: rule.windowMinutes,
      threshold: severity === 'CRIT' ? rule.crit : rule.warn,
    };
    return {
      id: crypto.randomUUID(),
      // The agent that RECEIVED the message — the same host key every other
      // finding about this equipment carries, so a per-agent read finds it.
      hostId,
      deviceId,
      interfaceId: null,
      metric: rule.metric,
      severity,
      // A fixed rule against a configured count, not a statistical deviation.
      kind: 'THRESHOLD',
      observed: total,
      baseline: null,
      deviation: null,
      window: [new Date(at.getTime() - rule.windowMinutes * MINUTE_MS), at],
      explanation: `${who}${where} reported ${total} × ${eventType} in ${rule.windowMinutes} minutes `
        + `(threshold ${labels.threshold}). The device says what happened; it does not say why — `
        + `a failed credential on a monitoring system and a password being guessed at look the same from here. `
        + `Check the device log for this sender to see the individual messages.`,
      evidence: [{
        hostId,
        deviceId,
        metric: rule.metric,
        value: total,
        ts: at,
        target: event.sourceIp || null,
        labels,
      }],
      correlatedWith: [],
      createdAt: at,
      acked: false,
    };
  }

  // Looks at one agent's batch — the rows AS PREPARED by the ingest, so
  // `deviceId` / `snmpDeviceId` are already resolved — and raises whatever
  // crossed a threshold. Returns the findings raised (possibly none).
  //
  // Best-effort by construction: the caller has already stored the rows, and
  // every failure here is logged and swallowed.
  async function observe(agentId, events) {
    if (!isOn() || !findingSink) return [];
    const rows = (Array.isArray(events) ? events : []).filter((e) => e && config.rules[e.eventType]);
    if (!rows.length) return [];

    const at = now();
    const raised = [];
    // Oldest first, so a batch that spans a threshold crossing raises at the
    // event that crossed it rather than at whichever row came first in the
    // array.
    const ordered = [...rows].sort((a, b) => new Date(a.receivedAt || at) - new Date(b.receivedAt || at));

    for (const event of ordered) {
      const eventType = event.eventType;
      const rule = config.rules[eventType];
      const key = `${senderKey(event)}|${eventType}`;
      const stamp = event.receivedAt ? new Date(event.receivedAt) : at;
      // A row stamped in the future (a device with a wrong clock) would keep a
      // window alive forever; the ingest already stores the skew, and here the
      // sighting is simply pinned to now.
      const seenAt = Number.isFinite(stamp.getTime()) && stamp.getTime() <= at.getTime() ? stamp : at;
      const occurrences = Math.max(1, toInt(event.occurrences, 1));
      const w = record(key, rule, seenAt, occurrences);
      const total = w.hits.reduce((sum, h) => sum + h.n, 0);

      if (total < rule.warn) continue;
      if (at.getTime() - w.lastRaisedAt < config.cooldownMinutes * MINUTE_MS) continue;

      const severity = total >= rule.crit ? 'CRIT' : 'WARN';
      w.lastRaisedAt = at.getTime();
      try {
        // eslint-disable-next-line no-await-in-loop
        const stored = await findingSink.emit(buildFinding({
          event: { ...event, agentId }, rule, eventType, severity, total, at,
        }));
        if (stored) raised.push(stored);
      } catch (err) {
        warn(`security-events: could not raise ${rule.metric} for ${key} (${err.message})`);
      }
    }
    return raised;
  }

  // Test + operational hook: what the detector currently holds, so a support
  // question ("is it counting?") has an answer that is not a guess.
  function state() {
    return [...windows].map(([key, w]) => ({
      key,
      count: w.hits.reduce((sum, h) => sum + h.n, 0),
      lastRaisedAt: w.lastRaisedAt ? new Date(w.lastRaisedAt).toISOString() : null,
    }));
  }

  return { observe, state, rules: config.rules };
}

module.exports = {
  createSecurityEventDetector,
  loadSecurityEventConfig,
  parseRules,
  senderKey,
  DEFAULT_RULES,
  DEFAULT_COOLDOWN_MINUTES,
};
