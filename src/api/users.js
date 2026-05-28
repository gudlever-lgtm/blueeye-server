import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { hashPassword } from '../auth/password.js';
import {
  createUser,
  listUsers,
  getUser,
  getUserByEmail,
  updateUser,
  deleteUser,
  countAdmins,
} from '../db/queries.js';

const router = Router();

const ROLES = ['admin', 'operator', 'viewer'];

function shapeUser(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Every /users route requires an authenticated admin.
router.use('/users', requireAuth, requireRole('admin'));

router.get('/users', (req, res) => {
  res.json(listUsers().map(shapeUser));
});

router.post('/users', async (req, res, next) => {
  try {
    const { email, password, role } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    if (role !== undefined && !ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
    }
    if (getUserByEmail(email)) {
      return res.status(409).json({ error: 'email already exists' });
    }
    const now = Date.now();
    const user = {
      id: randomUUID(),
      email,
      passwordHash: await hashPassword(password),
      role: role ?? 'viewer',
      createdAt: now,
      updatedAt: now,
    };
    createUser(user);
    res.status(201).json(shapeUser(getUser(user.id)));
  } catch (err) {
    next(err);
  }
});

router.put('/users/:id', async (req, res, next) => {
  try {
    const existing = getUser(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'user not found' });
    }
    const { role, password } = req.body ?? {};
    if (role === undefined && password === undefined) {
      return res.status(400).json({ error: 'role or password is required' });
    }
    if (role !== undefined && !ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
    }
    // Don't let the final admin be demoted away.
    if (existing.role === 'admin' && role !== undefined && role !== 'admin' && countAdmins() <= 1) {
      return res.status(409).json({ error: 'cannot demote the last admin' });
    }

    const patch = { updatedAt: Date.now() };
    if (role !== undefined) {
      patch.role = role;
    }
    if (password !== undefined) {
      if (!password) {
        return res.status(400).json({ error: 'password must not be empty' });
      }
      patch.passwordHash = await hashPassword(password);
    }
    updateUser(req.params.id, patch);
    res.json(shapeUser(getUser(req.params.id)));
  } catch (err) {
    next(err);
  }
});

router.delete('/users/:id', (req, res) => {
  const existing = getUser(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'user not found' });
  }
  // Never remove the last remaining admin.
  if (existing.role === 'admin' && countAdmins() <= 1) {
    return res.status(409).json({ error: 'cannot delete the last admin' });
  }
  deleteUser(req.params.id);
  res.status(204).end();
});

export default router;
