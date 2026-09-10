'use strict';

// The adapter boundary between Service Tests and its host.
//
// Service Tests is built inside BlueEye but must be liftable out and run
// standalone without a rewrite (docs/service-tests.md §2, spec §32). The way that
// is kept true: no file under src/serviceTests/ ever requires a BlueEye module
// directly. Everything the module needs from its host arrives through the object
// described here, and BlueEye supplies it in exactly one place (src/server.js).
//
// So the extraction cost is: implement these ports against something else. Not:
// find every place the module reached into a host internal.
//
//   {
//     db        { pool }                  mysql2-style pool: query(sql, params) -> [rows, fields]
//     secrets   { encrypt, decrypt }      AES-256-GCM at rest. BlueEye: src/lib/secretBox.js
//     audit     { record(req, entry) }    who-did-what. Optional — a no-op is fine
//     logger    { info, warn, error }     operational log. Optional
//     clock     () => Date                injected so schedules/timeouts are testable
//   }
//
// `auth` and `licence` are deliberately NOT ports. They are Express middleware,
// so they are passed to the router factory (createServiceTestsModule) rather than
// held on a long-lived object — the module never decides who may call it, it only
// declares which guard each route wears.

const noopLogger = { info() {}, warn() {}, error() {} };
const noopAudit = { record() { return Promise.resolve(null); } };

// Normalises a partially-specified ports object so the rest of the module can
// assume every field is present. Throws only for `db`, which nothing can
// substitute for.
function resolvePorts(ports = {}) {
  if (!ports.db || !ports.db.pool) {
    throw new Error('serviceTests: ports.db.pool is required');
  }
  return {
    db: ports.db,
    // No secretBox wired (some tests) means credentials round-trip as plaintext.
    // Acceptable in a test, never in production — src/server.js always wires one.
    secrets: ports.secrets || null,
    audit: ports.audit || noopAudit,
    logger: ports.logger || noopLogger,
    clock: typeof ports.clock === 'function' ? ports.clock : () => new Date(),
  };
}

module.exports = { resolvePorts, noopLogger, noopAudit };
