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

export function insertLocation(location) {
  const now = location.createdAt ?? Date.now();
  const info = getDb()
    .prepare(
      `INSERT INTO locations (name, description, created_at, updated_at)
       VALUES (@name, @description, @created_at, @updated_at)`
    )
    .run({
      name: location.name,
      description: location.description ?? null,
      created_at: now,
      updated_at: now,
    });
  return getLocation(info.lastInsertRowid);
}

export function getLocation(id) {
  return getDb().prepare('SELECT * FROM locations WHERE id = ?').get(id);
}

export function listLocations() {
  return getDb().prepare('SELECT * FROM locations ORDER BY name').all();
}

export function updateLocation(id, fields) {
  const existing = getLocation(id);
  if (!existing) return undefined;
  const name = fields.name ?? existing.name;
  const description =
    fields.description !== undefined ? fields.description : existing.description;
  getDb()
    .prepare(
      'UPDATE locations SET name = ?, description = ?, updated_at = ? WHERE id = ?'
    )
    .run(name, description, Date.now(), id);
  return getLocation(id);
}

export function deleteLocation(id) {
  return getDb().prepare('DELETE FROM locations WHERE id = ?').run(id).changes > 0;
}

export function countAgents() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM agents').get().n;
}

export function ping() {
  return getDb().prepare('SELECT 1 AS ok').get().ok === 1;
}
