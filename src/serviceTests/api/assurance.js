'use strict';

const express = require('express');
const { asyncHandler, notFound, invalidId, auditor, userId, parseId } = require('./helpers');

// The reaction layer's HTTP surface: what is currently wrong, and what every
// certificate looks like.
//
// Reads are viewer+ — "is anything on fire?" is the question the dashboard opens
// with, and hiding it behind a role helps nobody. Writes are operator+: resolving
// an incident by hand and forcing a certificate re-check both change state, and
// a forced re-check reaches out to the network.
function createAssuranceRouter({ repositories, reactor = null, audit, requireRole, roles, logger = null }) {
  const router = express.Router();
  const { incidents, certificates, applications } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const write = requireRole(roles.OPERATOR, roles.ADMIN);
  const record = auditor(audit);

  const STATUSES = ['open', 'resolved'];
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
    return incident ? res.json(incident) : notFound(res, 'Incident not found');
  }));

  // Manual resolve — "I fixed it, stop telling me". The reactor will re-open the
  // incident on the next sweep if the condition still holds, which is the honest
  // behaviour: closing a ticket does not renew a certificate.
  router.post('/incidents/:id/resolve', write, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const incident = await incidents.findById(id);
    if (!incident) return notFound(res, 'Incident not found');
    if (incident.status !== 'open') return res.status(400).json({ error: 'That incident is already resolved' });
    const note = String((req.body && req.body.resolution) || 'Resolved by an operator').slice(0, 255);
    const resolved = await incidents.resolve(id, { resolution: note, resolvedBy: userId(req) });
    record(req, 'assurance_incident_resolve', id, incident.subject_key);
    return res.json(resolved);
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
