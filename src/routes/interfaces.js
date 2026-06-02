'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// Derives per-interface health from a traffic payload (proc or snmp). Pure +
// exported for tests. status: down | bad (errors / >=90% util) | warn (drops /
// >=75% util) | ok.
function computeInterfaceHealth(traffic) {
  const ifaces = traffic && Array.isArray(traffic.interfaces) ? traffic.interfaces : [];
  const elapsed = Number(traffic && traffic.elapsedSec) > 0 ? Number(traffic.elapsedSec) : 1;
  return ifaces.map((i) => {
    const rxBytesPerSec = Number(i.rxBytesPerSec) || 0;
    const txBytesPerSec = Number(i.txBytesPerSec) || 0;
    const speedMbps = Number(i.speedMbps) > 0 ? Number(i.speedMbps) : null;
    const utilPct = speedMbps ? round1((Math.max(rxBytesPerSec, txBytesPerSec) * 8) / (speedMbps * 1e6) * 100) : null;
    const rxErrors = Number(i.rxErrors) || 0;
    const txErrors = Number(i.txErrors) || 0;
    const rxDrop = Number(i.rxDrop) || 0;
    const txDrop = Number(i.txDrop) || 0;
    const errPerSec = round2((rxErrors + txErrors) / elapsed);
    const dropPerSec = round2((rxDrop + txDrop) / elapsed);
    const operStatus = i.operStatus || null;
    const down = !!operStatus && !['up', 'unknown', 'dormant'].includes(operStatus);
    let status = 'ok';
    if (down) status = 'down';
    else if (errPerSec > 0 || (utilPct != null && utilPct >= 90)) status = 'bad';
    else if (dropPerSec > 0 || (utilPct != null && utilPct >= 75)) status = 'warn';
    return {
      iface: i.iface, operStatus, speedMbps,
      rxBytesPerSec, txBytesPerSec, utilPct,
      errPerSec, dropPerSec, rxErrors, txErrors, rxDrop, txDrop, status,
    };
  });
}

// Interface health for one agent, derived from its most recent measurement.
// viewer+. (No new storage — reads the latest row from `results`.)
function createInterfacesRouter({ resultsRepo, agentsRepo }) {
  const router = express.Router();
  router.get('/', requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN), asyncHandler(async (req, res) => {
    const agentId = parseId(req.query.agentId);
    if (agentId === null) return res.status(400).json({ error: 'agentId is required (positive integer)' });
    const agent = await agentsRepo.findById(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const rows = await resultsRepo.findByAgentId(agentId, { limit: 1 });
    const latest = rows && rows[0];
    const traffic = latest && latest.payload && latest.payload.traffic;
    res.json({
      agentId,
      ts: latest ? (latest.created_at instanceof Date ? latest.created_at.toISOString() : latest.created_at) : null,
      source: (traffic && traffic.source) || 'proc',
      interfaces: computeInterfaceHealth(traffic),
    });
  }));
  return router;
}

module.exports = { createInterfacesRouter, computeInterfaceHealth };
