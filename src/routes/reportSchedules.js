'use strict';

// Scheduled reports — /api/report-schedules.
//
// The availability and probe-outage reports are exports: somebody opens the
// Reporting page and downloads a file. This is the other half — the recurring
// obligation those reports usually serve (the monthly SLA figure, the weekly
// outage list), sent on its own to the people who need it.
//
//   GET    /            viewer+   the schedules, with what happened last time
//   POST   /            admin     create
//   PUT    /:id         admin     update
//   DELETE /:id         admin     delete
//   POST   /:id/send-now operator+ run it now, exactly as the schedule runs it
//
// Creating one is an ADMIN action because it sends data out of the building to
// an address list, on a timer, from then on. Running one now is operator+: it
// mails the same report to the same already-approved addresses.

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateReportScheduleInput } = require('../validation/reportScheduleValidation');

function createReportSchedulesRouter({ repo, scheduler = null, locationsRepo = null, auditLogger = null }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const admin = requireRole(ROLES.ADMIN);
  const operator = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

  const invalidId = (res) => res.status(400).json({ error: 'Invalid id' });
  const notFound = (res) => res.status(404).json({ error: 'Report schedule not found' });
  const validationError = (res, details) => res.status(400).json({ error: 'Validation failed', details });

  // A location filter that names a location nobody has is a schedule that will
  // mail an empty report every month — caught here, once, rather than by the
  // recipient noticing.
  async function checkLocation(res, value) {
    if (!locationsRepo || value.params.locationId == null) return true;
    const location = await locationsRepo.findById(value.params.locationId);
    if (location) return true;
    validationError(res, { params: 'params.location_id does not name a location' });
    return false;
  }

  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    res.json(await repo.findAll());
  }));

  router.get('/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const row = await repo.findById(id);
    if (!row) return notFound(res);
    res.json(row);
  }));

  router.post('/', requireAuth, admin, asyncHandler(async (req, res) => {
    const { value, errors } = validateReportScheduleInput(req.body);
    if (errors) return validationError(res, errors);
    if (!(await checkLocation(res, value))) return;
    const created = await repo.create({ ...value, created_by: req.user ? req.user.id : null });
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'report', action: 'report_schedule_created', target: String(created.id),
        // Who it goes to is the point of the record: this is data leaving the
        // building on a timer.
        detail: JSON.stringify({ report: value.report, format: value.format, recipients: value.recipients, schedule: value.schedule_spec }),
      });
    }
    res.status(201).json(created);
  }));

  router.put('/:id', requireAuth, admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const { value, errors } = validateReportScheduleInput(req.body);
    if (errors) return validationError(res, errors);
    const existing = await repo.findById(id);
    if (!existing) return notFound(res);
    if (!(await checkLocation(res, value))) return;
    const updated = await repo.update(id, value);
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'report', action: 'report_schedule_updated', target: String(id),
        detail: JSON.stringify({ report: value.report, recipients: value.recipients, schedule: value.schedule_spec }),
      });
    }
    res.json(updated);
  }));

  router.delete('/:id', requireAuth, admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const removed = await repo.remove(id);
    if (!removed) return notFound(res);
    if (auditLogger) {
      await auditLogger.record(req, { category: 'report', action: 'report_schedule_deleted', target: String(id) });
    }
    res.status(204).end();
  }));

  // Run it now — the same build and the same send the timer performs, so a
  // "does this work" is a real answer and not a different code path.
  router.post('/:id/send-now', requireAuth, operator, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const schedule = await repo.findById(id);
    if (!schedule) return notFound(res);
    if (!scheduler || typeof scheduler.runOne !== 'function') {
      return res.status(503).json({ error: 'The report scheduler is not available' });
    }
    const outcome = await scheduler.runOne(schedule);
    await repo.setLastRun(id, outcome.ok ? `ok — ${outcome.detail}` : `failed — ${outcome.detail}`);
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'report', action: 'report_schedule_sent', target: String(id),
        detail: JSON.stringify({ recipients: schedule.recipients, ok: outcome.ok, detail: outcome.detail }),
      });
    }
    // A mail server that is not configured is not a server error — it is an
    // answer the screen can act on, so it comes back as one.
    res.status(outcome.ok ? 202 : 409).json({ id, ...outcome });
  }));

  return router;
}

module.exports = { createReportSchedulesRouter };
