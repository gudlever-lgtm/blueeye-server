'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');

// "What happened since I last looked" (Fase 2) — the dashboard's landing page.
//
//   GET  /api/changes?since=<iso|last_login>&window=<duration>&limit=&offset=
//   POST /api/changes/seen                       — move the per-user marker
//   POST   /api/changes/ack       { key }        — acknowledge one row (own view)
//   DELETE /api/changes/ack/:key                 — undo it
//   POST   /api/changes/mute      { key, hours } — mute a rule (own view, 1..168h)
//   DELETE /api/changes/mute/:key                — unmute it
//
// viewer+. Read-only aggregation over existing sources; owns no tables beyond
// the per-user marker column (migration 074) and the per-user acknowledgements
// (migration 115) and mutes (migration 124).
//
// MUTE RULE: a mute covers every row with the same muteKey (source + type, on
// any host) until `mutedUntil`. It is always time-boxed and never touches
// alerting — it only changes what the caller's Changes page shows.
// ACKNOWLEDGEMENT RULE: a row is acknowledged while (a) the caller has an ack
// for its ackKey and (b) nothing newer has happened — its newest timestamp is
// not after the ack. A condition that fires again after it was acknowledged is
// shown again. Current-state rows carry their state in the key instead (see
// ackKeyFor), because their timestamp is always "now".
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

// A row's ackKey is a sha256 hex digest (ackKeyFor in changeFeed.js).
const ACK_KEY_RE = /^[0-9a-f]{64}$/;
// Mute length. 24h is what the UI offers; up to a week is accepted so a
// weekend or a planned change can be covered, but never longer — a mute that
// outlives its reason is how the page quietly stops showing what matters.
const DEFAULT_MUTE_HOURS = 24;
const MAX_MUTE_HOURS = 168;

function isAcknowledged(ev, ackedAt) {
  if (!ackedAt) return false;
  if (ev.currentState) return true;
  const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
  return Number.isFinite(ts) && ts <= ackedAt.getTime();
}

