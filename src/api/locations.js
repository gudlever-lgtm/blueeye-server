import { Router } from 'express';
import { requireRole } from '../auth/rbac.js';
import {
  listLocations,
  getLocation,
  insertLocation,
  updateLocation,
  deleteLocation,
} from '../db/queries.js';

const router = Router();

function shapeLocation(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Locations use auto-increment integer ids. Reject anything that is not a
// positive integer up front so callers get a clean 404 rather than a 500.
function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// GET /locations — viewer+
router.get('/locations', requireRole('viewer'), (req, res) => {
  res.json(listLocations().map(shapeLocation));
});

// GET /locations/:id — viewer+
router.get('/locations/:id', requireRole('viewer'), (req, res) => {
  const id = parseId(req.params.id);
  const row = id ? getLocation(id) : undefined;
  if (!row) {
    return res.status(404).json({ error: 'location not found' });
  }
  res.json(shapeLocation(row));
});

// POST /locations — operator/admin
router.post('/locations', requireRole('operator'), (req, res) => {
  const { name, description } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (description != null && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string' });
  }
  const row = insertLocation({ name: name.trim(), description: description ?? null });
  res.status(201).json(shapeLocation(row));
});

// PUT /locations/:id — operator/admin
router.put('/locations/:id', requireRole('operator'), (req, res) => {
  const id = parseId(req.params.id);
  if (!id) {
    return res.status(404).json({ error: 'location not found' });
  }
  const { name, description } = req.body ?? {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'name must be a non-empty string' });
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    return res.status(400).json({ error: 'description must be a string' });
  }
  const updated = updateLocation(id, {
    ...(name !== undefined ? { name: name.trim() } : {}),
    ...(description !== undefined ? { description } : {}),
  });
  if (!updated) {
    return res.status(404).json({ error: 'location not found' });
  }
  res.json(shapeLocation(updated));
});

// DELETE /locations/:id — admin
router.delete('/locations/:id', requireRole('admin'), (req, res) => {
  const id = parseId(req.params.id);
  if (!id || !deleteLocation(id)) {
    return res.status(404).json({ error: 'location not found' });
  }
  res.status(204).end();
});

export default router;
