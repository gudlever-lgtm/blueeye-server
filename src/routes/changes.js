'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// "What happened since I last looked" (Fase 2) — the dashboard's landing page.
//
//   GET  /api/changes?since=<iso|last_login>&window=<duration>&limit=&offset=
//   POST /api/changes/seen                       — move the per-user marker
//
// viewer+. Read-only aggregation over existing sources; owns no tables beyond
// the per-user marker column (migration 074).
//
// THE MARKER RULE: `since=last_login` reads users.last_seen_changes, and that
// column moves ONLY on the explicit POST — never on a GET. A marker that
// advanced on read would mean the page could never show anyone anything after
// the first load, which is the exact failure this feature exists to avoid.

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;
// Default lookback when the user has no marker yet. A first-time visitor wants
// their shift, not the whole history.
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
// Longest window we will scan. Beyond this the page stops being "what changed"
// and becomes an unbounded report.
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Parses a `window` duration: "30m", "6h", "7d", or a bare number of minutes.
// Returns ms, or null when the value is present but unparseable (a 400 — a
// typo'd window silently becoming the default would quietly show the wrong
// time range, which on this page is worse than an error).
function parseWindow(raw) {
  if (raw === undefined || raw === '') return DEFAULT_WINDOW_MS;
  const s = String(raw).trim().toLowerCase();
  const m = s.match(/^(\d+)\s*(m|h|d)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  const unit = { m: 60 * 1000, h: 3600 * 1000, d: 24 * 3600 * 1000 }[m[2] || 'm'];
  const ms = n * unit;
  return ms > MAX_WINDOW_MS ? null : ms;
}

function parseIntParam(raw, { min, max, fallback }) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function createChangesRouter({ changesService, usersRepo = null, auditLogger = null }) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);

  router.get('/', requireAuth, reader, asyncHandler(async (req, res) => {
    const windowMs = parseWindow(req.query.window);
    if (windowMs === null) {
      return res.status(400).json({ error: `window must be like 30m, 6h or 7d, and at most ${MAX_WINDOW_MS / (24 * 3600 * 1000)}d` });
    }

    const limit = parseIntParam(req.query.limit, { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT });
    if (limit === null) return res.status(400).json({ error: `limit must be an integer 1..${MAX_LIMIT}` });
    const offset = parseIntParam(req.query.offset, { min: 0, max: 100000, fallback: 0 });
    if (offset === null) return res.status(400).json({ error: 'offset must be a non-negative integer' });

    const to = new Date();
    let from = null;
    let sinceMode = 'window';

    const sinceRaw = req.query.since === undefined || req.query.since === '' ? null : String(req.query.since);
    if (sinceRaw === 'last_login' || sinceRaw === 'last_seen') {
      sinceMode = 'marker';
      if (usersRepo && typeof usersRepo.getLastSeenChanges === 'function') {
        from = await usersRepo.getLastSeenChanges(req.user.id);
      }
      // No marker yet → the default window, not the epoch.
      if (!from) { from = new Date(to.getTime() - windowMs); sinceMode = 'window'; }
    } else if (sinceRaw !== null) {
      const parsed = new Date(sinceRaw);
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'since must be an ISO timestamp or "last_login"' });
      if (parsed.getTime() > to.getTime()) return res.status(400).json({ error: 'since must not be in the future' });
      if (to.getTime() - parsed.getTime() > MAX_WINDOW_MS) {
        return res.status(400).json({ error: `since must be within the last ${MAX_WINDOW_MS / (24 * 3600 * 1000)} days` });
      }
      from = parsed;
      sinceMode = 'explicit';
    } else {
      from = new Date(to.getTime() - windowMs);
    }

    const feed = await changesService.changesSince({ from, to, limit, offset });

    // An empty window is 200 with an empty list AND the reference time, never
    // 404 and never a blank body — "nothing changed since 06:00" is the answer,
    // and the timestamp is the half that makes it meaningful.
    return res.json({ ...feed, sinceMode });
  }));

  // POST /api/changes/seen — mark the feed as read up to `at` (default now).
  //
  // Explicit by design: this is the ONLY thing that moves the marker. viewer+,
  // because it writes only the caller's own marker — a viewer marking their own
  // page as read is not a privileged action.
  router.post('/seen', requireAuth, reader, asyncHandler(async (req, res) => {
    if (!usersRepo || typeof usersRepo.setLastSeenChanges !== 'function') {
      return res.status(503).json({ error: 'Seen markers are not available' });
    }
    const now = new Date();
    let at = now;
    if (req.body && req.body.at !== undefined && req.body.at !== null) {
      const parsed = new Date(req.body.at);
      if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'at must be an ISO timestamp' });
      if (parsed.getTime() > now.getTime()) return res.status(400).json({ error: 'at must not be in the future' });
      at = parsed;
    }

    await usersRepo.setLastSeenChanges(req.user.id, at);

    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'user', action: 'changes_marked_seen', target: String(req.user.id),
        detail: `marked changes seen up to ${at.toISOString()}`,
      });
    }

    // Echo the stored marker rather than the requested one: setLastSeenChanges is
    // monotonic (a stale tab cannot rewind it), so the two can legitimately
    // differ and the client must render what actually holds.
    const stored = typeof usersRepo.getLastSeenChanges === 'function'
      ? await usersRepo.getLastSeenChanges(req.user.id)
      : at;
    return res.json({ lastSeenChanges: stored ? stored.toISOString() : at.toISOString() });
  }));

  return router;
}

module.exports = { createChangesRouter, parseWindow, MAX_WINDOW_MS, MAX_LIMIT, DEFAULT_WINDOW_MS };
