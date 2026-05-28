import { Router } from 'express';
import agentsRouter from './agents.js';
import testsRouter from './tests.js';
import resultsRouter from './results.js';
import { ping, countAgents } from '../db/queries.js';
import { getLicense } from '../license/manager.js';

const router = Router();

router.get('/health', (req, res) => {
  try {
    ping();
    res.json({
      status: 'ok',
      agents: countAgents(),
      uptime: Math.floor(process.uptime()),
      license: getLicense().getState(),
    });
  } catch (err) {
    console.error(`[db] health check failed: ${err.message}`);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Read-only license status (config is set at install time, never via CRUD).
router.get('/license', (req, res) => {
  res.json(getLicense().getState());
});

router.use(agentsRouter);
router.use(testsRouter);
router.use(resultsRouter);

export default router;
