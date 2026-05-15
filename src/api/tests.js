import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import * as registry from '../ws/registry.js';
import {
  insertTest,
  listTests,
  getTest,
  getResultByTestId,
} from '../db/queries.js';

const router = Router();

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function shapeTest(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    type: row.type,
    target: row.target,
    options: parseJson(row.options, {}),
    status: row.status,
    createdAt: row.created_at,
  };
}

router.post('/tests', (req, res) => {
  const { agentId, type, target, options } = req.body ?? {};
  if (!agentId || !type) {
    return res.status(400).json({ error: 'agentId and type are required' });
  }
  if (!registry.has(agentId)) {
    return res.status(404).json({ error: 'agent not online' });
  }

  const test = {
    id: randomUUID(),
    agentId,
    type,
    target: target ?? null,
    options: options ?? {},
    status: 'pending',
    createdAt: Date.now(),
  };
  insertTest(test);
  registry.send(agentId, {
    type: 'run_test',
    testId: test.id,
    testType: type,
    target: test.target,
    options: test.options,
  });

  res.status(201).json({ testId: test.id });
});

router.get('/tests', (req, res) => {
  const agentId = req.query.agentId;
  const limit = Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 500);
  res.json(listTests({ agentId, limit }).map(shapeTest));
});

router.get('/tests/:id', (req, res) => {
  const row = getTest(req.params.id);
  if (!row) {
    return res.status(404).json({ error: 'test not found' });
  }
  const resultRow = getResultByTestId(req.params.id);
  const result = resultRow
    ? {
        id: resultRow.id,
        testId: resultRow.test_id,
        agentId: resultRow.agent_id,
        type: resultRow.type,
        target: resultRow.target,
        status: resultRow.status,
        result: parseJson(resultRow.result, {}),
        error: resultRow.error,
        durationMs: resultRow.duration_ms,
        createdAt: resultRow.created_at,
      }
    : null;
  res.json({ ...shapeTest(row), result });
});

export default router;