function createChangesRouter({ changesService, usersRepo = null, auditLogger = null, logger = null }) {
  const canAck = () => usersRepo
    && typeof usersRepo.listChangeAcks === 'function'
    && typeof usersRepo.ackChange === 'function'
    && typeof usersRepo.unackChange === 'function';
  const canMute = () => usersRepo
    && typeof usersRepo.listChangeMutes === 'function'
    && typeof usersRepo.muteChange === 'function'
    && typeof usersRepo.unmuteChange === 'function';

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

    // Annotate with the caller's acknowledgements. A failure here must not blank
    // the page a shift starts on: the rows are still true, they just cannot say
    // which ones this user has dealt with — so it is reported like any other
    // failed source, and every row reads as not acknowledged.
    let acks = new Map();
    const failedSources = [...(feed.failedSources || [])];
    if (canAck()) {
      try {
        acks = await usersRepo.listChangeAcks(req.user.id);
      } catch (err) {
        failedSources.push('acknowledgements');
        if (logger && typeof logger.warn === 'function') logger.warn(`changes: acknowledgements failed (${err.message})`);
      }
    }
    // Same degradation for mutes: a failed lookup shows everything, and says so.
    let mutes = new Map();
    if (canMute()) {
      try {
        mutes = await usersRepo.listChangeMutes(req.user.id);
      } catch (err) {
        failedSources.push('mutes');
        if (logger && typeof logger.warn === 'function') logger.warn(`changes: mutes failed (${err.message})`);
      }
    }
    const nowMs = Date.now();
    const annotate = (ev) => {
      const at = acks.get(ev.ackKey);
      const until = mutes.get(ev.muteKey);
      return {
        ...ev,
        acknowledgedAt: isAcknowledged(ev, at) ? at.toISOString() : null,
        mutedUntil: until && until.getTime() > nowMs ? until.toISOString() : null,
      };
    };
    const events = (feed.events || []).map(annotate);
    const groups = (feed.groups || []).map((g) => ({ ...g, events: (g.events || []).map(annotate) }));

    // An empty window is 200 with an empty list AND the reference time, never
    // 404 and never a blank body — "nothing changed since 06:00" is the answer,
    // and the timestamp is the half that makes it meaningful.
    return res.json({
      ...feed,
      events,
      groups,
      acknowledged: events.filter((e) => e.acknowledgedAt).length,
      muted: events.filter((e) => e.mutedUntil).length,
      partial: failedSources.length > 0,
      failedSources,
      sinceMode,
    });
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

  // POST /api/changes/ack — acknowledge one row, for the caller only.
  //
  // viewer+ for the same reason as /seen: it writes only the caller's own view.
  // The key is not looked up in the feed first — rebuilding a dozen sources to
  // validate one click is not worth it, and an ack for a key no row carries is
  // harmless (it matches nothing and expires). It IS validated for shape.
  router.post('/ack', requireAuth, reader, asyncHandler(async (req, res) => {
    if (!canAck()) return res.status(503).json({ error: 'Acknowledgements are not available' });
    const key = req.body && typeof req.body.key === 'string' ? req.body.key : '';
    if (!ACK_KEY_RE.test(key)) return res.status(400).json({ error: 'key must be a row ackKey (64 hex characters)' });

    const at = new Date();
    await usersRepo.ackChange(req.user.id, key, at);
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'user', action: 'change_acknowledged', target: String(req.user.id),
        detail: `acknowledged change ${key.slice(0, 12)}`,
      });
    }
    return res.json({ key, acknowledgedAt: at.toISOString() });
  }));

  // DELETE /api/changes/ack/:key — undo. 404 when there was nothing to undo.
  router.delete('/ack/:key', requireAuth, reader, asyncHandler(async (req, res) => {
    if (!canAck()) return res.status(503).json({ error: 'Acknowledgements are not available' });
    // A key that is not even the right shape cannot have been acknowledged: it
    // is a 404 like any other missing id, answered without a query.
    const key = String(req.params.key || '');
    const removed = ACK_KEY_RE.test(key) ? await usersRepo.unackChange(req.user.id, key) : false;
    if (!removed) return res.status(404).json({ error: 'That change is not acknowledged' });
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'user', action: 'change_unacknowledged', target: String(req.user.id),
        detail: `removed acknowledgement ${key.slice(0, 12)}`,
      });
    }
    return res.status(204).end();
  }));

  // POST /api/changes/mute — mute every row of one rule (source + type) for the
  // caller, for `hours` (default 24, max 168). viewer+: own view only, like ack.
  router.post('/mute', requireAuth, reader, asyncHandler(async (req, res) => {
    if (!canMute()) return res.status(503).json({ error: 'Mutes are not available' });
    const body = req.body || {};
    const key = typeof body.key === 'string' ? body.key : '';
    if (!ACK_KEY_RE.test(key)) return res.status(400).json({ error: 'key must be a row muteKey (64 hex characters)' });
    let hours = DEFAULT_MUTE_HOURS;
    if (body.hours !== undefined && body.hours !== null) {
      if (!Number.isInteger(body.hours) || body.hours < 1 || body.hours > MAX_MUTE_HOURS) {
        return res.status(400).json({ error: `hours must be an integer 1..${MAX_MUTE_HOURS}` });
      }
      hours = body.hours;
    }

    const until = new Date(Date.now() + hours * 3600 * 1000);
    await usersRepo.muteChange(req.user.id, key, until);
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'user', action: 'change_rule_muted', target: String(req.user.id),
        detail: `muted change rule ${key.slice(0, 12)} for ${hours}h`,
      });
    }
    return res.json({ key, mutedUntil: until.toISOString() });
  }));

  // DELETE /api/changes/mute/:key — unmute. 404 when nothing live to undo.
  router.delete('/mute/:key', requireAuth, reader, asyncHandler(async (req, res) => {
    if (!canMute()) return res.status(503).json({ error: 'Mutes are not available' });
    const key = String(req.params.key || '');
    const removed = ACK_KEY_RE.test(key) ? await usersRepo.unmuteChange(req.user.id, key) : false;
    if (!removed) return res.status(404).json({ error: 'That rule is not muted' });
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'user', action: 'change_rule_unmuted', target: String(req.user.id),
        detail: `unmuted change rule ${key.slice(0, 12)}`,
      });
    }
    return res.status(204).end();
  }));

  return router;
}

module.exports = { createChangesRouter, isAcknowledged, ACK_KEY_RE, DEFAULT_MUTE_HOURS, MAX_MUTE_HOURS, parseWindow, MAX_WINDOW_MS, MAX_LIMIT, DEFAULT_WINDOW_MS };
