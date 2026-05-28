import { getDb } from './database.js';

export function upsertAgent(agent) {
  getDb()
    .prepare(
      `INSERT INTO agents (id, hostname, platform, arch, node_version, last_seen, status)
       VALUES (@id, @hostname, @platform, @arch, @node_version, @last_seen, @status)
       ON CONFLICT(id) DO UPDATE SET
         hostname = excluded.hostname,
         platform = excluded.platform,
         arch = excluded.arch,
         node_version = excluded.node_version,
         last_seen = excluded.last_seen,
         status = excluded.status`
    )
    .run({
      id: agent.id,
      hostname: agent.hostname ?? null,
      platform: agent.platform ?? null,
      arch: agent.arch ?? null,
      node_version: agent.nodeVersion ?? null,
      last_seen: agent.lastSeen ?? Date.now(),
      status: agent.status ?? 'offline',
    });
}

export function setAgentStatus(id, status, lastSeen = Date.now()) {
  getDb()
    .prepare('UPDATE agents SET status = ?, last_seen = ? WHERE id = ?')
    .run(status, lastSeen, id);
}

export function getAgent(id) {
  return getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id);
}

export function listAgents() {
  return getDb().prepare('SELECT * FROM agents ORDER BY id').all();
}

export function insertTest(test) {
  getDb()
    .prepare(
      `INSERT INTO tests (id, agent_id, type, target, options, status, created_at)
       VALUES (@id, @agent_id, @type, @target, @options, @status, @created_at)`
    )
    .run({
      id: test.id,
      agent_id: test.agentId,
      type: test.type,
      target: test.target ?? null,
      options: JSON.stringify(test.options ?? {}),
      status: test.status ?? 'pending',
      created_at: test.createdAt ?? Date.now(),
    });
}

export function setTestStatus(id, status) {
  getDb().prepare('UPDATE tests SET status = ? WHERE id = ?').run(status, id);
}

export function getTest(id) {
  return getDb().prepare('SELECT * FROM tests WHERE id = ?').get(id);
}

export function listTests({ agentId, limit = 50 } = {}) {
  if (agentId) {
    return getDb()
      .prepare('SELECT * FROM tests WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(agentId, limit);
  }
  return getDb()
    .prepare('SELECT * FROM tests ORDER BY created_at DESC LIMIT ?')
    .all(limit);
}

export function insertResult(result) {
  getDb()
    .prepare(
      `INSERT INTO results (id, test_id, agent_id, type, target, status, result, error, duration_ms, created_at)
       VALUES (@id, @test_id, @agent_id, @type, @target, @status, @result, @error, @duration_ms, @created_at)`
    )
    .run({
      id: result.id,
      test_id: result.testId ?? null,
      agent_id: result.agentId ?? null,
      type: result.type ?? null,
      target: result.target ?? null,
      status: result.status ?? null,
      result: JSON.stringify(result.result ?? {}),
      error: result.error ?? null,
      duration_ms: result.durationMs ?? null,
      created_at: result.createdAt ?? Date.now(),
    });
}

export function getResult(id) {
  return getDb().prepare('SELECT * FROM results WHERE id = ?').get(id);
}

export function getResultByTestId(testId) {
  return getDb()
    .prepare('SELECT * FROM results WHERE test_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(testId);
}

export function listResults({ agentId, type, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (agentId) {
    clauses.push('agent_id = ?');
    params.push(agentId);
  }
  if (type) {
    clauses.push('type = ?');
    params.push(type);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  return getDb()
    .prepare(`SELECT * FROM results ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params);
}

export function recentResultsForAgent(agentId, limit = 10) {
  return getDb()
    .prepare('SELECT * FROM results WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(agentId, limit);
}

export function countAgents() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM agents').get().n;
}

export function ping() {
  return getDb().prepare('SELECT 1 AS ok').get().ok === 1;
}

export function createUser(user) {
  getDb()
    .prepare(
      `INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
       VALUES (@id, @email, @password_hash, @role, @created_at, @updated_at)`
    )
    .run({
      id: user.id,
      email: user.email,
      password_hash: user.passwordHash,
      role: user.role ?? 'viewer',
      created_at: user.createdAt ?? Date.now(),
      updated_at: user.updatedAt ?? Date.now(),
    });
}

export function listUsers() {
  return getDb().prepare('SELECT * FROM users ORDER BY created_at DESC, email').all();
}

export function getUser(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function getUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function updateUser(id, { role, passwordHash, updatedAt = Date.now() } = {}) {
  const sets = ['updated_at = @updated_at'];
  const params = { id, updated_at: updatedAt };
  if (role !== undefined) {
    sets.push('role = @role');
    params.role = role;
  }
  if (passwordHash !== undefined) {
    sets.push('password_hash = @password_hash');
    params.password_hash = passwordHash;
  }
  return getDb()
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`)
    .run(params);
}

export function deleteUser(id) {
  return getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function countAdmins() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
}
