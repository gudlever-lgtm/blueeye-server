'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateRule, describeDecision, applySeverity } = require('../events/severityRules');

// Severity rules — "this kind of event is a warning for us, not a critical".
//
//   GET    /api/severity-rules        viewer+   list
//   POST   /api/severity-rules        ADMIN     create
//   PUT    /api/severity-rules/:id    ADMIN     edit / enable / disable
//   DELETE /api/severity-rules/:id    ADMIN     delete
//   POST   /api/severity-rules/:id/apply-to-open   ADMIN   backfill open events
//
// ADMIN, not operator. A rule quietly changes what wakes people at 3am, across
// the whole estate and indefinitely — that is a different kind of act from
// resolving an event or building a test, and it belongs with the people who own
// the alerting configuration.
//
// Writing a rule does NOT touch events that already exist. Applying one
// backwards is the separate, explicit route at the end, which reports how many
// rows it changed. Bundling the two would mean every correction silently became
// policy, and every policy silently rewrote history.
function createSeverityRulesRouter({ severityRulesRepo, findingStore, serviceTestIncidentsRepo, auditLogger }) {
  const router = express.Router();
  const read = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const admin = requireRole(ROLES.ADMIN);

  const parseId = (raw) => {
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 && String(n) === String(raw).trim() ? n : null;
  };

  // A rule is shown with the sentence it will put on an event, so an admin sees
  // what they are about to make the dashboard say before they save it.
  const withPreview = (rule) => ({
    ...rule,
    effect: describeDecision({
      changed: true,
      original_severity: rule.severity === 'CRIT' ? 'WARN' : 'CRIT',
      severity: rule.severity,
      rule,
    }),
  });

  router.get('/', requireAuth, read, asyncHandler(async (req, res) => {
    if (req.query.source !== undefined
      && !['finding', 'service_assurance'].includes(String(req.query.source))) {
      return res.status(400).json({ error: 'Invalid source' });
    }
    const list = await severityRulesRepo.list({ source: req.query.source || null });
    return res.json(list.map(withPreview));
  }));

  router.get('/:id', requireAuth, read, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const rule = await severityRulesRepo.findById(id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    return res.json(withPreview(rule));
  }));

  router.post('/', requireAuth, admin, asyncHandler(async (req, res) => {
    const { value, errors } = validateRule(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const created = await severityRulesRepo.create({ ...value, created_by: (req.user && req.user.id) || null });
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'severity_rule',
        action: 'severity_rule_create',
        target: String(created.id),
        detail: `${created.source} → ${created.severity}: ${created.reason || ''}`.slice(0, 512),
      });
    }
    return res.status(201).json(withPreview(created));
  }));

  router.put('/:id', requireAuth, admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const existing = await severityRulesRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });

    // Validated as a WHOLE rule, against the existing one merged with the patch.
    // Validating the patch alone would let an edit remove the last match field
    // and turn a narrow rule into one that governs every event from its source.
    const { value, errors } = validateRule({ ...existing, ...req.body, source: existing.source });
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const saved = await severityRulesRepo.save(id, value);
    if (!saved) return res.status(404).json({ error: 'Rule not found' });
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'severity_rule',
        action: 'severity_rule_update',
        target: String(id),
        detail: `${existing.severity} → ${saved.severity}, enabled=${saved.enabled}`,
      });
    }
    return res.json(withPreview(saved));
  }));

  router.delete('/:id', requireAuth, admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const existing = await severityRulesRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });

    await severityRulesRepo.remove(id);
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'severity_rule',
        action: 'severity_rule_delete',
        target: String(id),
        detail: `${existing.source} → ${existing.severity}: ${existing.reason || ''}`.slice(0, 512),
      });
    }
    // Events already stored keep the severity they were stored with. Deleting
    // the rule does not un-decide what was decided — the provenance columns go
    // to NULL (the FK is ON DELETE SET NULL) and the severity stands.
    return res.status(204).end();
  }));

  // Apply a rule to events that already exist.
  //
  // Separate, explicit, and it reports what it did. `dry_run` (the default)
  // counts without changing anything, so an admin can see "this would change 412
  // open events" before it happens rather than afterwards.
  router.post('/:id/apply-to-open', requireAuth, admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const rule = await severityRulesRepo.findById(id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    const dryRun = !(req.body && req.body.confirm === true);
    const repo = rule.source === 'finding' ? findingStore : serviceTestIncidentsRepo;
    if (!repo || typeof repo.applySeverityRule !== 'function') {
      return res.status(404).json({ error: 'That kind of event cannot be back-filled on this server' });
    }

    const result = await repo.applySeverityRule(rule, { dryRun });
    if (!dryRun && auditLogger) {
      await auditLogger.record(req, {
        category: 'severity_rule',
        action: 'severity_rule_backfill',
        target: String(id),
        detail: `${result.changed} events set to ${rule.severity}`,
      });
    }
    return res.json({
      rule_id: id,
      dry_run: dryRun,
      matched: result.matched,
      changed: result.changed,
      // Said plainly, because "412" on its own does not tell an admin whether
      // they are about to do something they meant.
      note: dryRun
        ? `${result.changed} open events would be set to ${rule.severity}. Send { "confirm": true } to apply.`
        : `${result.changed} open events set to ${rule.severity}.`,
    });
  }));

  // What a rule WOULD do to one event, without storing anything. The dashboard
  // uses it to show the effect while the admin is still typing.
  router.post('/preview', requireAuth, read, asyncHandler(async (req, res) => {
    const { value, errors } = validateRule(req.body && req.body.rule);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const event = (req.body && req.body.event) || null;
    if (!event || typeof event !== 'object') {
      return res.status(400).json({ error: 'Validation failed', details: { event: 'an event is required' } });
    }
    const decision = applySeverity([{ ...value, id: 0, enabled: true }], event);
    return res.json({ ...decision, explanation: describeDecision(decision) });
  }));

  return router;
}

module.exports = { createSeverityRulesRouter };
