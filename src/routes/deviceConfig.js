'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { maskedDiff } = require('../config/configContext');
const { maskConfigText } = require('../config/mask');

function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Device config history (Fase 3 pt 5). A device is an agent. This exposes raw
// device config, so it is operator/admin only (never viewer) and everything is
// secret-masked on the way out — raw config_text is never returned.
//   GET /api/devices/:id/config-history — masked snapshots + consecutive diffs
function createDeviceConfigRouter({ configSnapshotsRepo, agentsRepo = null }) {
  const router = express.Router();
  const gate = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

  router.get('/:id/config-history', requireAuth, gate, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    if (agentsRepo && typeof agentsRepo.findById === 'function') {
      const agent = await agentsRepo.findById(id);
      if (!agent) return res.status(404).json({ error: 'Device not found' });
    }

    const snaps = await configSnapshotsRepo.listForDevice(id, { limit: 50, withText: true });

    // Masked snapshots — the raw config_text is replaced by a secret-masked copy.
    const snapshots = snaps.map((s) => ({
      id: s.id,
      deviceId: s.deviceId,
      capturedAt: s.capturedAt,
      capturedVia: s.capturedVia,
      configTextMasked: maskConfigText(s.configText),
    }));

    // Consecutive diffs (newest-first list: snap[i] is newer than snap[i+1]).
    const diffs = [];
    for (let i = 0; i < snaps.length - 1; i += 1) {
      const newer = snaps[i];
      const older = snaps[i + 1];
      const d = maskedDiff(older.configText, newer.configText);
      if (d.changed) {
        diffs.push({ fromSnapshotId: older.id, toSnapshotId: newer.id, capturedAt: newer.capturedAt, ...d });
      }
    }

    return res.json({ deviceId: id, snapshots, diffs });
  }));

  return router;
}

module.exports = { createDeviceConfigRouter };
