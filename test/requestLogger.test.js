'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { requestLogger } = require('../src/middleware/requestLogger');
const { createLogger } = require('../src/logger');

function fakeRes() {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 200;
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

test('requestLogger mints a request id, sets X-Request-Id and binds req.log', () => {
  const lines = [];
  const logger = createLogger({ level: 'info', format: 'json', stdout: (l) => lines.push(l) });
  const mw = requestLogger(logger);
  const req = { method: 'GET', originalUrl: '/x', headers: {} };
  const res = fakeRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });

  assert.equal(nexted, true);
  assert.ok(req.id, 'req.id is set');
  assert.equal(res.headers['X-Request-Id'], req.id);
  assert.equal(typeof req.log.info, 'function');

  res.emit('finish');
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.reqId, req.id); // request line carries the correlation id
  assert.match(rec.msg, /GET \/x 200/);
});

test('requestLogger honours a client-supplied X-Request-Id', () => {
  const mw = requestLogger(createLogger({ stdout() {} }));
  const req = { method: 'GET', originalUrl: '/x', headers: { 'x-request-id': 'trace-42' } };
  const res = fakeRes();
  mw(req, res, () => {});
  assert.equal(req.id, 'trace-42');
  assert.equal(res.headers['X-Request-Id'], 'trace-42');
});
