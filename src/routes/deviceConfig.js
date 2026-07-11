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

const CAPTURED_VIA = ['manual', 'agent_poll', 'change_detected'];
const MAX_CONFIG_BYTES = 512 * 1024; // 512 KiB — a device config, not a data dump
// (kept below the app's 1 MiB JSON body limit so an over-cap-but-parseable config
// returns a clean 400 here rather than the body parser's 413).

// Device config history (Fase 3 pt 5) + manual ingest. A device is an agent.
// This handles raw device config, so it is operator/admin only (never viewer);
// reads are secret-masked on the way out (raw config_text is never returned) and
// the store keeps the raw text (mask-on-read).
//   GET  /api/devices/:id/config-history   — masked snapshots + consecutive diffs
//   POST /api/devices/:id/config-snapshots — ingest one raw config capture
function createDeviceConfigRouter({ configSnapshotsRepo, agentsRepo = null, auditLogger = null }) {
  const router = express.Router();
  const gate = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

  // Resolves the device (agent) or sends 404. Returns true when it exists (or
  // when no agentsRepo is wired, i.e. tests that don't care).
  async function deviceExists(id) {
    if (!agentsRepo || typeof agentsRepo.findById !== 'function') return true;
    return Boolean(await agentsRepo.findById(id));
  }

  // POST /api/devices/:id/config-snapshots — the config producer (operator/admin).
  // Body: { configText (required), capturedVia? }. Stores the raw text (masked
  // only on read). Idempotent-ish: if the text is identical to the device's
  // latest snapshot it is not stored again (200 unchanged) so re-polling the same
  // config doesn't pile up duplicate rows.
  router.post('/:id/config-snapshots', requireAuth, gate, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });

    const body = req.body || {};
    const configText = typeof body.configText === 'string' ? body.configText : null;
    if (!configText || configText.trim() === '') {
      return res.status(400).json({ error: 'Validation failed', details: { configText: 'configText is required' } });
    }
    if (Buffer.byteLength(configText, 'utf8') > MAX_CONFIG_BYTES) {
      return res.status(400).json({ error: 'Validation failed', details: { configText: 'config is too large (max 1 MiB)' } });
    }
    const capturedVia = CAPTURED_VIA.includes(body.capturedVia) ? body.capturedVia : 'manual';

    if (!(await deviceExists(id))) return res.status(404).json({ error: 'Device not found' });

    // Skip when unchanged vs. the most recent snapshot for this device.
    const [latest] = await configSnapshotsRepo.listForDevice(id, { limit: 1, withText: true });
    if (latest && latest.configText === configText) {
      return res.json({ id: latest.id, deviceId: id, unchanged: true });
    }

    const newId = await configSnapshotsRepo.insert({ deviceId: id, configText, capturedVia });
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'config',
        action: 'config_snapshot_ingest',
        target: String(id),
        detail: `via=${capturedVia}, ${Buffer.byteLength(configText, 'utf8')} bytes`,
      });
    }
    return res.status(201).json({ id: newId, deviceId: id, capturedVia, unchanged: false });
  }));

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
