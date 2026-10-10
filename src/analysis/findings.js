'use strict';

const crypto = require('crypto');
const { applySeverity } = require('../events/severityRules');
const { Severity, FindingKind } = require('./constants');
const { CORROBORATION_EXEMPT_SEVERITIES, summarize } = require('./attackIndication');

// Columns selected when reading findings back.
const COLUMNS =
  'id, host_id, device_id, interface_id, metric, severity, original_severity, severity_rule_id, kind, ' +
  'observed, baseline, deviation, ' +
  'window_from, window_to, explanation, evidence, correlated_with, event_case_id, acked, created_at';

// Hard ceiling on how many findings a single list() call can return.
const MAX_LIST = 5000;

// The stored severities, as a set — the attack-indication read filters on them
// and must not pass an unchecked string into an IN ().
const SEVERITIES_SET = new Set(['INFO', 'WARN', 'CRIT']);

// Narrow projection for bulk id reads. Deliberately excludes `evidence` and
// `correlated_with`: those are JSON blobs, and pulling tens of thousands of them
// back just to count severities is the difference between a few hundred KB and
// tens of MB on the wire.
//
// device_id/interface_id/event_case_id are small integers and ride along: the
// Troubleshooting overview needs them to say WHICH node an open fault sits on
// (a switch port finding carries the polling agent in host_id) and which event
// case it belongs to, and a second read for three integers would cost more
// than it saves.
const LIGHT_COLUMNS = 'id, host_id, device_id, interface_id, metric, severity, kind, event_case_id, acked, created_at';

// How many ids go into one IN (...) batch. Keeps the statement (and the
// prepared-parameter list) inside sane limits while still turning an N+1 into
// ceil(N/1000) round trips.
const ID_CHUNK = 1000;

// Builds the shared WHERE fragment (+ ordered params) used by both list() and
// summary(), so the aggregate overview and the row list always scope to the
// exact same filter set. Only defined keys contribute a clause.
function buildFilter({ hostId, deviceId, interfaceId, severity, metric, since, until, open } = {}) {
  const where = [];
  const params = [];
  // OPEN ONLY — the default the Analysis screen asks for, and the reason that
  // screen can be fast at all. A fleet that has been running for a year holds
  // ~185 000 findings and 98 open ones; every grouping below used to scan all
  // 185 000 whatever the operator had accepted, so accepting made the page
  // slower (more rows) rather than faster. Scoped to `acked = 0` the same four
  // groupings read the 98, through idx_findings_open (migration 114).
  //
  // Placed FIRST so it is the leading column of the index range.
  if (open) where.push('acked = 0');
  if (hostId) {
    where.push('host_id = ?');
    params.push(hostId);
  }
  // A finding about a switch port carries the POLLING agent in host_id as well,
  // so the two filters narrow rather than exclude each other: "everything on
  // this agent" still includes the switches it polls, and "this device" is the
  // narrower question.
  if (deviceId) {
    where.push('device_id = ?');
    params.push(Number(deviceId));
  }
  if (interfaceId) {
    where.push('interface_id = ?');
    params.push(Number(interfaceId));
  }
  if (severity) {
    where.push('severity = ?');
    params.push(severity);
  }
  if (metric) {
    where.push('metric = ?');
    params.push(metric);
  }
  if (since) {
    where.push('created_at >= ?');
    params.push(since instanceof Date ? since : new Date(since));
  }
  if (until) {
    where.push('created_at <= ?');
    params.push(until instanceof Date ? until : new Date(until));
  }
  return { where, params };
}

