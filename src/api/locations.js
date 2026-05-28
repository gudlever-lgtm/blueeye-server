import { Router } from 'express';
import { requireRole } from '../auth.js';
import {
  listLocations,
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

function readName(body) {
  const name = body?.name;
  if (typeof name !== 'string' || !name.trim()) return null;
  return name.trim();
}

// GET /locations — viewer+
router.get('/locations', requireRole('viewer'), (req, res) => {
  res.json(listLocations().map(shapeLocation));
});

// POST /locations — operator/admin
router.post('/locations', requireRole('operator'), (req, res) => {
  const name = readName(req.body);
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  const row = insertLocation({ name, description: req.body?.description });
  res.status(201).json(shapeLocation(row));
});

// PUT /locations/:id — operator/admin
router.put('/locations/:id', requireRole('operator'), (req, res) => {
  const name = readName(req.body);
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  const row = updateLocation(req.params.id, {
    name,
    description: req.body?.description,
  });
  if (!row) {
    return res.status(404).json({ error: 'location not found' });
  }
  res.json(shapeLocation(row));
});

// DELETE /locations/:id — admin
router.delete('/locations/:id', requireRole('admin'), (req, res) => {
  if (!deleteLocation(req.params.id)) {
    return res.status(404).json({ error: 'location not found' });
  }
  res.status(204).end();
});

export default router;
