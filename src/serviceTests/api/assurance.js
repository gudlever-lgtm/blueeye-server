'use strict';

const express = require('express');
const { asyncHandler, notFound, invalidId, invalid, auditor, userId, parseId } = require('./helpers');
const { validateStatsQuery } = require('../validation');
const { resolvePeriod } = require('../stats/period');
const { STATUS, ACTIVE, TRANSITIONS, referenceFor, assessImpact, durationOf } = require('../incidents/lifecycle');

// The reaction layer's HTTP surface: what is currently wrong, and what every
// certificate looks like.
//
// Reads are viewer+ — "is anything on fire?" is the question the dashboard opens
// with, and hiding it behind a role helps nobody. Writes are operator+: resolving
// an incident by hand and forcing a certificate re-check both change state, and
// a forced re-check reaches out to the network.
function createAssuranceRouter({ repositories, reactor = null, audit, requireRole, roles, logger = null, now = () => new Date() }) {
  const router = express.Router();
  const { incidents, certificates, applications } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const write = requireRole(roles.OPERATOR, roles.ADMIN);
  const record = auditor(audit);

  // Every state migration 090 defined, not the two V2 had. A filter that only
  // knows open and resolved cannot show an operator the incident they picked up.
  const STATUSES = Object.keys(TRANSITIONS);
  const SEVERITIES = ['INFO', 'WARN', 'CRIT'];
  const SUBJECTS = ['test', 'certificate'];
  const CERT_STATUSES = ['ok', 'expiring', 'expired', 'invalid', 'unreachable'];

  // Optional filter that must be one of a fixed set. Returns `undefined` when the
  // caller sent something outside it, so the route answers 400 rather than
  // silently returning an unfiltered list.
  function pick(raw, allowed) {
    if (raw === undefined || raw === '') return null;
    const value = String(raw);
    return allowed.includes(value) ? value : undefined;
  }

  // ------------------------------------------------------------- incidents
  router.get('/incidents', read, asyncHandler(async (req, res) => {
    const status = pick(req.query.status, STATUSES);
    if (status === undefined) return res.status(400).json({ error: 'Invalid status' });
    const severity = pick(req.query.severity, SEVERITIES);
    if (severity === undefined) return res.status(400).json({ error: 'Invalid severity' });
    const subjectType = pick(req.query.subject_type, SUBJECTS);
    if (subjectType === undefined) return res.status(400).json({ error: 'Invalid subject_type' });

    let applicationId = null;
    if (req.query.application_id !== undefined && req.query.application_id !== '') {
      applicationId = parseId(req.query.application_id);
      if (applicationId === null) return res.status(400).json({ error: 'Invalid application_id' });
    }
    let limit = null;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      limit = parseId(req.query.limit);
      if (limit === null) return res.status(400).json({ error: 'Invalid limit' });
    }
    return res.json(await incidents.list({ status, severity, subjectType, applicationId, limit: limit || 100 }));
  }));

  // The one number the nav badge needs. Separate from the list so the dashboard
  // can poll it cheaply without pulling every open incident.
  router.get('/summary', read, asyncHandler(async (req, res) => {
    const counts = await incidents.openCounts();
    const certs = await certificates.list({ limit: 1000 });
    const expiring = certs.filter((c) => c.status === 'expiring').length;
    const broken = certs.filter((c) => c.status === 'expired' || c.status === 'invalid' || c.status === 'unreachable').length;
    return res.json({
      open: counts,
      certificates: { total: certs.length, expiring, broken },
      soonest_expiry: certs.find((c) => c.valid_to) || null,
    });
  }));

  router.get('/incidents/:id', read, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const incident = await incidents.findById(id);
    if (!incident) return notFound(res, 'Incident not found');

    // The timeline, built from actual events — never a narrative written after
    // the fact. Empty is a real answer for an incident opened before this
    // shipped, and it says so rather than inventing entries from the row.
    const timeline = typeof incidents.timeline === 'function'
      ? await incidents.timeline(incident.id).catch(() => [])
      : [];

    return res.json({
      ...incident,
      // INC-2026-00042. Derived from the id rather than counted, so there is no
      // counter to get out of step with the rows.
      reference: referenceFor(incident),
      timeline,
      duration: durationOf(incident, now()),
      // Technical failure, service impact and business impact are three
      // different things. This is the middle one, and where the number of
      // affected users is not known it says Unknown rather than inventing it.
      impact: assessImpact(incident),
      // Which moves this incident can make from where it is, so the screen
      // offers exactly those rather than guessing and being refused.
      can_move_to: TRANSITIONS[incident.status] || [],
    });
  }));

  // Move an incident through its lifecycle: open → investigating → identified →
  // resolved → closed, with the backward paths the pure module allows.
  //
  // The transition is conditional on the status the caller was shown, inside the
  // repository, so two people in two browsers cannot silently undo each other.
  // A refusal is a 409 with a sentence, not a 500.
  router.post('/incidents/:id/status', write, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const to = String((req.body && req.body.status) || '');
    if (!STATUSES.includes(to)) {
      return invalid(res, { status: `status must be one of ${STATUSES.join(', ')}` });
    }
    if (typeof incidents.transition !== 'function') {
      return res.status(404).json({ error: 'This deployment cannot move incidents yet' });
    }

    const note = req.body && req.body.note ? String(req.body.note).slice(0, 255) : null;
    const outcome = await incidents.transition(id, to, { by: userId(req), note });
    if (!outcome.incident) return notFound(res, 'Incident not found');
    if (!outcome.ok) return res.status(409).json({ error: outcome.reason, incident: outcome.incident });

    // The move is itself an event on the timeline. A person acknowledging an
    // incident and a sweep observing a recovery are both real, and the timeline
    // must not present one as the other — hence `source: 'person'`.
    if (typeof incidents.addEvent === 'function' && !outcome.unchanged) {
      await incidents.addEvent(id, {
        kind: `status_${to}`,
        summary: note || `Moved to ${to}`,
        source: 'person',
        actor_id: userId(req),
        occurred_at: now(),
      }).catch((err) => {
        // A timeline entry that cannot be written must not undo a state change
        // that already happened.
        if (logger && logger.warn) logger.warn(`service-assurance: could not record the move of incident ${id} (${err && err.message})`);
      });
    }
    record(req, 'assurance_incident_status', id, `${outcome.incident.subject_key} → ${to}`);
    return res.json(outcome.incident);
  }));

  // Manual resolve — "I fixed it, stop telling me". The reactor will re-open the
  // incident on the next sweep if the condition still holds, which is the honest
  // behaviour: closing a ticket does not renew a certificate.
  router.post('/incidents/:id/resolve', write, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const incident = await incidents.findById(id);
    if (!incident) return notFound(res, 'Incident not found');
    // The ACTIVE set, not `open`. Migration 090 added investigating and
    // identified, and an incident somebody had PICKED UP could no longer be
    // resolved — the one thing they were most likely to want to do next.
    if (!ACTIVE.includes(incident.status)) {
      return res.status(400).json({ error: `That incident is already ${incident.status}` });
    }
    const note = String((req.body && req.body.resolution) || 'Resolved by an operator').slice(0, 255);
    const resolved = await incidents.resolve(id, { resolution: note, resolvedBy: userId(req) });
    record(req, 'assurance_incident_resolve', id, incident.subject_key);
    return res.json(resolved);
  }));

  // Which applications gave us the most trouble, over a chosen period.
  //
  //   ?period=day|week|month|year   default MONTH — the Health page's question
  //                                 is "how has this month been", not "today"
  //   &at=YYYY-MM-DD                any date inside the wanted period
  //   &tz_offset=-120               the viewer's getTimezoneOffset()
  //   &severity=CRIT                default CRIT
  //   &application_ids=1,2,3        narrow to a chosen few; omitted = all
  //   &limit=10                     default 10
  //
  // Shares resolvePeriod() with GET /stats, so "last month" means one thing in
  // this install and the dashboard's ◀ ▶ buttons never do calendar arithmetic.
  router.get('/top-applications', read, asyncHandler(async (req, res) => {
    const { value, errors } = validateStatsQuery(req.query);
    if (errors) return invalid(res, errors);

    const severity = pick(req.query.severity, SEVERITIES);
    if (severity === undefined) return res.status(400).json({ error: 'Invalid severity' });

    let limit = 10;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      const parsed = parseId(req.query.limit);
      if (parsed === null || parsed > 50) return res.status(400).json({ error: 'Invalid limit' });
      limit = parsed;
    }

    // A comma-separated selection from the multi-select. One bad id fails the
    // whole request rather than being quietly dropped: a chart that silently
    // ignores half your filter is worse than an error.
    let applicationIds = null;
    if (req.query.application_ids !== undefined) {
      const raw = String(req.query.application_ids);
      applicationIds = raw === '' ? [] : raw.split(',').map((part) => parseId(part.trim()));
      if (applicationIds.some((id) => id === null)) return res.status(400).json({ error: 'Invalid application_ids' });
    }

    const period = resolvePeriod({
      period: value.period || 'month',
      at: value.at,
      offsetMinutes: value.tz_offset,
      now: now(),
    });

    const applications_ranked = await incidents.countByApplication({
      from: period.from, to: period.to, severity: severity || 'CRIT', applicationIds, limit,
    });

    // One line per application, over the period's buckets.
    //
    // WHICH applications get a line: the ones the operator selected, or — when
    // they have selected none — the top `limit` by incident count. So the chart
    // always opens on the services that had the worst period, and the picker is
    // how you ask about a specific one.
    const chosen = Array.isArray(applicationIds) && applicationIds.length
      ? applicationIds
      : applications_ranked.map((r) => r.application_id);

    const points = chosen.length
      ? await incidents.seriesByApplication({
        from: period.from,
        to: period.to,
        sqlFormat: period.sql_format,
        bucket: period.bucket,
        offsetMinutes: period.offset_minutes,
        severity: severity || 'CRIT',
        applicationIds: chosen,
      })
      : [];

    // Every bucket in the period, zeroes included. A line that skips its empty
    // buckets is a line that lies about when the trouble was: "it was quiet all
    // week and then Thursday happened" only exists if Monday to Wednesday are
    // in the answer as zeroes.
    const byApp = new Map();
    for (const p of points) {
      const row = byApp.get(p.application_id)
        || { application_id: p.application_id, application_name: p.application_name, counts: new Map() };
      row.counts.set(p.bucket, p.incidents);
      byApp.set(p.application_id, row);
    }
    // Ordered by the ranking, so slot 1 of the palette is the worst offender
    // rather than whichever application happens to sort first.
    const order = new Map(applications_ranked.map((r, i) => [r.application_id, i]));
    const series = [...byApp.values()]
      .sort((a, b) => (order.has(a.application_id) ? order.get(a.application_id) : 1e9)
        - (order.has(b.application_id) ? order.get(b.application_id) : 1e9))
      .map((row) => ({
        application_id: row.application_id,
        application_name: row.application_name,
        total: [...row.counts.values()].reduce((acc, n) => acc + n, 0),
        points: period.buckets.map((b) => row.counts.get(b.key) || 0),
      }));

    return res.json({
      bucket: period.bucket,
      buckets: period.buckets.map((b) => ({ start: b.start, key: b.key })),
      series,
      period: period.period,
      at: period.at,
      from: period.from,
      to: period.to,
      prev_at: period.prev_at,
      next_at: period.next_at,
      has_next: period.has_next,
      is_current: period.is_current,
      severity: severity || 'CRIT',
      limit,
      applications: applications_ranked,
      total: applications_ranked.reduce((acc, r) => acc + r.incidents, 0),
    });
  }));

  // ---------------------------------------------------------- certificates
  router.get('/certificates', read, asyncHandler(async (req, res) => {
    const status = pick(req.query.status, CERT_STATUSES);
    if (status === undefined) return res.status(400).json({ error: 'Invalid status' });
    let applicationId = null;
    if (req.query.application_id !== undefined && req.query.application_id !== '') {
      applicationId = parseId(req.query.application_id);
      if (applicationId === null) return res.status(400).json({ error: 'Invalid application_id' });
    }
    return res.json(await certificates.list({ status, applicationId }));
  }));

  // Force a re-check now, for one application or all of them. Bounded by the
  // same host rules as everything else: only addresses the module already knows
  // about are contacted, so this is a refresh button and not a scanner.
  router.post('/certificates/check', write, asyncHandler(async (req, res) => {
    if (!reactor) return res.status(503).json({ error: 'The assurance reactor is not running on this server' });
    let applicationId = null;
    if (req.body && req.body.application_id !== undefined && req.body.application_id !== null && req.body.application_id !== '') {
      applicationId = parseId(req.body.application_id);
      if (applicationId === null) return res.status(400).json({ error: 'Invalid application_id' });
      const app = await applications.findById(applicationId);
      if (!app) return notFound(res, 'Application not found');
    }
    try {
      const result = await reactor.sweepCertificates({ force: true, applicationId });
      record(req, 'assurance_certificate_check', applicationId || 'all', `checked=${result.checked}`);
      return res.json(result);
    } catch (err) {
      if (logger && logger.warn) logger.warn(`service-assurance: forced certificate check failed (${err && err.message})`);
      return res.status(502).json({ error: 'The certificate check could not be completed' });
    }
  }));

  return router;
}

module.exports = { createAssuranceRouter };
