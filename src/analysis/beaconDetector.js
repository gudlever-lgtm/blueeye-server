'use strict';

const crypto = require('crypto');
const { median, robustSigma } = require('./baselines');
const { parseCidr, inScope } = require('../discovery/cidr');

// "This host has been calling the same address every ten minutes, to the
// second, for eleven hours" — as a finding.
//
// THE GAP THIS CLOSES. Everything else in the analysis module measures HOW
// MUCH: bytes against a baseline, a count against a threshold, a first
// sighting. A beacon is not loud. It is a few hundred bytes on a schedule, far
// below any volume baseline, to an address that may be perfectly ordinary. What
// gives it away is not the size but the RHYTHM, and nothing here was looking at
// rhythm. docs/attack-indication.md listed it as the biggest remaining gap.
//
// WHAT THE SIGNAL ACTUALLY IS. An agent sends a flow snapshot on its own
// cadence (60 s by default), so flow_records holds one row per 5-tuple per
// interval that tuple was active in. Line up the distinct timestamps of one
// (internal host -> external peer : port) conversation and look at the gaps
// between them:
//
//   a person browsing     37s  4s  900s  12s  61s  2100s   — ragged
//   a session left open   60s 60s   60s 60s  60s    60s    — every interval
//   a beacon             600s 600s 601s 600s 599s  600s    — every tenth
//
// The middle one is the trap, and it is why this cannot use a fixed number.
// A conversation that never stops appears in every interval, perfectly
// regularly, and looks exactly like a beacon. The only thing that separates
// them is the agent's own reporting cadence — a beacon SKIPS intervals, a
// stream does not — so the cadence is derived per agent from the same table
// (flowsRepository.reportCadence) and a candidate must beat it by a configured
// multiple before its regularity counts for anything.
//
// THE MEASURE. Median gap and a robust sigma over the gaps (median + MAD, the
// same statistics as every other detector here — no second definition of
// "typical"). Jitter is sigma / median: a dimensionless number that is small
// when the gaps are all alike whatever their length. 0.15 by default, so a
// ten-minute beacon may wander about ninety seconds and still count.
//
// WHAT IT DOES NOT SAY. Not "command and control". Plenty of honest software
// beacons: NTP (excluded by default for exactly that reason), update checkers,
// monitoring agents, licence heartbeats, telemetry. The finding states the
// period, the jitter, how long it has been going on and how few bytes each call
// carried, and then stops — the reader knows which of their own software phones
// home and this server does not. The ignore lists are how that knowledge is
// written down once instead of acknowledged every day.
//
// Metadata only: timestamps, a port, an address, a byte count. Never payload —
// which is also why this can never confirm what the traffic IS, only that it
// keeps time.
//
// Leader-only, off the ingest hot path, best-effort throughout.

const MINUTE_MS = 60 * 1000;

