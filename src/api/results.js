import { Router } from 'express';
import { listResults } from '../db/queries.js';

const router = Router();

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function shapeResult(row) {
  return {
    id: row.id,
    testId: row.test_id,
    agentId: row.agent_id,
    type: row.type,
    target: row.target,
    status: row.status,
    result: parseJson(row.result, {}),
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

router.get('/results', (req, res) => {
  const agentId = req.query.agentId;
  const type = req.query.type;
  const limit = Math.min(parseInt(req.query.limit ?? '100', 10) || 100, 1000);
  res.json(listResults({ agentId, type, limit }).map(shapeResult));
});

router.get('/results/:agentId', (req, res) => {
  res.json(
    listResults({ agentId: req.params.agentId, limit: 1000 }).map(shapeResult)
  );
});

export default router;
