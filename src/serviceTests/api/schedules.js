'use strict';

const express = require('express');
const { asyncHandler, invalid, makeLoader, auditor, userId, parseId } = require('./helpers');
const { validateSchedule } = require('../validation');
const { nextRunAt, describeSchedule, missedIntervals, INTERVALS } = require('../scheduler/schedule');

// Schedules: "run this test every N, against this environment".
// OPERATOR+ writes, same as building the test itself.
function createSchedulesRouter({ repositories, audit, requireRole, roles }) {
  const router = express.Router();
  const { schedules, tests, environments } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const write = requireRole(roles.OPERATOR, roles.ADMIN);
  const load = makeLoader(schedules, 'Schedule');
  const record = auditor(audit);

  // The cadence choices the UI offers, served rather than duplicated in the
  // browser so the list has one definition.
  router.get('/intervals', read, (req, res) => res.json({ intervals: INTERVALS }));

  const decorate = (s) => ({
    ...s,
    next_run_at: nextRunAt(s),
    description: describeSchedule(s),
    missed_intervals: missedIntervals(s),
  });

  router.get('/', read, asyncHandler(async (req, res) => {
    let testId = null;
    if (req.query.test_id !== undefined) {
      testId = parseId(req.query.test_id);
      if (testId === null) return res.status(400).json({ error: 'Invalid test_id' });
    }
    return res.json((await schedules.list({ testId })).map(decorate));
  }));

  router.post('/', write, asyncHandler(async (req, res) => {
    const { value, errors } = validateSchedule(req.body);
    if (errors) return invalid(res, errors);
    const test = await tests.findById(value.test_id);
    if (!test) return invalid(res, { test_id: 'that test does not exist' });
    if (value.environment_id) {
      const env = await environments.findById(value.environment_id);
      if (!env || env.application_id !== test.application_id) {
        return invalid(res, { environment_id: 'that environment does not belong to this test\'s application' });
      }
    }
    const created = await schedules.create({ ...value, created_by: userId(req) });
    record(req, 'schedule_create', created.id, `test=${value.test_id} every=${value.interval_sec}s`);
    return res.status(201).json(decorate(created));
  }));

  router.get('/:id', read, asyncHandler(async (req, res) => {
    const schedule = await load(req, res);
    return schedule ? res.json(decorate(schedule)) : undefined;
  }));

  router.put('/:id', write, asyncHandler(async (req, res) => {
    const schedule = await load(req, res);
    if (!schedule) return undefined;
    const { value, errors } = validateSchedule(req.body, { partial: true });
    if (errors) return invalid(res, errors);
    const updated = await schedules.update(schedule.id, value);
    record(req, 'schedule_update', schedule.id, Object.keys(value).join(','));
    return res.json(decorate(updated));
  }));

  router.delete('/:id', write, asyncHandler(async (req, res) => {
    const schedule = await load(req, res);
    if (!schedule) return undefined;
    await schedules.remove(schedule.id);
    record(req, 'schedule_delete', schedule.id, `test=${schedule.test_id}`);
    return res.status(204).end();
  }));

  return router;
}

module.exports = { createSchedulesRouter };
