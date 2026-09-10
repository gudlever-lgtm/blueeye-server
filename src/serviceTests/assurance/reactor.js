'use strict';

const { createCertificateChecker, targetsFrom, STATUS } = require('./certificates');
const {
  SEVERITY, rank, CERT_KIND, explain,
  certificateReaction, certificateSummary, runReaction, runSummary,
} = require('./policy');

// The reaction loop — what turns an observation into an incident and an incident
// into an alert.
//
// Before this existed, Service Assurance recorded and stopped. A scheduled test
// failed at 02:00 with "The TLS certificate is expired", the run row was written
// in plain language, and nobody read it until someone complained. The module knew
// and did nothing.
//
// The loop, every sweep:
//
//   1. certificates — re-read the TLS certificate on every registered https
//      address that is due, and judge it against the operator's warning window.
//      This is the PROACTIVE half: a certificate is a deadline, and a deadline
//      you are told about a month early never becomes an outage.
//   2. tests — count consecutive failing runs per test and judge the streak
//      against its classification. This is the REACTIVE half.
//   3. incidents — open, escalate, or resolve one durable row per subject.
//   4. notify — send on a state CHANGE only (opened, escalated, resolved), never
//      once per observation.
//
// It runs in the API process, not the browser worker: it needs no browser, and
// alerting configuration/licensing lives here. Nothing it does requires a worker
// to be connected — an install with no worker at all still gets its certificates
// watched, which is the cheapest useful thing this module can do.

const silentLogger = { info() {}, warn() {}, error() {} };

// Non-terminal statuses never count towards or against a failure streak: a
// queued run has no outcome yet and must not resolve an incident.
const TERMINAL = new Set(['pass', 'fail', 'error', 'warning', 'skipped']);

