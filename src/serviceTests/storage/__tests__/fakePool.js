'use strict';

// A scripted mysql2-style pool for the Service Tests repository specs.
//
// These tests are about the CONTRACT at the storage boundary: which statement is
// issued, with which parameters, in which transaction, and how the returned rows
// are shaped. So the fake records every call and answers from handlers the test
// registers, rather than pretending to be MySQL. That keeps a spec honest about
// what it actually proves — a hand-rolled SQL engine would only prove the fake
// agrees with itself.
//
//   const pool = makeFakePool([
//     [/^INSERT INTO service_test_applications/i, () => [{ insertId: 7 }]],
//     [/^SELECT .* FROM service_test_applications WHERE id = \?/i, () => [[row]]],
//   ]);
//
// A handler returns what mysql2 returns: [rows] for a SELECT, [okPacket] for a
// write. Unmatched SQL throws, so a repository that starts issuing a statement
// the spec never considered fails loudly instead of silently returning undefined.
function makeFakePool(handlers = []) {
  const calls = [];
  const registered = handlers.slice();

  async function query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: text, params });
    for (const [pattern, handler] of registered) {
      if (pattern.test(text)) return handler(params, text);
    }
    throw new Error(`unexpected SQL in fake pool: ${text}`);
  }

  const pool = {
    calls,
    query,
    // Registers a handler after construction (for a second phase of a spec).
    on(pattern, handler) { registered.unshift([pattern, handler]); return pool; },
    // Every recorded statement matching a pattern.
    matching(pattern) { return calls.filter((c) => pattern.test(c.sql)); },
    // Transaction bookkeeping, so a spec can assert commit vs rollback.
    tx: { begun: 0, committed: 0, rolledBack: 0, released: 0 },
    async getConnection() {
      return {
        query,
        async beginTransaction() { pool.tx.begun += 1; },
        async commit() { pool.tx.committed += 1; },
        async rollback() { pool.tx.rolledBack += 1; },
        release() { pool.tx.released += 1; },
      };
    },
  };
  return pool;
}

// Convenience: the ok-packet shape mysql2 returns for a write.
const ok = (over = {}) => [{ affectedRows: 1, insertId: 1, ...over }];
const rows = (list) => [list];

module.exports = { makeFakePool, ok, rows };
