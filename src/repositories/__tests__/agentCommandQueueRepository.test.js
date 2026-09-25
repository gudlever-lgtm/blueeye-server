'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAgentCommandQueueRepository, stripTransport } = require('../agentCommandQueueRepository');

// A scripted pool: it asserts the SQL and the parameters, which is what this
// repository's behaviour actually consists of. Whether the SQL is valid is a
// different question, answered by `npm run verify-schema` against MySQL.
function makePool() {
  const calls = [];
  const conn = {
    async beginTransaction() { calls.push(['begin']); },
    async commit() { calls.push(['commit']); },
    async rollback() { calls.push(['rollback']); },
    release() { calls.push(['release']); },
    async query(sql, params) {
      calls.push([sql.trim().split(/\s+/).slice(0, 3).join(' '), params]);
      if (/^\s*SELECT/i.test(sql)) return [conn._rows || []];
      return [{ affectedRows: conn._affected || 0 }];
    },
  };
  return {
    calls,
    conn,
    async getConnection() { return conn; },
    async query(sql, params) {
      calls.push([sql.trim().split(/\s+/).slice(0, 3).join(' '), params]);
      if (/^\s*SELECT/i.test(sql)) return [this._rows || []];
      return [{ insertId: this._insertId || 0, affectedRows: this._affected || 0 }];
    },
  };
}

test('enqueue upserts on (agent, kind) so clicking Update twice leaves one command', async () => {
  const pool = makePool();
  pool._insertId = 5;
  const repo = createAgentCommandQueueRepository({ pool });
  const id = await repo.enqueue(7, { name: 'update', version: '1.2.3', id: 'send-1' }, { auditId: 9 });
  assert.equal(id, 5);
  const [sql, params] = pool.calls[0];
  assert.match(sql, /^INSERT INTO agent_command_queue/);
  assert.equal(params[0], 7);
  assert.equal(params[1], 'update');
  // The correlation id never reaches storage.
  assert.deepEqual(JSON.parse(params[2]), { name: 'update', version: '1.2.3' });
  assert.equal(params[3], 9);
});

test('a command without a name is refused rather than stored unfindable', async () => {
  const repo = createAgentCommandQueueRepository({ pool: makePool() });
  await assert.rejects(() => repo.enqueue(7, {}), /needs a name/);
});

test('the TTL is clamped, so nothing is queued forever or for a second', async () => {
  const pool = makePool();
  const repo = createAgentCommandQueueRepository({ pool });
  await repo.enqueue(7, { name: 'update' }, { ttlSec: 1 });
  await repo.enqueue(7, { name: 'update' }, { ttlSec: 10 ** 9 });
  assert.equal(pool.calls[0][1][4], 60);
  assert.equal(pool.calls[1][1][4], 30 * 86400);
});

test('take claims and deletes in one transaction, so two sockets cannot both deliver', async () => {
  const pool = makePool();
  pool.conn._rows = [
    { id: 1, kind: 'update', payload: '{"name":"update"}', auditId: 3, expiresAt: new Date(Date.now() + 60000), createdAt: new Date() },
  ];
  const repo = createAgentCommandQueueRepository({ pool });
  const rows = await repo.take(7);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].command, { name: 'update' });
  const shapes = pool.calls.map((c) => c[0]);
  assert.deepEqual(shapes, ['begin', 'SELECT id, kind,', 'DELETE FROM agent_command_queue', 'commit', 'release']);
});

test('take never hands back an expired command', async () => {
  const pool = makePool();
  pool.conn._rows = [
    { id: 1, kind: 'update', payload: '{"name":"update","version":"0.1.0"}', auditId: null, expiresAt: new Date(Date.now() - 1000), createdAt: new Date() },
  ];
  const repo = createAgentCommandQueueRepository({ pool });
  assert.deepEqual(await repo.take(7), []);
  // Still deleted: an update for a version two releases old is not worth keeping.
  assert.ok(pool.calls.some((c) => c[0] === 'DELETE FROM agent_command_queue'));
});

test('a failed take rolls back and releases the connection', async () => {
  const pool = makePool();
  pool.conn.query = async () => { throw new Error('deadlock'); };
  const repo = createAgentCommandQueueRepository({ pool });
  await assert.rejects(() => repo.take(7), /deadlock/);
  const shapes = pool.calls.map((c) => c[0]);
  assert.deepEqual(shapes, ['begin', 'rollback', 'release']);
});

test('stripTransport drops exactly what is bound to one send', async () => {
  assert.deepEqual(
    stripTransport({ name: 'update', version: '1.0.0', id: 'x', commandSignature: 's', issuedAt: 1, auditId: 2 }),
    { name: 'update', version: '1.0.0', auditId: 2 }
  );
});
