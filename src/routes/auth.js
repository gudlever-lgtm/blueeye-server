'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { verifyPassword, hashPassword } = require('../auth/password');
const { issueToken } = require('../auth/jwt');
const { config } = require('../config');

// Authentication routes (public).
function createAuthRouter({ usersRepo }) {
  const router = express.Router();

  // A throwaway hash compared against when the email is unknown, so login takes
  // roughly the same time whether or not the account exists (reduces user
  // enumeration via timing). Computed lazily, then memoised.
  let dummyHashPromise = null;
  const getDummyHash = () => {
    if (!dummyHashPromise) {
      dummyHashPromise = hashPassword('account-enumeration-guard');
    }
    return dummyHashPromise;
  };

  // POST /auth/login { email, password } -> { token, ... } or 401.
  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required' });
      }

      const user = await usersRepo.findByEmailWithHash(email);
      const hash = user ? user.password_hash : await getDummyHash();
      const passwordOk = await verifyPassword(password, hash);

      if (!user || !passwordOk) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = issueToken(user);
      return res.json({
        token,
        tokenType: 'Bearer',
        expiresIn: config.auth.jwtExpiresIn,
        user: { id: user.id, email: user.email, role: user.role },
      });
    })
  );

  return router;
}

module.exports = { createAuthRouter };
