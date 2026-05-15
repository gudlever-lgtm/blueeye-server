import { Router } from 'express';
import * as registry from '../ws/registry.js';
import { listAgents, getAgent, recentResultsForAgent } from '../db/queries.js';

const router = Router();

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function shapeAgent(row) {
  return {
    id: row.id,
    hostname: row.hostname,
    platform: row.platform,
    arch: row.arch,
    nodeVersion: row.node_version,
    status: registry.has(row.id) ? 'online' : 'offline',
    lastSeen: row.last_seen,
  };
}

router.get('/agents', (req, res) => {
  res.json(listAgents().map(shapeAgent));
});

router.get('/agents/:id', (req, res) => {
  const row = getAgent(req.params.id);
  if (!row) {
    return res.status(404).json({ error: 'agent not found' });
  }
  const results = recentResultsForAgent(req.params.id, 20).map((r) => ({
    id: r.id,
    testId: r.test_id,
    agentId: r.agent_id,
    type: r.type,
    target: r.target,
    status: r.status,
    result: parseJson(r.result, {}),
    error: r.error,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  }));
  res.json({ ...shapeAgent(row), recentResults: results });
});

export default router;
