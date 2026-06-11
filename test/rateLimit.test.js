'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter, noopRateLimiter } = require('../src/middleware/rateLimit');

function fakeReqRes(ip) {
  const req = { ip, body: {} };
  const res = {
    statusCode: 200,
    headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return { req, res };
}

test('allows up to max then returns 429 within the window', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
  let nexts = 0;
  const next = () => { nexts += 1; };

  for (let i = 0; i < 3; i += 1) {
    const { req, res } = fakeReqRes('1.2.3.4');
    limiter(req, res, next);
    assert.equal(res.statusCode, 200);
  }
  assert.equal(nexts, 3);

  const { req, res } = fakeReqRes('1.2.3.4');
  limiter(req, res, next);
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers['Retry-After']);
  assert.equal(nexts, 3); // next not called on the blocked request
  limiter.stop();
});

test('separate keys have independent budgets', () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
  const a = fakeReqRes('10.0.0.1');
  const b = fakeReqRes('10.0.0.2');
  limiter(a.req, a.res, () => {});
  limiter(b.req, b.res, () => {});
  assert.equal(a.res.statusCode, 200);
  assert.equal(b.res.statusCode, 200);
  limiter.stop();
});

test('window resets after windowMs (injected clock)', () => {
  let t = 1000;
  const limiter = createRateLimiter({ windowMs: 100, max: 1, now: () => t });
  const first = fakeReqRes('9.9.9.9');
  limiter(first.req, first.res, () => {});
  assert.equal(first.res.statusCode, 200);

  const blocked = fakeReqRes('9.9.9.9');
  limiter(blocked.req, blocked.res, () => {});
  assert.equal(blocked.res.statusCode, 429);

  t += 101; // advance past the window
  const after = fakeReqRes('9.9.9.9');
  limiter(after.req, after.res, () => {});
  assert.equal(after.res.statusCode, 200);
  limiter.stop();
});

test('noopRateLimiter always calls next', () => {
  let called = false;
  noopRateLimiter({}, {}, () => { called = true; });
  assert.equal(called, true);
});