function createAssuranceReactor({
  repositories,
  settings,
  // Injected so the suite never opens a socket. Production leaves it unset.
  certificateChecker = null,
  // (finding, group) => Promise. Bound to the alerting dispatcher in server.js;
  // omitted (or unlicensed) simply means incidents are recorded and not sent.
  notify = null,
  logger = silentLogger,
  now = () => new Date(),
}) {
  const { applications, environments, tests, runs, certificates, incidents } = repositories;

  async function config() {
    const s = await settings.get('assurance');
    return s || {};
  }

  function checkerFor(cfg) {
    return certificateChecker || createCertificateChecker({ timeoutMs: cfg.certificateTimeoutMs, now });
  }

  // ------------------------------------------------------------- notifying
  // A finding shaped exactly like the ones analysis produces, so the existing
  // channels render it without knowing this module exists.
  function findingFor(incident, { recovered = false } = {}) {
    const severity = recovered ? SEVERITY.INFO : incident.severity;
    return {
      id: `service-assurance-${incident.id}`,
      hostId: incident.subject_label || incident.subject_key,
      metric: `service_assurance.${incident.subject_type}`,
      kind: incident.kind,
      severity,
      explanation: recovered
        ? `Recovered: ${incident.summary}`
        : `${incident.summary}\n\n${incident.explanation || ''}`.trim(),
      evidence: incident.evidence || [],
    };
  }

  async function send(incident, { recovered = false } = {}) {
    if (typeof notify !== 'function') return false;
    const cfg = await config();
    if (cfg.notify === false) return false;
    try {
      await notify(findingFor(incident, { recovered }), {
        source: 'service-assurance',
        incidentId: incident.id,
        subject: incident.subject_key,
        likelyCause: incident.likely_cause,
      });
      return true;
    } catch (err) {
      // A channel that will not send must never stop the sweep: the incident is
      // already durable, and the next sweep will try again.
      logger.warn(`service-assurance: notify failed for incident ${incident.id} (${err && err.message})`);
      return false;
    }
  }

  // ------------------------------------------------------------- incidents
  // The single place an observation becomes state. `reaction` is null when the
  // subject is healthy, which is how an incident gets resolved.
  async function apply({ subjectType, subjectKey, subjectLabel, applicationId = null, environmentId = null, testId = null, reaction, summary = null, evidence = [] }) {
    const at = now();
    const existing = await incidents.findOpen(subjectKey);

    if (!reaction) {
      if (!existing) return { changed: false, state: 'healthy' };
      const resolved = await incidents.resolve(existing.id, { resolution: 'The next check was healthy', at });
      if (await send(resolved, { recovered: true })) await incidents.markNotified(resolved.id, SEVERITY.INFO, at);
      logger.info(`service-assurance: ${subjectKey} recovered — incident ${resolved.id} resolved`);
      return { changed: true, state: 'resolved', incident: resolved };
    }

    const detail = explain(reaction.kind);
    if (!existing) {
      const opened = await incidents.open({
        application_id: applicationId,
        environment_id: environmentId,
        test_id: testId,
        subject_type: subjectType,
        subject_key: subjectKey,
        subject_label: subjectLabel,
        kind: reaction.kind,
        severity: reaction.severity,
        summary: summary || detail.summary,
        likely_cause: detail.cause,
        explanation: detail.detail,
        evidence,
        at,
      });
      if (await send(opened)) await incidents.markNotified(opened.id, opened.severity, at);
      logger.info(`service-assurance: ${subjectKey} — opened ${opened.severity} incident ${opened.id} (${opened.kind})`);
      return { changed: true, state: 'opened', incident: opened };
    }

    const touched = await incidents.touch(existing.id, {
      severity: reaction.severity,
      kind: reaction.kind,
      summary: summary || detail.summary,
      evidence,
      at,
    });
    // Notify again ONLY when it got worse than what was last sent. A service
    // that has been down for six hours has been reported; a service that just
    // went from "expiring" to "expired" has not.
    const escalated = rank(touched.severity) > rank(existing.notified_severity);
    if (escalated && await send(touched)) await incidents.markNotified(touched.id, touched.severity, at);
    return { changed: escalated, state: escalated ? 'escalated' : 'ongoing', incident: touched };
  }

  // ---------------------------------------------------------- certificates
  // The https addresses one application actually has: its own, plus every
  // enabled environment's. Deduped by host:port — two environments on one host
  // share one certificate.
  async function targetsForApplication(app) {
    const envs = await environments.list({ applicationId: app.id });
    return targetsFrom([
      { url: app.base_url, environmentId: null },
      ...envs.filter((e) => e.enabled !== false).map((e) => ({ url: e.base_url, environmentId: e.id })),
    ]);
  }

  // Checks one target, stores the result, and reacts to it.
  async function checkTarget(app, target, cfg) {
    const checker = checkerFor(cfg);
    const result = await checker.check(target, { warnDays: cfg.certificateWarnDays });
    const stored = await certificates.record(app.id, { ...result, environment_id: target.environmentId || null });
    const cert = stored || { ...result, application_id: app.id };
    const reaction = certificateReaction(cert, {
      warnDays: cfg.certificateWarnDays,
      criticalDays: cfg.certificateCriticalDays,
    });
    const evidence = [
      `Address: ${cert.url || `https://${cert.host}:${cert.port}`}`,
      cert.issuer ? `Issued by: ${cert.issuer}` : null,
      cert.valid_to ? `Expires: ${new Date(cert.valid_to).toISOString().slice(0, 10)}` : null,
      Number.isFinite(cert.days_remaining) ? `Days remaining: ${cert.days_remaining}` : null,
      cert.error_message ? `Reported: ${cert.error_message}` : null,
    ].filter(Boolean);

    const outcome = await apply({
      subjectType: 'certificate',
      // Scoped by application: two applications registered on the same host each
      // keep their own certificate row, so they keep their own incident — one
      // app's recovery must not resolve the other's.
      subjectKey: `certificate:${app.id}:${cert.host}:${cert.port}`,
      subjectLabel: `${app.name} — ${cert.host}`,
      applicationId: app.id,
      environmentId: target.environmentId || null,
      reaction,
      summary: reaction ? certificateSummary(cert, reaction.kind) : null,
      evidence,
    });
    return { certificate: cert, ...outcome };
  }

  // One pass over every enabled application. `force` ignores the check interval
  // — that is the "Check now" button, and nothing else uses it.
  async function sweepCertificates({ force = false, applicationId = null } = {}) {
    const cfg = await config();
    if (!force && cfg.watchCertificates === false) return { checked: 0, changed: 0, skipped: 'disabled' };
    const intervalMs = Math.max(1, Number(cfg.certificateCheckIntervalMinutes) || 360) * 60000;
    const apps = (await applications.list()).filter((a) => a.enabled !== false && (!applicationId || a.id === applicationId));

    let checked = 0;
    let changed = 0;
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      const targets = await targetsForApplication(app);
      // An application that moved off https, or whose environment was deleted,
      // must stop showing a certificate row it no longer has.
      // eslint-disable-next-line no-await-in-loop
      await certificates.pruneMissing(app.id, targets).catch(() => 0);
      for (const target of targets) {
        // eslint-disable-next-line no-await-in-loop
        const existing = await certificates.findByTarget(app.id, target.host, target.port);
        const due = force || !existing || !existing.checked_at
          || (now().getTime() - new Date(existing.checked_at).getTime()) >= intervalMs;
        if (!due) continue;
        checked += 1;
        try {
          // eslint-disable-next-line no-await-in-loop
          const outcome = await checkTarget(app, target, cfg);
          if (outcome.changed) changed += 1;
        } catch (err) {
          logger.warn(`service-assurance: certificate check failed for ${target.host}:${target.port} (${err && err.message})`);
        }
      }
    }
    return { checked, changed };
  }

  // ------------------------------------------------------------------ tests
  // Consecutive non-passing terminal runs at the head of the history. `warning`
  // and `skipped` neither extend nor break the streak: they are outcomes about
  // the test, not about the service.
  function streakOf(history) {
    const rows = (history && history.runs) || [];
    let streak = 0;
    let head = null;
    for (const row of rows) {
      if (!TERMINAL.has(row.status)) continue;
      if (row.status === 'pass') break;
      if (row.status === 'warning' || row.status === 'skipped') continue;
      if (!head) head = row;
      streak += 1;
    }
    return { streak, head };
  }

  async function sweepTests({ applicationId = null } = {}) {
    const cfg = await config();
    if (cfg.watchTests === false) return { evaluated: 0, changed: 0, skipped: 'disabled' };
    const all = await tests.list(applicationId ? { applicationId } : {});
    const watched = all.filter((t) => t.enabled !== false);

    let evaluated = 0;
    let changed = 0;
    for (const test of watched) {
      evaluated += 1;
      try {
        // Twice the streak threshold is enough history to both open and resolve;
        // reading more would cost a bigger scan for a decision that only looks at
        // the head of the list.
        // eslint-disable-next-line no-await-in-loop
        const history = await runs.history(test.id, Math.max(4, (Number(cfg.failureStreak) || 2) * 2));
        if (!history || !history.runs || !history.runs.length) continue;
        const { streak, head } = streakOf(history);
        const reaction = runReaction(
          { failureKind: head && (head.failure_kind || 'unknown'), streak },
          { failureStreak: cfg.failureStreak }
        );
        const evidence = [
          `Consecutive failures: ${streak}`,
          head && head.error_message ? `Last error: ${String(head.error_message).slice(0, 300)}` : null,
          head && head.id ? `Run #${head.id}` : null,
          history.success_rate !== null && history.success_rate !== undefined
            ? `Recent success rate: ${Math.round(history.success_rate * 100)}%`
            : null,
        ].filter(Boolean);

        // eslint-disable-next-line no-await-in-loop
        const outcome = await apply({
          subjectType: 'test',
          subjectKey: `test:${test.id}`,
          subjectLabel: test.name,
          applicationId: test.application_id,
          testId: test.id,
          reaction,
          summary: reaction
            ? runSummary({
              testName: test.name,
              failureKind: reaction.kind,
              streak,
              errorMessage: head && head.error_message,
            })
            : null,
          evidence,
        });
        if (outcome.changed) changed += 1;
      } catch (err) {
        logger.warn(`service-assurance: could not evaluate test ${test.id} (${err && err.message})`);
      }
    }
    return { evaluated, changed };
  }

  // ------------------------------------------------------------------ sweep
  async function sweep() {
    const cfg = await config();
    if (cfg.enabled === false) return { skipped: 'disabled' };
    const certs = await sweepCertificates();
    const testResults = await sweepTests();
    if (cfg.incidentRetentionDays) {
      await incidents.purgeResolvedOlderThan(cfg.incidentRetentionDays)
        .catch((err) => logger.warn(`service-assurance: incident purge failed (${err && err.message})`));
    }
    return { certificates: certs, tests: testResults };
  }

  return {
    sweep,
    sweepCertificates,
    sweepTests,
    checkTarget,
    targetsForApplication,
    streakOf,
    findingFor,
    STATUS,
    CERT_KIND,
  };
}

// The background job wrapper the host starts and stops, matching the uniform
// { start, stop } every other job in src/server.js uses. The interval is read
// from settings on each tick, so an operator changing the cadence does not need
// a restart — the NEXT tick uses the new value.
function createAssuranceJob({ reactor, settings, logger = silentLogger }) {
  let timer = null;
  let stopped = true;

  async function tick() {
    try {
      await reactor.sweep();
    } catch (err) {
      logger.error(`service-assurance: sweep failed (${err && err.message})`);
    }
    if (stopped) return;
    let intervalMs = 300000;
    try {
      const cfg = await settings.get('assurance');
      if (cfg && Number.isFinite(cfg.sweepIntervalMs)) intervalMs = cfg.sweepIntervalMs;
    } catch { /* the default cadence is a fine fallback */ }
    timer = setTimeout(tick, intervalMs);
    if (timer.unref) timer.unref();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      // A short first delay rather than an immediate sweep: boot is busy enough
      // without a TLS handshake per registered address.
      timer = setTimeout(tick, 15000);
      if (timer.unref) timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

module.exports = { createAssuranceReactor, createAssuranceJob };