function toInt(v, d) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function toNum(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// The ports whose beacon is the network working correctly. NTP is the whole
// list on purpose: it is the one protocol whose entire job is to call out on a
// fixed schedule, it is on every host, and leaving it in would mean every
// deployment's first finding is its own time service. DNS is deliberately NOT
// here — a resolver being called regularly is ordinary, but DNS is also the
// most-used covert channel there is, and excluding it by default would blind
// the detector to the case it is most needed for.
const DEFAULT_IGNORE_PORTS = Object.freeze([123]);

function loadBeaconConfig(env = process.env) {
  const maxJitter = Math.min(1, Math.max(0.001, toNum(env.BEACON_MAX_JITTER, 0.15)));
  return {
    enabled: env.BEACON_ALERTS_ENABLED !== 'false',
    // How far back each run looks. A day: long enough for a slow beacon (one
    // call an hour) to show two dozen calls, short enough to stay inside the
    // raw-flow retention window (RETENTION_RAW_DAYS, 7 days by default).
    windowHours: Math.max(1, toInt(env.BEACON_WINDOW_HOURS, 24)),
    intervalMinutes: Math.max(5, toInt(env.BEACON_JOB_INTERVAL_MINUTES, 60)),
    // Calls needed before regularity means anything. Two calls are always
    // perfectly regular; twelve are a pattern.
    minObservations: Math.max(4, toInt(env.BEACON_MIN_OBSERVATIONS, 12)),
    // How long the pattern must have been running. A beacon is patient; a
    // burst of twelve calls in four minutes is something else.
    minSpanMinutes: Math.max(1, toInt(env.BEACON_MIN_SPAN_MINUTES, 120)),
    // The anti-stream rule: the gap must be at least this many times the
    // agent's own reporting cadence. 2 means "skips at least every other
    // report", which a continuous conversation never does.
    minCadenceMultiple: Math.max(1.5, toNum(env.BEACON_MIN_CADENCE_MULTIPLE, 2)),
    // sigma / median over the gaps. Smaller = more machine-like.
    maxJitter,
    // Below this it is not a schedule, it is a clock. Never above the WARN line.
    critJitter: Math.min(maxJitter, Math.max(0, toNum(env.BEACON_CRIT_JITTER, 0.05))),
    // Candidates pulled per run. Each one costs a timestamp read, so this is
    // the job's real cost knob.
    maxCandidates: Math.max(1, toInt(env.BEACON_MAX_CANDIDATES, 100)),
    maxPerRun: Math.max(1, toInt(env.BEACON_MAX_PER_RUN, 20)),
    // One finding per conversation per day by default: with a 24-hour window
    // and an hourly job the same beacon is re-found every run.
    cooldownMinutes: Math.max(1, toInt(env.BEACON_COOLDOWN_MINUTES, 24 * 60)),
    ignorePorts: parsePorts(env.BEACON_IGNORE_PORTS, DEFAULT_IGNORE_PORTS),
    // Destinations that are allowed to beacon: an update server, a monitoring
    // endpoint, a licence service. Addresses and IPv4 CIDRs.
    ignoreDestinations: splitList(env.BEACON_IGNORE_DESTINATIONS),
    // Whole networks that are allowed to beacon, by AS number — the shape the
    // answer usually takes, because a CDN-hosted update service is a moving
    // set of addresses and one stable ASN.
    ignoreAsns: parsePorts(env.BEACON_IGNORE_ASNS, [], 4294967295),
  };
}

function splitList(v) {
  return String(v == null ? '' : v).split(',').map((s) => s.trim()).filter(Boolean);
}

// A comma-separated integer list, or the fallback when the variable is unset.
// An EMPTY variable means "nothing is ignored" and is honoured as such — an
// operator who wants to hear about NTP must be able to say so.
function parsePorts(v, fallback, max = 65535) {
  // UNSET and EMPTY are different answers: no variable means "use the shipped
  // list", an empty one means "ignore nothing". An operator who wants to hear
  // about their own NTP has to be able to say so, and `BEACON_IGNORE_PORTS=`
  // is how they say it.
  if (v == null) return [...fallback];
  if (String(v).trim() === '') return [];
  const out = [];
  for (const part of splitList(v)) {
    const n = Number.parseInt(part, 10);
    if (Number.isInteger(n) && n > 0 && n <= max) out.push(n);
  }
  return [...new Set(out)];
}

// Builds the "this peer is allowed to beacon" test from the destination and
// ASN ignore lists.
function buildIgnoreList({ ignoreDestinations = [], ignoreAsns = [] } = {}, onBadEntry = () => {}) {
  const exact = new Set();
  const cidrs = [];
  for (const entry of ignoreDestinations) {
    if (entry.includes('/')) {
      const parsed = parseCidr(entry);
      if (parsed) cidrs.push(parsed); else onBadEntry(entry);
      continue;
    }
    exact.add(entry);
  }
  const asns = new Set(ignoreAsns.map((n) => Number(n)).filter((n) => Number.isFinite(n)));
  return {
    ignores({ extIp, asn } = {}) {
      if (asn != null && asns.has(Number(asn))) return true;
      const v = String(extIp == null ? '' : extIp).trim();
      if (!v) return false;
      if (exact.has(v)) return true;
      return cidrs.length ? inScope(v, cidrs) : false;
    },
  };
}

// The gaps between consecutive timestamps, in seconds. Duplicates are already
// excluded by the SELECT DISTINCT that produced them; a zero gap would still be
// dropped here rather than dividing the jitter by nothing.
function intervalsOf(timestamps) {
  const times = (Array.isArray(timestamps) ? timestamps : [])
    .map((t) => (t instanceof Date ? t.getTime() : Date.parse(t)))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i += 1) {
    const d = (times[i] - times[i - 1]) / 1000;
    if (d > 0) gaps.push(d);
  }
  return { times, gaps };
}

