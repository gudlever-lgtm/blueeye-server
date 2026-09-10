'use strict';

const { parseId } = require('../validation');

// Shared plumbing for the Service Tests routers. Small on purpose: the value is
// that every route answers with the SAME shapes, because the security gate sweeps
// all of them and an inconsistent 404 shows up as a 500.

// Wraps an async handler so a rejected promise reaches Express's error handler
// instead of hanging the request. Mirrors src/middleware/asyncHandler.js, kept
// local so the module owns its own dependencies.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const invalid = (res, details) => res.status(400).json({ error: 'Validation failed', details });
const notFound = (res, what = 'Not found') => res.status(404).json({ error: what });
const invalidId = (res) => res.status(400).json({ error: 'Invalid id' });

// Resolves :id from the path, answering 400 for a malformed one and 404 when the
// row does not exist. Returns null when it already answered, so a handler reads:
//
//   const app = await loadOr404(req, res, repositories.applications);
//   if (!app) return undefined;
function makeLoader(repo, label) {
  return async (req, res, param = 'id') => {
    const id = parseId(req.params[param]);
    if (id === null) { invalidId(res); return null; }
    const row = await repo.findById(id);
    if (!row) { notFound(res, `${label} not found`); return null; }
    return row;
  };
}

// Records an audit entry, best-effort: an audit failure must never fail the
// request that succeeded.
function auditor(audit, category = 'service_tests') {
  return (req, action, target, detail) => {
    if (!audit || typeof audit.record !== 'function') return;
    try {
      Promise.resolve(audit.record(req, {
        category,
        action,
        target: String(target ?? '').slice(0, 255),
        detail: String(detail ?? '').slice(0, 512),
      })).catch(() => {});
    } catch { /* best-effort */ }
  };
}

const userId = (req) => (req && req.user && req.user.id) || null;

module.exports = { asyncHandler, invalid, notFound, invalidId, makeLoader, auditor, userId, parseId };
