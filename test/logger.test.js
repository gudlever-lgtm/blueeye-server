'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createLogger, silentLogger } = require('../src/logger');

// Capture sink + fixed clock so output is deterministic.
function capture(opts = {}) {
  const out = [];
  const err = [];
  const logger = createLogger({
    clock: () => new Date('2026-06-14T00:00:00.000Z'),
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...opts,
  });
  return { logger, out, err };
}

test('level filtering suppresses below the configured level', () => {
  const { logger, out, err } = capture({ level: 'warn' });
  logger.debug('d');
  logger.info('i');
  logger.warn('w');
  logger.error('e');
  assert.equal(out.length, 0); // debug+info suppressed and also routed to stdout
  assert.equal(err.length, 2); // warn+error → stderr
  assert.match(err[0], /WARN w$/);
  assert.match(err[1], /ERROR e$/);
});

test('text format includes ISO timestamp and level', () => {
  const { logger, out } = capture({ level: 'debug' });
  logger.info('hello');
  assert.equal(out[0], '2026-06-14T00:00:00.000Z INFO hello');
});

test('json format emits structured records', () => {
  const { logger, out } = capture({ level: 'info', format: 'json' });
  logger.info('served', { status: 200 });
  const rec = JSON.parse(out[0]);
  assert.equal(rec.level, 'info');
  assert.equal(rec.msg, 'served');
  assert.equal(rec.status, 200);
  assert.equal(rec.ts, '2026-06-14T00:00:00.000Z');
});

test('child() binds correlation fields onto every line', () => {
  const { logger, out } = capture({ level: 'info', format: 'json' });
  logger.child({ reqId: 'abc123' }).info('hi');
  assert.equal(JSON.parse(out[0]).reqId, 'abc123');
});

test('Error arguments render their message (and stack at error level)', () => {
  const { logger, err } = capture({ level: 'info' });
  logger.error('boom', new Error('kaboom'));
  assert.match(err[0], /ERROR boom/);
  assert.match(err[0], /kaboom/);
});

test('silentLogger is a no-op with a child()', () => {
  assert.doesNotThrow(() => silentLogger.info('x'));
  assert.equal(silentLogger.child(), silentLogger);
});
