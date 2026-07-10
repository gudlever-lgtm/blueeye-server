'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { canTransition, requiresComment, isStatus } = require('../incidentCases/stateMachine');
const { validateStatusPatch } = require('../validation/incidentCaseValidation');

const SEVERITIES = ['INFO', 'WARN', 'CRIT'];

function parseIncidentId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseDate(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// First-class incidents (incident_cases) wrapping analysis findings.
//   GET   /api/incidents        viewer+   list (filter status/severity/device/time)
//   GET   /api/incidents/:id    viewer+   one incident + its linked anomalies
//   PATCH /api/incidents/:id    operator+ status transition (audited, RBAC)
//
// Follows the existing RBAC pattern (viewer < operator < admin): reads are
// viewer+, status changes are operator/admin. Every transition is recorded in
// the hash-chained audit_log via the injected auditLogger.
function createIncidentsRouter({ incidentCasesRepo, findingStore, auditLogger = null }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const writer = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

  // GET /api/incidents — filterable list. viewer+.
  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    const { status, severity, device } = req.query;
    if (status && !isStatus(status)) {
      return res.status(400).json({ error: 'invalid status filter' });
    }
    if (severity && !SEVERITIES.includes(severity)) {
      return res.status(400).json({ error: 'invalid severity filter' });
    }
    const incidents = await incidentCasesRepo.list({
      status: status || null,
      severity: severity || null,
      hostId: device || null,
      from: parseDate(req.query.from),
      to: parseDate(req.query.to),
    });
    return res.json({ incidents });
  }));

  // GET /api/incidents/:id — one incident plus its linked anomalies. viewer+.
  router.get('/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseIncidentId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const incident = await incidentCasesRepo.findById(id);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    const anomalies = await findingStore.listByIncidentCase(id);
    // Playbook runs are not modelled in this codebase (no playbook subsystem);
    // the key is present for forward-compatibility and always empty for now.
    return res.json({ incident, anomalies, playbookRuns: [] });
  }));

  // PATCH /api/incidents/:id — status transition. operator/admin only.
  router.patch('/:id', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseIncidentId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    const { value, errors } = validateStatusPatch(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const existing = await incidentCasesRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Incident not found' });

    const from = existing.status;
    const to = value.status;
    if (!canTransition(from, to)) {
      return res.status(409).json({ error: `Illegal transition ${from} → ${to}` });
    }
    if (requiresComment(from, to) && !value.comment) {
      return res.status(400).json({ error: 'A comment is required to reopen an incident' });
    }

    const ok = await incidentCasesRepo.updateStatus(id, {
      from,
      to,
      closedBy: to === 'closed' ? (req.user && req.user.id) || null : null,
      at: to === 'resolved' ? new Date() : null,
    });
    if (!ok) {
      // The row's status changed between our read and write (or vanished).
      return res.status(409).json({ error: 'Incident status changed concurrently; please retry' });
    }

    if (auditLogger) {
      const detail = `${from}→${to}${value.comment ? `: ${value.comment}` : ''}`;
      await auditLogger.record(req, { category: 'incident', action: 'incident_status_change', target: String(id), detail });
    }

    const updated = await incidentCasesRepo.findById(id);
    return res.json({ incident: updated });
  }));

  return router;
}

module.exports = { createIncidentsRouter };
