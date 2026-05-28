import { Router } from 'express';
import agentsRouter from './agents.js';
import testsRouter from './tests.js';
import resultsRouter from './results.js';
import usersRouter from './users.js';
import { ping, countAgents } from '../db/queries.js';

const router = Router();

router.get('/health', (req, res) => {
  try {
    ping();
    res.json({
      status: 'ok',
      agents: countAgents(),
      uptime: Math.floor(process.uptime()),
    });
  } catch (err) {
    console.error(`[db] health check failed: ${err.message}`);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

router.use(agentsRouter);
router.use(testsRouter);
router.use(resultsRouter);
router.use(usersRouter);

export default router;
