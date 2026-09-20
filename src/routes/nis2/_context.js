'use strict';

const { requireRole } = require('../../auth/middleware');
const { ROLES } = require('../../auth/roles');
const { requirePlanFeature } = require('../../license/features');
const { createT, resolveLocale } = require('../../nis2/i18n');

// Everything the NIS2 sub-routers share.
//
// nis2.js was one 607-line file with 40 routes across eight resources — risks,
// controls, incidents, evidence, reports, the audit trail, the report generator
// and nine export endpoints. Every one of them needed the same six helpers, so
// splitting the file meant either duplicating those helpers or passing them
// around. This is the "passing them around": built once in index.js, handed to
// each sub-router as `ctx`.
//
// Keeping them here rather than in index.js means index.js is purely a mounting
// table, which is what makes the split worth doing at all.
function createNis2Context({
  nis2RisksRepo, nis2ControlsRepo, nis2IncidentsRepo,
  nis2ReportsRepo, nis2EvidenceRepo, nis2AuditRepo,
  featureGate = null, planService = null,
  releaseKeyService = null,
}) {
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const writer = requireRole(ROLES.OPERATOR, ROLES.ADMIN);
  const approver = requireRole(ROLES.ADMIN); // admin/compliance approves reports

  // The generated/exportable "Compliance report pack" is licence-gated
  // (reports_compliance, Professional+). The risk/control/incident registers and
  // the readiness dashboard stay open as part of the NIS2 module; producing the
  // report artifacts (generate / approve / CSV / print-ready HTML) requires it.
  const compliancePack = requirePlanFeature({ featureGate, planService }, 'reports_compliance');

  // Best-effort audit write. Never throws into the request path.
  async function audit(req, action, entityType, entityId, oldValue, newValue) {
    if (!nis2AuditRepo) return;
    try {
      await nis2AuditRepo.record({
        userId: req.user && req.user.id, userEmail: req.user && req.user.email,
        action, entityType, entityId, oldValue, newValue,
      });
    } catch { /* audit is non-fatal */ }
  }

  // The language a report document is rendered in. `?locale=` wins (the
  // dashboard passes the user's chosen language); otherwise Accept-Language, so
  // a scripted export — the compliance pack is fetched by more than the UI —
  // gets a sensible document without having to know about the parameter.
  // Anything unrecognised resolves to English rather than failing the export.
  const localeOf = (req) => resolveLocale(
    (typeof req.query.locale === 'string' && req.query.locale) || req.get('accept-language') || ''
  );
  const orgOf = (req) => (typeof req.query.org === 'string' && req.query.org.trim()
    ? req.query.org.trim().slice(0, 120)
    : createT(localeOf(req))('doc.org'));

  // Query filters must be plain strings before they reach a `col = ?` binding:
  // Express parses ?x=a&x=b into an array (and ?x[y]=1 into an object), which
  // mysql2 expands into invalid/shifted SQL. Anything non-string → no filter.
  const qstr = (v) => (typeof v === 'string' && v ? v : null);
  const fail = (res, errors) => res.status(400).json({ error: 'Validation failed', details: errors });

  // Loads the three core record sets in parallel — the dashboard + reports basis.
  async function loadAll() {
    const [risks, controls, incidents] = await Promise.all([
      nis2RisksRepo.findAll(), nis2ControlsRepo.findAll(), nis2IncidentsRepo.findAll(),
    ]);
    return { risks, controls, incidents };
  }

  return {
    // repositories
    nis2RisksRepo, nis2ControlsRepo, nis2IncidentsRepo,
    nis2ReportsRepo, nis2EvidenceRepo, nis2AuditRepo,
    releaseKeyService,
    // role + licence middleware
    reader, writer, approver, compliancePack,
    // helpers
    audit, localeOf, orgOf, qstr, fail, loadAll,
  };
}

module.exports = { createNis2Context };