// THE WHOLE JUDGEMENT, pure. Timestamps and the agent's cadence in, a verdict
// out — so "why was this called a beacon" is answered by reading one function
// rather than by reasoning about a job.
//
// Returns { observations, spanSec, medianIntervalSec, sigmaSec, jitter,
//           severity, rejected }, where `severity` is null when it is not a
// beacon and `rejected` names which rule said so.
function scoreRegularity(timestamps, { cadenceSec = null, config }) {
  const { times, gaps } = intervalsOf(timestamps);
  const observations = times.length;
  const spanSec = observations > 1 ? (times[times.length - 1] - times[0]) / 1000 : 0;
  const base = { observations, spanSec, medianIntervalSec: null, sigmaSec: null, jitter: null, severity: null, rejected: null };

  if (observations < config.minObservations) return { ...base, rejected: 'too_few_observations' };
  if (spanSec < config.minSpanMinutes * 60) return { ...base, rejected: 'too_short_span' };
  if (gaps.length < 2) return { ...base, rejected: 'too_few_observations' };

  const med = median(gaps);
  if (!Number.isFinite(med) || med <= 0) return { ...base, rejected: 'no_interval' };

  // The anti-stream rule. Without a cadence there is nothing to compare
  // against, so the candidate is skipped rather than guessed at: calling a
  // continuous replication link a beacon is the one mistake that would get this
  // detector switched off.
  if (cadenceSec == null || !(cadenceSec > 0)) {
    return { ...base, medianIntervalSec: med, rejected: 'no_cadence' };
  }
  if (med < cadenceSec * config.minCadenceMultiple) {
    return { ...base, medianIntervalSec: med, rejected: 'continuous' };
  }

  // robustSigma answers null when every gap is IDENTICAL. For a baseline that
  // means "no scale exists"; here it means the opposite — gaps that never vary
  // at all are the strongest beacon there is — so null is read as zero jitter,
  // not as a missing measurement.
  const sigma = robustSigma(gaps, med);
  const sigmaSec = sigma == null ? 0 : sigma;
  const jitter = sigmaSec / med;
  if (jitter > config.maxJitter) {
    return { ...base, medianIntervalSec: med, sigmaSec, jitter, rejected: 'irregular' };
  }
  return {
    ...base,
    medianIntervalSec: med,
    sigmaSec,
    jitter,
    severity: jitter <= config.critJitter ? 'CRIT' : 'WARN',
  };
}

// "every 10 minutes", "every 1h 30m" — the period as a person would say it.
function describeInterval(sec) {
  const s = Math.round(sec);
  if (s < 90) return `every ${s} seconds`;
  const mins = Math.round(s / 60);
  if (mins < 90) return `every ${mins} minutes`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `every ${hours}h ${rem}m` : `every ${hours} hours`;
}

