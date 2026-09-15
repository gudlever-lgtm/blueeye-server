'use strict';

const express = require('express');
const { asyncHandler, notFound, invalidId, invalid, auditor, userId, parseId } = require('./helpers');
const { validateMonitor } = require('../validation/monitors');
const { validateStatsQuery } = require('../validation');
const { resolvePeriod } = require('../stats/period');
const { catalogue, TYPE_NAMES, isType } = require('../monitors/types');

// The monitors HTTP surface: the checks that are not a browser.
//
// Reads are viewer+ — "is our mail flowing" is an operations question and hiding
// it behind a role helps nobody. Writes are operator+, and a manual check is a
// write: it reaches out to the network, sends a real message and consumes a real
// mailbox.
//
// Secrets are WRITE-ONLY on every path. They go in through `config`, are split
// out by the validator, and come back only as `has_secrets: { smtp_password:
// true }`. There is no route that returns one.
function createMonitorsRouter({ repositories, settings, reactor = null, audit, requireRole, roles, logger = null }) {
  const router = express.Router();
  const { monitors, monitorResults } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const write = requireRole(roles.OPERATOR, roles.ADMIN);
  const record = auditor(audit);

  // Manual checks in flight. A mail round-trip can run for minutes, and two of
  // them against one monitor would race for the same mailbox and each delete the
  // other's probe message.
  const running = new Set();

  async function limits() {
    let cfg = {};
    try { cfg = (await settings.get('monitors')) || {}; } catch { cfg = {}; }
    return {
      // Stored as one comma-separated line (the settings contract has no list
      // type); empty means no restriction.
      recipientDomains: String(cfg.mailRecipientDomains || '').split(',').map((d) => d.trim()).filter(Boolean),
      minIntervalSec: Number.isFinite(cfg.minIntervalSec) ? cfg.minIntervalSec : 60,
      maxMonitors: Number.isFinite(cfg.maxMonitors) ? cfg.maxMonitors : 200,
    };
  }

  // ------------------------------------------------------------------ types
  // The catalogue the UI builds its form from. Ahead of /:id so a literal path
  // is never read as an id.
  router.get('/types', read, asyncHandler(async (req, res) => res.json({ types: catalogue() })));

  // ------------------------------------------------------------------- list
  router.get('/', read, asyncHandler(async (req, res) => {
    let applicationId = null;
    if (req.query.application_id !== undefined && req.query.application_id !== '') {
      applicationId = parseId(req.query.application_id);
      if (applicationId === null) return res.status(400).json({ error: 'Invalid application_id' });
    }
    let type = null;
    if (req.query.type !== undefined && req.query.type !== '') {
      type = String(req.query.type);
      if (!isType(type)) return res.status(400).json({ error: `Invalid type (expected one of ${TYPE_NAMES.join(', ')})` });
    }
    let enabled = null;
    if (req.query.enabled === 'true') enabled = true;
    else if (req.query.enabled === 'false') enabled = false;
    else if (req.query.enabled !== undefined && req.query.enabled !== '') {
      return res.status(400).json({ error: 'Invalid enabled' });
    }
    return res.json(await monitors.list({ applicationId, type, enabled }));
  }));

  // ----------------------------------------------------------------- create
  router.post('/', write, asyncHandler(async (req, res) => {
    const { recipientDomains, minIntervalSec, maxMonitors } = await limits();
    const existing = await monitors.list({ limit: 1000 });
    if (existing.length >= maxMonitors) {
      return res.status(400).json({ error: 'Validation failed', details: { _: `at most ${maxMonitors} monitors` } });
    }
    const { value, errors } = validateMonitor(req.body, { recipientDomains, minIntervalSec });
    if (errors) return invalid(res, errors);
    if (existing.some((m) => m.name.toLowerCase() === value.name.toLowerCase())) {
      return invalid(res, { name: 'a monitor with that name already exists' });
    }
    const created = await monitors.create({ ...value, created_by: userId(req) });
    record(req, 'monitor.create', created.id, `${created.type} ${created.target}`);
    return res.status(201).json(created);
  }));

  // -------------------------------------------------------------------- one
  router.get('/:id', read, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const monitor = await monitors.findById(id);
    if (!monitor) return notFound(res, 'Monitor not found');
    const [results, summary] = await Promise.all([
      monitorResults.list({ monitorId: id, limit: 20 }),
      monitorResults.summary(id, { hours: 24 }),
    ]);
    return res.json({ ...monitor, recent: results, summary });
  }));

  router.patch('/:id', write, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const monitor = await monitors.findById(id);
    if (!monitor) return notFound(res, 'Monitor not found');
    const { recipientDomains, minIntervalSec } = await limits();
    const { value, errors } = validateMonitor(req.body, {
      partial: true, recipientDomains, minIntervalSec, existing: monitor,
    });
    if (errors) return invalid(res, errors);
    const updated = await monitors.update(id, value);
    record(req, 'monitor.update', id, Object.keys(value).join(','));
    return res.json(updated);
  }));

  router.delete('/:id', write, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const monitor = await monitors.findById(id);
    if (!monitor) return notFound(res, 'Monitor not found');
    await monitors.remove(id);
    record(req, 'monitor.delete', id, monitor.name);
    return res.status(204).end();
  }));

  // ------------------------------------------------------------- check now
  // A write, and an outbound one: it sends a real message, opens a real
  // connection and reaches a real mailbox. 409 rather than a queue while one is
  // already running — two probes racing for one mailbox delete each other's
  // message and both report "undelivered".
  router.post('/:id/check', write, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const monitor = await monitors.findById(id);
    if (!monitor) return notFound(res, 'Monitor not found');
    if (!reactor || typeof reactor.checkMonitor !== 'function') {
      return res.status(503).json({ error: 'Monitor checks are not available in this process' });
    }
    if (running.has(id)) return res.status(409).json({ error: 'A check is already running for this monitor' });

    running.add(id);
    try {
      const outcome = await reactor.checkMonitor(id, { trigger: 'manual', requestedBy: userId(req) });
      record(req, 'monitor.check', id, outcome && outcome.result ? outcome.result.status : 'unknown');
      return res.json({
        monitor: outcome.monitor,
        result: outcome.result,
        incident: outcome.incident || null,
        state: outcome.state || null,
      });
    } catch (err) {
      if (logger && logger.warn) logger.warn(`monitors: manual check of ${id} failed (${err && err.message})`);
      throw err;
    } finally {
      running.delete(id);
    }
  }));

  // ------------------------------------------------------------- activate
  // The override on the activation gate (migration 095).
  //
  // A monitor is normally scheduled by its first working check, which is what
  // keeps a mistyped mail server from paging anybody. But when the service is
  // genuinely down at the moment the monitor is created, watching it is exactly
  // what an operator wants — and without this the gate would be a trap that only
  // lets you monitor things that are already working.
  //
  // Idempotent: activating an already-scheduled monitor is a 200 and changes
  // nothing, because "watching since" is the date it FIRST started.
  router.post('/:id/activate', write, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const monitor = await monitors.findById(id);
    if (!monitor) return notFound(res, 'Monitor not found');
    if (!monitor.pending) return res.json(monitor);
    const activated = await monitors.activate(id);
    record(req, 'monitor.activate', id, monitor.name);
    return res.json(activated);
  }));

  // ----------------------------------------------------------------- series
  // Availability over time, in the buckets the run-history charts already use.
  //
  // The 24-hour summary answers "is it working". This answers "is it getting
  // worse" — a mail monitor at 100% whose delivery time tripled over a week is
  // the finding, and no single number can show it.
  router.get('/:id/series', read, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const monitor = await monitors.findById(id);
    if (!monitor) return notFound(res, 'Monitor not found');

    const { value, errors } = validateStatsQuery(req.query);
    if (errors) return invalid(res, errors);
    const period = resolvePeriod({ period: value.period, at: value.at, offsetMinutes: value.tz_offset, now: new Date() });

    // The unit belongs to the CHECK, not the monitor: the type catalogue says
    // what it measures, and the newest result is where that lands.
    const [newest] = await monitorResults.list({ monitorId: id, limit: 1 });
    const lastUnit = (newest && newest.unit) || null;

    const rows = await monitorResults.series({
      monitorId: id,
      from: period.from,
      to: period.to,
      // The period module owns the calendar AND the SQL format that matches its
      // bucket keys — taking one from it and deriving the other is how the two
      // drift apart and every bucket misses.
      sqlFormat: period.sql_format,
      offsetMinutes: period.offset_minutes,
    });

    // Every bucket in the period, empty ones included. A gap is the reading an
    // operator needs ("it stopped checking on Thursday"), and it only exists if
    // the empty buckets are in the answer — a chart that closes the gap silently
    // tells a different story.
    const byBucket = new Map(rows.map((row) => [row.bucket, row]));
    const buckets = period.buckets.map((b) => {
      const row = byBucket.get(b.key);
      return {
        start: b.start,
        key: b.key,
        checks: row ? row.checks : 0,
        ok: row ? row.ok : 0,
        slow: row ? row.slow : 0,
        bad: row ? row.bad : 0,
        misconfigured: row ? row.misconfigured : 0,
        unknown: row ? row.unknown : 0,
        availability: row ? row.availability : null,
        avg_value: row ? row.avg_value : null,
        max_value: row ? row.max_value : null,
        min_value: row ? row.min_value : null,
      };
    });

    const sum = (key) => buckets.reduce((acc, b) => acc + b[key], 0);
    const good = sum('ok') + sum('slow');
    const judged = good + sum('bad') + sum('misconfigured');
    // Weighted by CHECKS, not by bucket: an hour with 60 checks and one with 2
    // must not weigh the same in the period's average measurement.
    const weighted = buckets.reduce(
      (acc, b) => (b.avg_value === null ? acc : { v: acc.v + b.avg_value * b.checks, n: acc.n + b.checks }),
      { v: 0, n: 0 }
    );

    return res.json({
      monitor_id: id,
      // What the measurement IS, so the chart can label its axis: a monitor that
      // measures days must never be drawn as milliseconds.
      unit: lastUnit,
      period: period.period,
      bucket: period.bucket,
      at: period.at,
      from: period.from,
      to: period.to,
      prev_at: period.prev_at,
      next_at: period.next_at,
      has_next: period.has_next,
      is_current: period.is_current,
      buckets,
      total: {
        checks: sum('checks'),
        // Unmeasured is not 0% available: a period where nothing was judged has
        // no availability to report.
        availability: judged ? good / judged : null,
        avg_value: weighted.n ? Math.round(weighted.v / weighted.n) : null,
        max_value: buckets.reduce((max, b) => (b.max_value === null ? max : Math.max(max ?? b.max_value, b.max_value)), null),
      },
    });
  }));

  // ---------------------------------------------------------------- results
  router.get('/:id/results', read, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const monitor = await monitors.findById(id);
    if (!monitor) return notFound(res, 'Monitor not found');
    let limit = 100;
    if (req.query.limit !== undefined && req.query.limit !== '') {
      limit = parseId(req.query.limit);
      if (limit === null) return res.status(400).json({ error: 'Invalid limit' });
    }
    let hours = 24;
    if (req.query.hours !== undefined && req.query.hours !== '') {
      hours = parseId(req.query.hours);
      if (hours === null) return res.status(400).json({ error: 'Invalid hours' });
    }
    const [results, summary] = await Promise.all([
      monitorResults.list({ monitorId: id, limit: Math.min(limit, 500) }),
      monitorResults.summary(id, { hours }),
    ]);
    return res.json({ monitor_id: id, results, summary });
  }));

  return router;
}

module.exports = { createMonitorsRouter };