// Findings over TIME, bucketed, for the reporting charts.
//
// The Analysis screen answers "what is wrong now". This answers "when, and is
// it getting better" — which is a different question and belongs on a
// different page. Both run through the same `buildFilter`, so a trend and a
// list scoped the same way describe the same findings.
//
// The bucket is chosen by the caller, not guessed from the range: an hourly
// bucket over ninety days is 2 160 points for a chart 760 pixels wide, and a
// daily bucket over one day is a single bar. The route decides, and the
// choice is visible in the answer.
async function trendQuery(pool, { bucket, filters, limit }) {
  // MySQL DATE_FORMAT, not a computed range join: the grouping key IS the
  // bucket, so an empty hour is simply absent rather than costing a row.
  const FORMAT = { hour: '%Y-%m-%d %H:00:00', day: '%Y-%m-%d' };
  const fmt = FORMAT[bucket] || FORMAT.day;
  const { where, params } = buildFilter(filters || {});
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(created_at, ?) AS bucket,
            COUNT(*) AS cnt,
            SUM(severity = 'CRIT') AS crit,
            SUM(severity = 'WARN') AS warn,
            SUM(severity = 'INFO') AS info,
            SUM(acked = 1) AS acked
       FROM findings ${clause}
      GROUP BY bucket
      ORDER BY bucket ASC
      LIMIT ?`,
    [fmt, ...params, limit],
  );
  return rows.map((r) => ({
    bucket: r.bucket,
    count: Number(r.cnt) || 0,
    crit: Number(r.crit) || 0,
    warn: Number(r.warn) || 0,
    info: Number(r.info) || 0,
    acked: Number(r.acked) || 0,
  }));
}

// The SQL half of a match scope: the columns a severity rule or a named pattern
// (src/events/patterns.js) pins down, as a WHERE fragment. One place, so the
// backfill and the pattern's match count can never disagree about what a scope
// covers.
function scopeFilter(scope) {
  const where = [];
  const params = [];
  if (!scope) return { where, params };
  if (scope.match_metric) { where.push('metric = ?'); params.push(scope.match_metric); }
  if (scope.match_kind) { where.push('kind = ?'); params.push(scope.match_kind); }
  if (scope.match_host_id) { where.push('host_id = ?'); params.push(scope.match_host_id); }
  return { where, params };
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

// Re-hydrate stored sample timestamps (stored as ISO strings inside the JSON).
function reviveEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.map((s) => ({ ...s, ts: s && s.ts ? new Date(s.ts) : s.ts }));
}

// Maps a DB row to the public Finding shape.
function mapRow(row) {
  return {
    id: row.id,
    hostId: row.host_id,
    // NULL on a finding about an agent. A finding about a switch port carries
    // both, AND the polling agent in hostId, so a per-agent read still finds it
    // (migration 110).
    deviceId: row.device_id == null ? null : Number(row.device_id),
    interfaceId: row.interface_id == null ? null : Number(row.interface_id),
    metric: row.metric,
    severity: row.severity,
    // Non-null only when a severity rule changed this. The pair travels with
    // every finding because a downgraded critical that does not say it was
    // downgraded is exactly the event nobody ever looks at again.
    originalSeverity: row.original_severity == null ? null : row.original_severity,
    severityRuleId: row.severity_rule_id == null ? null : Number(row.severity_rule_id),
    kind: row.kind,
    observed: row.observed,
    baseline: row.baseline,
    deviation: row.deviation,
    window: [row.window_from, row.window_to],
    explanation: row.explanation,
    evidence: reviveEvidence(parseJson(row.evidence, [])),
    correlatedWith: parseJson(row.correlated_with, []) || [],
    eventCaseId: row.event_case_id == null ? null : Number(row.event_case_id),
    createdAt: row.created_at,
    acked: row.acked === 1 || row.acked === true,
  };
}

// Maps a row read through LIGHT_COLUMNS. Separate from mapRow so the missing
// columns are an explicit contract rather than a pile of undefineds: a light
// finding carries no window, explanation, evidence or correlations, and callers
// that need them must read the full row.
function mapLightRow(row) {
  return {
    id: row.id,
    hostId: row.host_id,
    deviceId: row.device_id == null ? null : Number(row.device_id),
    interfaceId: row.interface_id == null ? null : Number(row.interface_id),
    metric: row.metric,
    severity: row.severity,
    kind: row.kind,
    eventCaseId: row.event_case_id == null ? null : Number(row.event_case_id),
    createdAt: row.created_at,
    acked: row.acked === 1 || row.acked === true,
  };
}

// Persists and reads analysis findings, reusing the server's existing DB handle
// (db.pool) — it does NOT open a new connection. Construct with the same `db`
// object the rest of the server uses: new FindingStore({ db }).
class FindingStore {
  // `severityRules` is optional: without it every finding is stored exactly as
  // the detector judged it, which is what BlueEyes did before rules existed.
  constructor({ db, severityRules = null }) {
    if (!db || !db.pool) {
      throw new Error('FindingStore requires the server db handle ({ db: { pool } })');
    }
    this.pool = db.pool;
    this.severityRules = severityRules;
  }

  // Validates and persists a finding. A finding MUST carry a non-empty
  // explanation and at least one evidence sample, otherwise this throws.
  // Returns the stored finding (with id/createdAt filled in if absent).
  async save(finding) {
    if (!finding || typeof finding !== 'object') {
      throw new Error('save requires a finding object');
    }
    if (typeof finding.explanation !== 'string' || finding.explanation.trim() === '') {
      throw new Error('finding.explanation must be a non-empty string');
    }
    if (!Array.isArray(finding.evidence) || finding.evidence.length < 1) {
      throw new Error('finding.evidence must contain at least one sample');
    }

    const id = finding.id || crypto.randomUUID();
    const createdAt = finding.createdAt instanceof Date ? finding.createdAt : new Date();
    const win = Array.isArray(finding.window) ? finding.window : [null, null];

    // Severity rules (migration 086). Applied HERE, at store time, because this
    // is the single point every finding passes through — and because alerting
    // reads the stored severity, which is the whole point of not paging on it.
    //
    // Store time rather than read time is also what keeps history honest: a
    // rule written today must not silently rewrite what you thought last March.
    const decision = await this.decideSeverity({
      source: 'finding',
      severity: finding.severity || Severity.INFO,
      metric: finding.metric,
      kind: finding.kind || FindingKind.ANOMALY,
      host_id: finding.hostId,
    });

    await this.pool.query(
      `INSERT INTO findings
         (id, host_id, device_id, interface_id, metric, severity, original_severity, severity_rule_id, kind,
          observed, baseline, deviation,
          window_from, window_to, explanation, evidence, correlated_with, acked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        finding.hostId,
        // NULL for a finding about an agent, which is every finding that
        // existed before migration 110 and most of the ones after it.
        finding.deviceId ?? null,
        finding.interfaceId ?? null,
        finding.metric,
        decision.severity,
        decision.original_severity,
        decision.severity_rule_id,
        finding.kind || FindingKind.ANOMALY,
        finding.observed ?? null,
        finding.baseline ?? null,
        finding.deviation ?? null,
        win[0] ?? null,
        win[1] ?? null,
        finding.explanation,
        JSON.stringify(finding.evidence),
        JSON.stringify(finding.correlatedWith || []),
        finding.acked ? 1 : 0,
        createdAt,
      ]
    );

    return {
      ...finding,
      id,
      createdAt,
      severity: decision.severity,
      originalSeverity: decision.original_severity,
      severityRuleId: decision.severity_rule_id,
      acked: Boolean(finding.acked),
    };
  }

  // The severity this finding should be stored with. Never throws and never
  // blocks: a rule set that cannot be read leaves the detector's own judgement
  // in place, which is the safe direction — the alternative is silently losing
  // the downgrade AND silently losing the finding.
  async decideSeverity(event) {
    if (!this.severityRules) return { severity: event.severity, original_severity: null, severity_rule_id: null };
    try {
      const rules = await this.severityRules.active();
      const decision = applySeverity(rules, event);
      if (decision.changed && typeof this.severityRules.recordApplied === 'function') {
        // Not awaited: a statistic is not worth delaying a finding for.
        Promise.resolve(this.severityRules.recordApplied(decision.severity_rule_id)).catch(() => {});
      }
      return decision;
    } catch {
      return { severity: event.severity, original_severity: null, severity_rule_id: null };
    }
  }

  // How many OPEN findings fall inside a match scope — a severity rule's, or a
  // named pattern's (src/events/patterns.js). The backfill's own count is this
  // plus "and the severity would actually change"; a pattern has no severity to
  // change, so the question it asks is this one.
  async countMatchingScope(scope) {
    const f = scopeFilter(scope);
    const where = ['acked = 0', ...f.where];
    const [rows] = await this.pool.query(
      `SELECT COUNT(*) AS n FROM findings WHERE ${where.join(' AND ')}`,
      f.params
    );
    return Number(rows[0] ? rows[0].n : 0);
  }

  // Applies a rule to findings that ALREADY exist — the explicit backfill, never
  // something writing a rule does on its own.
  //
  // Scoped to findings that are not yet acknowledged: a finding somebody has
  // already read and acted on is history, and rewriting its severity after the
  // fact would change the record of what they were looking at.
  async applySeverityRule(rule, { dryRun = true } = {}) {
    const scope = scopeFilter(rule);
    const where = ['acked = 0', 'severity <> ?', ...scope.where];
    const params = [rule.severity, ...scope.params];

    const [counted] = await this.pool.query(
      `SELECT COUNT(*) AS n FROM findings WHERE ${where.join(' AND ')}`,
      params
    );
    const matched = Number(counted[0] ? counted[0].n : 0);
    if (dryRun) return { matched, changed: matched };

    const [res] = await this.pool.query(
      `UPDATE findings
          SET original_severity = COALESCE(original_severity, severity),
              severity = ?,
              severity_rule_id = ?
        WHERE ${where.join(' AND ')}`,
      [rule.severity, rule.id, ...params]
    );
    return { matched, changed: res.affectedRows || 0 };
  }

  // Lists findings, newest first. Optionally filters by hostId, a `since` lower
  // bound and an `until` UPPER bound on created_at (Date or ISO string). The
  // upper bound matters for historical windows: without it, `limit` is applied
  // to [since, now] and a later in-window slice can silently drop rows. `limit`
  // is always bounded so an unfiltered call can never return the whole table; it
  // defaults to (and is capped at) MAX_LIST. The optional trailing `filters`
  // object narrows by exact `severity` and/or `metric` (used by the Analysis
  // page's filterable header) — omitting it keeps the historical 4-arg behaviour.
  async list(hostId, since, limit, until, filters = {}) {
    const { where, params } = buildFilter({ hostId, since, until, ...filters });
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIST) : MAX_LIST;
    params.push(n);
    const [rows] = await this.pool.query(
      `SELECT ${COLUMNS} FROM findings ${clause} ORDER BY created_at DESC, id LIMIT ?`,
      params
    );
    return rows.map(mapRow);
  }

  // Aggregated overview for the Analysis page — counts and robust deviation
  // stats grouped by severity, by metric and by host, over the SAME filter set
  // as list() (hostId/severity/metric/since/until). One scan per grouping; all
  // done in SQL so the dashboard never pulls the raw rows just to total them.
  // deviation can be NULL (threshold/flatline findings) — AVG/MAX skip NULLs.
  async summary({ hostId, severity, metric, since, until, open } = {}) {
    const { where, params } = buildFilter({ hostId, severity, metric, since, until, open });
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [sevRows] = await this.pool.query(
      `SELECT severity, COUNT(*) AS cnt, SUM(acked = 1) AS acked
         FROM findings ${clause} GROUP BY severity`,
      params
    );
    const [metricRows] = await this.pool.query(
      `SELECT metric, COUNT(*) AS cnt, AVG(deviation) AS avg_dev, MAX(deviation) AS max_dev
         FROM findings ${clause} GROUP BY metric ORDER BY cnt DESC, metric ASC`,
      params
    );
    // The open counts are the ones a screen called "what is wrong, and where"
    // can act on, and they are counted separately from the totals on purpose:
    // accepting a host's findings used to change nothing anybody could see,
    // because CRIT/WARN were COUNT(*) over accepted rows too. The totals stay —
    // a report that says "412 findings, 400 accepted" is a different, useful
    // sentence — but "what is wrong NOW" is open_crit/open_warn.
    const [hostRows] = await this.pool.query(
      `SELECT host_id,
              COUNT(*) AS cnt,
              SUM(severity = 'CRIT') AS crit,
              SUM(severity = 'WARN') AS warn,
              SUM(severity = 'INFO') AS info,
              SUM(acked = 1) AS acked,
              SUM(acked = 0) AS open_total,
              SUM(severity = 'CRIT' AND acked = 0) AS open_crit,
              SUM(severity = 'WARN' AND acked = 0) AS open_warn,
              SUM(severity = 'INFO' AND acked = 0) AS open_info,
              AVG(deviation) AS avg_dev,
              MAX(deviation) AS max_dev,
              MAX(created_at) AS last_at
         FROM findings ${clause} GROUP BY host_id ORDER BY cnt DESC, host_id ASC`,
      params
    );

    // WHAT is wrong on each host, not just how much. "core-sw: 412 findings" is
    // a number; "core-sw: discards on 3 ports, latency to 2 targets" is the
    // thing somebody acts on. One extra grouped read rather than a query per
    // host, and capped per host when rendered — a host with forty distinct
    // metrics has a different problem than the list can express.
    const [hostMetricRows] = await this.pool.query(
      `SELECT host_id, metric,
              COUNT(*) AS cnt,
              SUM(severity = 'CRIT') AS crit,
              MAX(created_at) AS last_at
         FROM findings ${clause}
        GROUP BY host_id, metric
        ORDER BY host_id ASC, cnt DESC, metric ASC`,
      params
    );
    const metricsByHost = new Map();
    for (const r of hostMetricRows) {
      const key = String(r.host_id);
      if (!metricsByHost.has(key)) metricsByHost.set(key, []);
      metricsByHost.get(key).push({
        metric: r.metric,
        count: Number(r.cnt) || 0,
        crit: Number(r.crit) || 0,
        lastAt: r.last_at,
      });
    }

    const bySeverity = { CRIT: 0, WARN: 0, INFO: 0 };
    let total = 0;
    let acked = 0;
    for (const r of sevRows) {
      const c = Number(r.cnt) || 0;
      total += c;
      acked += Number(r.acked) || 0;
      if (r.severity in bySeverity) bySeverity[r.severity] = c;
    }

    return {
      total,
      acked,
      unacked: total - acked,
      bySeverity,
      byMetric: metricRows.map((r) => ({
        metric: r.metric,
        count: Number(r.cnt) || 0,
        avgDeviation: r.avg_dev == null ? null : Number(r.avg_dev),
        maxDeviation: r.max_dev == null ? null : Number(r.max_dev),
      })),
      byHost: hostRows.map((r) => ({
        hostId: r.host_id,
        count: Number(r.cnt) || 0,
        crit: Number(r.crit) || 0,
        warn: Number(r.warn) || 0,
        info: Number(r.info) || 0,
        acked: Number(r.acked) || 0,
        open: Number(r.open_total) || 0,
        openCrit: Number(r.open_crit) || 0,
        openWarn: Number(r.open_warn) || 0,
        openInfo: Number(r.open_info) || 0,
        avgDeviation: r.avg_dev == null ? null : Number(r.avg_dev),
        maxDeviation: r.max_dev == null ? null : Number(r.max_dev),
        lastAt: r.last_at,
        // Busiest metric first — already ordered by the query.
        topMetrics: metricsByHost.get(String(r.host_id)) || [],
      })),
    };
  }

  // Lists the findings linked to an event case, oldest-first (chronological),
  // for the event detail view + timeline read-model. Bounded like list().
  async listByEventCase(eventCaseId) {
    const [rows] = await this.pool.query(
      `SELECT ${COLUMNS} FROM findings WHERE event_case_id = ? ORDER BY created_at ASC, id LIMIT ?`,
      [eventCaseId, MAX_LIST]
    );
    return rows.map(mapRow);
  }

  // The findings of SEVERAL event cases in one read — the Troubleshooting
  // THE RED BAR'S QUERY — open attack-indication findings, newest and worst
  // first (src/analysis/attackIndication.js says which metrics those are).
  //
  // A separate method rather than a filter on list(): the membership test is
  // "metric IN (…) OR metric LIKE 'security.%'", which buildFilter's single
  // `metric = ?` cannot express, and inventing an array/prefix filter there
  // would change a code path every other screen depends on for one caller.
  //
  // `acked = 0` is the leading column (idx_findings_open, migration 114), so
  // this reads the open findings and not the year of accepted ones — the bar is
  // polled by every open dashboard, and a query that scanned the table would be
  // the most expensive thing on the server.
  //
  // ACKNOWLEDGING IS HOW THE BAR CLEARS. Not a dismiss button of its own: the
  // finding is the record, accepting it is the existing act of saying "seen",
  // and a bar with a private dismissal would let somebody clear the warning
  // without leaving a trace that they had.
  async attackIndication({
    metrics = [], prefixes = [], severities = [], since = null, limit = 5,
    // Severities that reach the bar on their own. Everything else needs a
    // second detector to agree — see CORROBORATION below.
    corroborationExempt = CORROBORATION_EXEMPT_SEVERITIES,
  } = {}) {
    const exact = [...new Set((Array.isArray(metrics) ? metrics : []).filter((m) => typeof m === 'string' && m))];
    const pre = [...new Set((Array.isArray(prefixes) ? prefixes : []).filter((p) => typeof p === 'string' && p))];
    const sev = (Array.isArray(severities) ? severities : []).filter((x) => SEVERITIES_SET.has(x));
    const exemptSev = [...new Set((Array.isArray(corroborationExempt) ? corroborationExempt : [])
      .filter((x) => SEVERITIES_SET.has(x)))];
    // No membership test means every finding matches, which is the opposite of
    // what this is for. An empty answer is the honest one.
    if (!exact.length && !pre.length) return { count: 0, bySeverity: {}, worst: null, findings: [] };

    const member = [];
    const memberParams = [];
    if (exact.length) { member.push('metric IN (?)'); memberParams.push(exact); }
    for (const p of pre) { member.push('metric LIKE ?'); memberParams.push(`${p}%`); }

    const sinceDate = since ? (since instanceof Date ? since : new Date(since)) : null;
    const where = ['f.acked = 0', `(${member.map((m) => `f.${m}`).join(' OR ')})`];
    const params = [...memberParams];
    if (sev.length) { where.push('f.severity IN (?)'); params.push(sev); }
    if (sinceDate) { where.push('f.created_at >= ?'); params.push(sinceDate); }

    // CORROBORATION (src/analysis/attackIndication.js says why). Anything not
    // exempt by severity needs a second, OPEN attack-indication finding from a
    // DIFFERENT detector in the same event case and the same window before it
    // lights the bar. A finding the correlator has not placed in a case yet has
    // nothing to agree with it, so it waits — the Changes feed and Analysis
    // already carry it.
    const exists = [`c.event_case_id = f.event_case_id`, 'c.acked = 0', 'c.id <> f.id', 'c.metric <> f.metric'];
    const existsParams = [];
    exists.push(`(${member.map((m) => `c.${m}`).join(' OR ')})`);
    existsParams.push(...memberParams);
    if (sinceDate) { exists.push('c.created_at >= ?'); existsParams.push(sinceDate); }
    const corroborated = `(f.event_case_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM findings c WHERE ${exists.join(' AND ')}
    ))`;
    // An EMPTY exemption list means every severity needs corroboration — not
    // that the rule is off. Skipping the clause when nothing was exempt is how
    // "nothing is exempt" came to mean "everything passes", which is the
    // opposite rule and the one the bar would have shipped with.
    if (exemptSev.length) {
      where.push(`(f.severity IN (?) OR ${corroborated})`);
      params.push(exemptSev, ...existsParams);
    } else {
      where.push(corroborated);
      params.push(...existsParams);
    }

    const clause = `WHERE ${where.join(' AND ')}`;
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 5;

    const [counts] = await this.pool.query(
      `SELECT f.severity AS severity, COUNT(*) AS cnt FROM findings f ${clause} GROUP BY f.severity`,
      params,
    );
    const bySeverity = {};
    let count = 0;
    for (const r of counts) {
      const c = Number(r.cnt) || 0;
      bySeverity[r.severity] = c;
      count += c;
    }
    if (!count) return { count: 0, bySeverity: {}, worst: null, findings: [] };

    // The same set, grouped by what a PATTERN matches on (metric, kind, agent)
    // plus severity, so the caller can map each group onto the operator's
    // patterns and their ATT&CK tactics without a query per pattern. One
    // GROUP BY over a set that is already small — open, corroborated,
    // attack-indication findings inside the window — rather than N counts.
    //
    // Bounded like every list here: an estate with more than this many distinct
    // groups lit at once has a bigger problem than a truncated strip.
    const [groupRows] = await this.pool.query(
      `SELECT f.metric AS metric, f.kind AS kind, f.host_id AS host_id, f.severity AS severity,
              COUNT(*) AS cnt
         FROM findings f ${clause}
        GROUP BY f.metric, f.kind, f.host_id, f.severity
        LIMIT 500`,
      params,
    );
    const groups = groupRows.map((r) => ({
      metric: r.metric, kind: r.kind, host_id: r.host_id, severity: r.severity, count: Number(r.cnt) || 0,
    }));

    // Worst first, then newest: the bar names one finding, and on a morning
    // with a scan and a beacon it should be the scan.
    const [rows] = await this.pool.query(
      `SELECT ${LIGHT_COLUMNS.split(', ').map((c) => `f.${c}`).join(', ')}, f.explanation FROM findings f ${clause}
       ORDER BY f.severity = 'CRIT' DESC, f.created_at DESC, f.id LIMIT ?`,
      [...params, n],
    );
    const findings = rows.map((r) => ({
      ...mapLightRow(r),
      // What the bar says, and what the finding says, are two different lengths.
      // `summary` is whole sentences inside the strip's two lines; `explanation`
      // is the detector's full text, which the event page the bar links to
      // shows in full. Cutting the long one mid-word was the old behaviour and
      // it put "…add it to" on screen with the rest nowhere.
      summary: summarize(r.explanation),
      explanation: typeof r.explanation === 'string' ? r.explanation : null,
    }));
    return {
      count,
      bySeverity,
      worst: bySeverity.CRIT ? 'CRIT' : (bySeverity.WARN ? 'WARN' : 'INFO'),
      findings,
      groups,
    };
  }

  // overview's case path (a single-host fault never forms a cross-agent
  // cluster, so its open event cases are what the screen rolls up). One
  // `event_case_id IN (...)` statement rather than listByEventCase per case,
  // oldest first (the order the event page shows them), bounded by `limit`
  // like every list here. `light: true` is the narrow projection listByIds
  // uses; the case path only counts and places the members.
  async listByEventCases(eventCaseIds, { light = false, limit = MAX_LIST } = {}) {
    const ids = [...new Set((Array.isArray(eventCaseIds) ? eventCaseIds : [])
      .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return [];
    const n = Number.isInteger(limit) && limit > 0 ? limit : MAX_LIST;
    const [rows] = await this.pool.query(
      `SELECT ${light ? LIGHT_COLUMNS : COLUMNS} FROM findings
        WHERE event_case_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY created_at ASC, id LIMIT ?`,
      [...ids, n]
    );
    return rows.map(light ? mapLightRow : mapRow);
  }

  // Bulk fetch by id — the N+1 killer for callers that already hold a list of
  // finding ids (cluster member hydration is the big one: a fleet with 100 live
  // clusters holds tens of thousands of member ids, and one round trip each is
  // what makes the Troubleshooting screen take half a minute to paint).
  //
  // Reads in ID_CHUNK-sized IN (...) batches and returns the rows in the order
  // of `ids`. An id with no row is simply absent from the result, exactly as the
  // per-id path dropped it — retention may have purged the finding.
  //
  // `light: true` selects LIGHT_COLUMNS: id/host/metric/severity/kind/acked/
  // created_at, no evidence or correlation JSON. That is everything a
  // severity/host/metric rollup needs; callers that render a finding (with its
  // explanation and evidence) must ask for the full row.
  async listByIds(ids, { light = false } = {}) {
    const wanted = [];
    const seen = new Set();
    for (const id of Array.isArray(ids) ? ids : []) {
      if (id === null || id === undefined || id === '') continue;
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      wanted.push(id);
    }
    if (!wanted.length) return [];

    const columns = light ? LIGHT_COLUMNS : COLUMNS;
    const map = light ? mapLightRow : mapRow;
    const byId = new Map();
    for (let i = 0; i < wanted.length; i += ID_CHUNK) {
      const chunk = wanted.slice(i, i + ID_CHUNK);
      const [rows] = await this.pool.query(
        `SELECT ${columns} FROM findings WHERE id IN (${chunk.map(() => '?').join(', ')})`,
        chunk
      );
      for (const row of rows) byId.set(String(row.id), map(row));
    }
    return wanted.map((id) => byId.get(String(id))).filter(Boolean);
  }

  // Fetches one finding by id, or null.
  async get(id) {
    const [rows] = await this.pool.query(`SELECT ${COLUMNS} FROM findings WHERE id = ?`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  // Marks a finding acknowledged. Returns true if a row was updated, false if
  // no finding has that id.
  async ack(id) {
    const [result] = await this.pool.query('UPDATE findings SET acked = 1 WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  // "I have seen these and I accept them" — for a SET of findings, or for
  // everything matching a filter.
  //
  // One at a time is not an option at the scale this reaches. A fleet that
  // produced 184 668 findings needs to clear them in one action, and 184 668
  // round trips is not that action.
  //
  // Two shapes, deliberately:
  //   ackMany({ ids })      the rows somebody ticked on screen
  //   ackMany({ filter })   everything matching what they are LOOKING at, which
  //                         is the only way to accept a backlog nobody will
  //                         scroll through
  //
  // Already-acked rows are not counted: `acked = 0` in the WHERE means the
  // number that comes back is what THIS call changed, so "accepted 40 000" is
  // true rather than a restatement of how many matched.
  // See trendQuery above. `limit` bounds the answer even when the filters do
  // not — a chart cannot draw more points than it has pixels, and an unbounded
  // GROUP BY over the whole table is the read this feature must never become.
  async trend({ bucket = 'day', limit = 400, ...filters } = {}) {
    return trendQuery(this.pool, { bucket, filters, limit: Math.min(Math.max(Number(limit) || 400, 1), 2000) });
  }

  async ackMany({ ids = null, filter = null } = {}) {
    if (Array.isArray(ids)) {
      if (!ids.length) return 0;
      const placeholders = ids.map(() => '?').join(', ');
      const [result] = await this.pool.query(
        `UPDATE findings SET acked = 1 WHERE acked = 0 AND id IN (${placeholders})`,
        ids,
      );
      return Number(result.affectedRows || 0);
    }

    // The filter form reuses the SAME predicates the list and summary reads
    // build, so "accept everything I can see" accepts exactly what was on
    // screen — not a wider set that happened to be easier to write.
    const { where, params } = buildFilter(filter || {});
    const [result] = await this.pool.query(
      `UPDATE findings SET acked = 1 WHERE acked = 0${where.length ? ` AND ${where.join(' AND ')}` : ''}`,
      params,
    );
    return Number(result.affectedRows || 0);
  }

  // Every open finding that belongs to one event case, accepted in one write.
  //
  // This is what closes the loop between an event case and THE RED BAR. The
  // bar counts open attack-indication findings (see attackIndication above),
  // and acknowledging is how it clears — but an operator working the event
  // screen resolves the CASE, which used to leave its findings open and the
  // bar lit with no control anywhere on that screen to put it out. Concluding
  // the case is the operator saying "seen", so the findings it was built from
  // are accepted with it.
  //
  // `acked = 0` in the WHERE means the count is what this call changed, and it
  // makes a second close (or a reopen and re-close) a no-op rather than a
  // rewrite. Re-opening deliberately does NOT un-acknowledge: the rows were
  // seen, and un-seeing them is not a thing an operator can do.
  async ackByEventCase(eventCaseId) {
    const id = Number(eventCaseId);
    if (!Number.isInteger(id) || id <= 0) return 0;
    const [result] = await this.pool.query(
      'UPDATE findings SET acked = 1 WHERE acked = 0 AND event_case_id = ?',
      [id],
    );
    return Number(result.affectedRows || 0);
  }

  // The same thing for a bulk transition that moved rows by FILTER rather than
  // by id: updateStatusWhere reports a count, not which cases it touched, so
  // the set is described the only way it can be — every open finding whose
  // case has concluded. Idempotent, so running it after a bulk action that
  // moved nothing costs one indexed UPDATE and changes no rows.
  async ackConcludedEventCases() {
    const [result] = await this.pool.query(
      `UPDATE findings f
         JOIN event_cases e ON e.id = f.event_case_id
          SET f.acked = 1
        WHERE f.acked = 0 AND e.status IN ('resolved', 'closed')`,
    );
    return Number(result.affectedRows || 0);
  }

  // Persists the correlation links for a finding (the ids of the other findings
  // the correlator grouped it with). Stored as JSON. Returns true if a row was
  // updated, false if no finding has that id.
  async setCorrelations(id, correlatedIds) {
    const ids = Array.isArray(correlatedIds) ? correlatedIds : [];
    const [result] = await this.pool.query(
      'UPDATE findings SET correlated_with = ? WHERE id = ?',
      [JSON.stringify(ids), id]
    );
    return result.affectedRows > 0;
  }

  // Links a finding to an event case (migration 048). Passing null unlinks it.
  // Returns true if a row was updated, false if no finding has that id.
  async setEventCase(id, eventCaseId) {
    const [result] = await this.pool.query(
      'UPDATE findings SET event_case_id = ? WHERE id = ?',
      [eventCaseId ?? null, id]
    );
    return result.affectedRows > 0;
  }
}

module.exports = { FindingStore, ID_CHUNK };
