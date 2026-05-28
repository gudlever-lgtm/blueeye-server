import { createHmac, timingSafeEqual } from 'node:crypto';
import config from '../config.js';

// Minimal dependency-free HS256 JSON Web Tokens. Enough for stateless API
// auth without pulling in a third-party library.

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function sign(payload, { secret = config.jwtSecret, expiresInSec = 3600 } = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + expiresInSec, ...payload };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(body))}`;
  const signature = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

export function verify(token, { secret = config.jwtSecret } = {}) {
  if (typeof token !== 'string') {
    throw new Error('invalid token');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('invalid token');
  }
  const [headerB64, bodyB64, signature] = parts;
  const data = `${headerB64}.${bodyB64}`;
  const expected = createHmac('sha256', secret).update(data).digest('base64url');

  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new Error('invalid signature');
  }

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('malformed token');
  }
  if (header.alg !== 'HS256') {
    throw new Error('unsupported token algorithm');
  }
  if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) >= payload.exp) {
    throw new Error('token expired');
  }
  return payload;
}
