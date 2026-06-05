'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateSpeedtestResult } = require('../validation/speedtestValidation');

const MAX_BYTES = 200 * 1024 * 1024; // hard cap per transfer
const DEFAULT_BYTES = 10 * 1024 * 1024;
const CHUNK = 64 * 1024;

// Agent-facing speed-test endpoints (agent-token auth). The agent measures the
// download then the upload to compute Mbps, and posts the result back. These
// transfer synthetic zero-filled bytes — metadata only; nothing is inspected.
function createSpeedtestRouter({ agentAuth, speedtestResultsRepo }) {
  const router = express.Router();

  // GET /speedtest/download?bytes=N — stream N zero bytes (capped). Backpressure
  // aware so a slow client can't balloon memory.
  router.get('/download', agentAuth, (req, res) => {
    let bytes = Number(req.query.bytes);
    if (!Number.isFinite(bytes) || bytes <= 0) bytes = DEFAULT_BYTES;
    bytes = Math.min(Math.floor(bytes), MAX_BYTES);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(bytes));
    res.setHeader('Cache-Control', 'no-store');
    const block = Buffer.alloc(CHUNK, 0);
    let sent = 0;
    function pump() {
      while (sent < bytes) {
        const remaining = bytes - sent;
        const chunk = remaining >= CHUNK ? block : block.subarray(0, remaining);
        sent += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
      res.end();
    }
    pump();
  });

  // POST /speedtest/upload — consume the (octet-stream) body, count the bytes and
  // discard them. Aborts if it exceeds the cap. The agent times this to get the
  // upload rate. Bypasses express.json (different content-type) so nothing is
  // buffered in memory beyond a chunk at a time.
  router.post('/upload', agentAuth, (req, res) => {
    let received = 0;
    let done = false;
    const finish = (status, body) => { if (done) return; done = true; res.status(status).json(body); };
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BYTES) { finish(413, { error: 'upload too large' }); req.destroy(); }
    });
    req.on('end', () => finish(200, { bytes: received }));
    req.on('error', () => finish(400, { error: 'upload failed' }));
  });

  // POST /speedtest/results { result } — store a completed measurement.
  router.post('/results', agentAuth, asyncHandler(async (req, res) => {
    const { value, errors } = validateSpeedtestResult(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });
    const id = await speedtestResultsRepo.create(req.agent.agentId, value);
    res.status(201).json({ id });
  }));

  return router;
}

// User-facing read API. viewer+.
function createSpeedtestReadRouter({ speedtestResultsRepo, agentsRepo }) {
  const router = express.Router();

  // GET /api/speedtest?agentId=&limit= — recent results for an agent (newest first).
  router.get(
    '/',
    requireAuth,
    requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN),
    asyncHandler(async (req, res) => {
      const agentId = parseId(req.query.agentId);
      if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
      const agent = await agentsRepo.findById(agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : 50;
      res.json({ agentId, results: await speedtestResultsRepo.findByAgent(agentId, limit) });
    })
  );

  return router;
}

module.exports = { createSpeedtestRouter, createSpeedtestReadRouter };