function describeSpan(sec) {
  const hours = sec / 3600;
  if (hours < 1) return `${Math.round(sec / 60)} minutes`;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

function createBeaconDetector({
  flowsRepo = null,
  // store -> publish -> event case -> alert -> integrations.
  findingSink = null,
  licensed = () => true,
  // A live getter so a change in Settings applies without a restart; a plain
  // object is accepted too (tests, and a server without the settings service).
  config = loadBeaconConfig({}),
  logger = null,
  now = () => new Date(),
} = {}) {
  let timer = null;
  let running = false;
  // `${agentId}|${srcIp}|${extIp}|${dstPort}` -> ms of the last finding.
  const lastRaised = new Map();

  const warn = (msg) => { if (logger && typeof logger.warn === 'function') logger.warn(msg); };
  const info = (msg) => { if (logger && typeof logger.info === 'function') logger.info(msg); };

  function cfg() {
    try {
      const c = typeof config === 'function' ? config() : config;
      return c && typeof c === 'object' ? c : loadBeaconConfig({});
    } catch {
      return loadBeaconConfig({});
    }
  }

  function isOn(c) {
    try { return !!(c && c.enabled) && !!licensed() && !!flowsRepo && !!findingSink; } catch { return false; }
  }

  function buildFinding({ row, score, c, at }) {
    const hostId = String(row.agentId);
    const peer = row.asn != null
      ? `${row.extIp} (AS${row.asn}${row.asnName ? ` ${row.asnName}` : ''}${row.country ? `, ${row.country}` : ''})`
      : row.extIp;
    const perCall = score.observations > 0 ? Math.round(row.bytes / score.observations) : 0;
    const jitterPct = (score.jitter * 100).toFixed(1);
    const labels = {
      srcIp: row.srcIp,
      extIp: row.extIp,
      dstPort: row.dstPort,
      proto: row.proto,
      asn: row.asn,
      asnName: row.asnName,
      country: row.country,
      observations: score.observations,
      intervalSeconds: Math.round(score.medianIntervalSec),
      jitter: Number(score.jitter.toFixed(4)),
      spanSeconds: Math.round(score.spanSec),
      bytesPerCall: perCall,
      maxJitter: c.maxJitter,
    };
    return {
      id: crypto.randomUUID(),
      // The agent that SAW the conversation. The internal host is the subject
      // and lives in the evidence target — it may or may not be a monitored
      // host of its own.
      hostId,
      deviceId: null,
      interfaceId: null,
      metric: 'net.beacon',
      severity: score.severity,
      kind: 'THRESHOLD',
      observed: Math.round(score.medianIntervalSec),
      baseline: null,
      deviation: null,
      window: [row.firstSeen || new Date(at.getTime() - c.windowHours * 3600 * 1000), row.lastSeen || at],
      explanation: `${row.srcIp} contacted ${peer} on ${row.proto || 'ip'}/${row.dstPort} `
        + `${describeInterval(score.medianIntervalSec)} for ${describeSpan(score.spanSec)} `
        + `(${score.observations} calls, timing varied ${jitterPct}% — under the ${(c.maxJitter * 100).toFixed(0)}% `
        + `that separates a schedule from a person, and about ${perCall} bytes per call). `
        + `Regular outbound contact is how malware checks in, and it is also how update checkers, monitoring `
        + `agents and licence heartbeats work — this says the traffic keeps time, not what it is. `
        + `Metadata only: no payload was read, so nothing here can confirm the contents. `
        + `If this is your own software, add the destination or its AS number to the beacon ignore list `
        + `(Settings → Attack indication) instead of acknowledging it every day.`,
      evidence: [{
        hostId,
        metric: 'net.beacon',
        value: Math.round(score.medianIntervalSec),
        ts: row.lastSeen || at,
        target: `${row.srcIp} -> ${row.extIp}:${row.dstPort}`,
        labels,
      }],
      correlatedWith: [],
      createdAt: at,
      acked: false,
    };
  }

  // One pass over the window. Returns a summary, or null when it did not run.
  async function run() {
    const c = cfg();
    if (!isOn(c) || running) return null;
    running = true;
    try {
      const t = now();
      // Whole minutes, so two runs an hour apart ask about the same grid and a
      // finding's window is a round number.
      const to = new Date(Math.floor(t.getTime() / MINUTE_MS) * MINUTE_MS);
      const from = new Date(to.getTime() - c.windowHours * 3600 * 1000);
      const ignore = buildIgnoreList(c, (entry) => warn(`beacon: ignoring unparseable beacon destination "${entry}"`));

      // The cadence is read from the LAST hour rather than the whole window:
      // the same number, a fraction of the rows, and it tracks an agent whose
      // interval was changed today.
      const cadence = await flowsRepo.reportCadence({
        from: new Date(to.getTime() - 3600 * 1000), to,
      });

      const candidates = await flowsRepo.beaconCandidates({
        from,
        to,
        minObservations: c.minObservations,
        ignorePorts: c.ignorePorts,
        limit: c.maxCandidates,
      });

      let raised = 0;
      let ignored = 0;
      let cooling = 0;
      let over = 0;
      const rejected = {};
      for (const row of Array.isArray(candidates) ? candidates : []) {
        if (ignore.ignores(row)) { ignored += 1; continue; }
        const key = `${row.agentId}|${row.srcIp}|${row.extIp}|${row.dstPort}`;
        const last = lastRaised.get(key) || 0;
        if (t.getTime() - last < c.cooldownMinutes * MINUTE_MS) { cooling += 1; continue; }

        let times = [];
        try {
          // eslint-disable-next-line no-await-in-loop
          times = await flowsRepo.beaconTimestamps({
            agentId: row.agentId, srcIp: row.srcIp, extIp: row.extIp, dstPort: row.dstPort, proto: row.proto, from, to,
          });
        } catch (err) {
          warn(`beacon: could not read the timings for ${key} (${err.message})`);
          continue;
        }
        const score = scoreRegularity(times, { cadenceSec: cadence.get(row.agentId) ?? null, config: c });
        if (!score.severity) {
          rejected[score.rejected || 'unknown'] = (rejected[score.rejected || 'unknown'] || 0) + 1;
          continue;
        }
        if (raised >= c.maxPerRun) { over += 1; continue; }
        lastRaised.set(key, t.getTime());
        try {
          // eslint-disable-next-line no-await-in-loop
          const stored = await findingSink.emit(buildFinding({ row, score, c, at: t }));
          if (stored) raised += 1;
        } catch (err) {
          warn(`beacon: could not raise net.beacon for ${key} (${err.message})`);
        }
      }

      // Forget cooldowns that have expired, so the map cannot grow with every
      // conversation this server has ever seen.
      const stale = t.getTime() - c.cooldownMinutes * MINUTE_MS;
      for (const [key, ms] of lastRaised) if (ms < stale) lastRaised.delete(key);

      if (over) {
        warn(`beacon: ${over} more regular conversation(s) in this window were not raised `
          + `(limit ${c.maxPerRun} per run, BEACON_MAX_PER_RUN)`);
      }
      const why = Object.entries(rejected).map(([k, n]) => `${k}=${n}`).join(' ');
      info(`beacon: ${from.toISOString()}–${to.toISOString()} candidates ${(candidates || []).length}, `
        + `raised ${raised}, ignored ${ignored}, in cooldown ${cooling}${why ? `, not a beacon (${why})` : ''}`);
      return {
        from: from.toISOString(), to: to.toISOString(),
        candidates: (candidates || []).length, raised, ignored, cooling, over, rejected,
      };
    } catch (err) {
      warn(`beacon: run failed (${err && err.message})`);
      return null;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    run().catch(() => {});
    timer = setInterval(() => run().catch(() => {}), cfg().intervalMinutes * MINUTE_MS);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { start, stop, run, score: (times, cadenceSec) => scoreRegularity(times, { cadenceSec, config: cfg() }) };
}

module.exports = {
  createBeaconDetector,
  loadBeaconConfig,
  scoreRegularity,
  intervalsOf,
  buildIgnoreList,
  describeInterval,
  describeSpan,
  DEFAULT_IGNORE_PORTS,
};
