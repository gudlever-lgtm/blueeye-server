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

const { groupAlerts } = require('../alerts/grouping');

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
  // Severity rules — "cert_expiring is an INFO for us". A PORT, not an import:
  // nothing under src/serviceTests/ may reach into its host (ports.js), and the
  // matcher lives on the host side so there is exactly one implementation of the
  // rules rather than a copy that drifts. Shape: { decide(event) -> decision }.
  // Optional — without it every incident keeps the severity policy.js judged.
  severityRules = null,
  // What a service is known to depend on, for grouping. Optional and injected:
  // computing it needs the service map, which is expensive, and without it
  // grouping still works on the host-level and same-layer links.
  // Shape: (applicationId) => Promise<{ failing: [...] }>.
  dependenciesFor = null,
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

  // While a sweep is running this is an array; outside one it is null.
  //
  // A sweep can open five incidents for one cause, and sending five alerts about
  // it is what teaches whoever is carrying the phone to stop reading them. So a
  // sweep COLLECTS what it would have sent and groups it at the end. Outside a
  // sweep — a single apply(), which is how the specs drive this — nothing is
  // deferred and the behaviour is exactly what it was.
  let batch = null;

  async function send(incident, { recovered = false } = {}) {
    if (typeof notify !== 'function') return false;
    const cfg = await config();
    if (cfg.notify === false) return false;
    // A recovery is per-subject news and is never grouped: "this is working
    // again" is about one thing, and folding three recoveries into one message
    // would leave two services that nobody was told had come back.
    if (batch && !recovered && cfg.groupAlerts !== false) {
      batch.push(incident);
      // Deliberately false: it has NOT been sent, so the caller must not stamp
      // it as notified. The flush does that, after it actually goes out.
      return false;
    }
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

  // The severity this incident should be stored with. Never throws: a rule set
  // that cannot be read leaves policy.js's own judgement in place, which is the
  // safe direction — the alternative is losing the downgrade AND the incident.
  async function decideSeverity(event) {
    const asDetected = { severity: event.severity, original_severity: null, severity_rule_id: null };
    if (!severityRules || typeof severityRules.decide !== 'function') return asDetected;
    try {
      const decision = await severityRules.decide(event);
      return decision && decision.severity ? decision : asDetected;
    } catch {
      return asDetected;
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
    // The operator's own judgement, applied before the incident is stored — the
    // same chokepoint rule as findings, for the same two reasons: alerting reads
    // the stored severity, and history must say what was decided AT THE TIME.
    const decision = await decideSeverity({
      source: 'service_assurance',
      severity: reaction.severity,
      kind: reaction.kind,
      application_id: applicationId,
    });

    if (!existing) {
      const opened = await incidents.open({
        application_id: applicationId,
        environment_id: environmentId,
        test_id: testId,
        subject_type: subjectType,
        subject_key: subjectKey,
        subject_label: subjectLabel,
        kind: reaction.kind,
        severity: decision.severity,
        original_severity: decision.original_severity,
        severity_rule_id: decision.severity_rule_id,
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
      severity: decision.severity,
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
  // One alert per PROBLEM, not per incident.
  //
  // Everything the sweep would have sent, grouped by what observably links it,
  // and one message per group. Every incident in a group is named in that
  // message — the point is one page instead of five, never four problems nobody
  // was told about.
  async function flush(pending, at) {
    if (!pending.length) return { alerts: 0, folded: 0 };

    let dependencies = null;
    if (typeof dependenciesFor === 'function') {
      const applicationId = pending.map((i) => i.application_id).find((id) => id != null) ?? null;
      // A dependency lookup that fails costs the strongest grouping link, never
      // the alert. Ungrouped and sent beats grouped and lost.
      try { dependencies = applicationId === null ? null : await dependenciesFor(applicationId); } catch { dependencies = null; }
    }

    const grouped = groupAlerts({ incidents: pending, dependencies, now: at });
    for (const group of grouped.groups) {
      // eslint-disable-next-line no-await-in-loop
      const sent = await deliverGroup(group);
      if (!sent) continue;
      for (const member of group.incidents) {
        // eslint-disable-next-line no-await-in-loop
        await incidents.markNotified(member.id, group.severity, at)
          .catch((err) => logger.warn(`service-assurance: could not stamp incident ${member.id} as notified (${err && err.message})`));
      }
    }
    if (grouped.folded) {
      logger.info(`service-assurance: ${grouped.would_have_been} incidents sent as ${grouped.alerts} alert(s)`);
    }
    return { alerts: grouped.alerts, folded: grouped.folded };
  }

  // One group, as a finding the existing channels already know how to render.
  async function deliverGroup(group) {
    if (typeof notify !== 'function') return false;
    const primary = group.primary;
    const finding = findingFor(primary);
    if (group.symptoms.length) {
      finding.explanation = `${group.summary}\n\n${finding.explanation}`.trim();
      // Rule 2, in the message itself: everything folded in is listed, so
      // nothing disappears into a group.
      finding.evidence = [
        ...(finding.evidence || []),
        ...group.symptoms.map((s) => `Also failing: ${s.subject_label || s.subject_key} — ${s.summary || s.kind}`),
      ];
      finding.severity = group.severity;
    }
    try {
      await notify(finding, {
        source: 'service-assurance',
        incidentId: primary.id,
        subject: primary.subject_key,
        likelyCause: primary.likely_cause,
        // So a receiver can see this was several incidents, and which.
        group: {
          key: group.key,
          linked_by: group.linked_by,
          link_reason: group.link_reason,
          incident_ids: group.incidents.map((i) => i.id),
        },
      });
      return true;
    } catch (err) {
      // A channel that will not send must never stop the sweep: the incidents
      // are already durable and unnotified, so the next sweep tries again. This
      // is the spec's rule — a failing notification system must never hide the
      // incident.
      logger.warn(`service-assurance: notify failed for ${group.key} (${err && err.message})`);
      return false;
    }
  }

  async function sweep() {
    const cfg = await config();
    if (cfg.enabled === false) return { skipped: 'disabled' };
    const at = now();
    // Opened here and closed in `finally`: a sweep that throws halfway must not
    // leave the batch open, or the next one would send this one's alerts too.
    batch = [];
    let certs;
    let testResults;
    let alerts = { alerts: 0, folded: 0 };
    try {
      certs = await sweepCertificates();
      testResults = await sweepTests();
    } finally {
      const pending = batch;
      batch = null;
      alerts = await flush(pending, at).catch((err) => {
        logger.warn(`service-assurance: could not send grouped alerts (${err && err.message})`);
        return { alerts: 0, folded: 0 };
      });
    }
    if (cfg.incidentRetentionDays) {
      await incidents.purgeResolvedOlderThan(cfg.incidentRetentionDays)
        .catch((err) => logger.warn(`service-assurance: incident purge failed (${err && err.message})`));
    }
    return { certificates: certs, tests: testResults, alerts };
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
