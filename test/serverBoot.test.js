'use strict';

// Boot smoke test — guards the ONE surface the rest of the suite never exercises:
// src/server.js `start()`, the real dependency wiring (the unit/API tests use
// createApp via test-support fakes and never run server.js). A use-before-
// declaration / temporal-dead-zone error in the wiring (e.g. a job created before
// the repo it depends on) throws SYNCHRONOUSLY at boot, before any DB I/O — which
// is invisible to fake-based tests but crashes the container. This test spawns the
// server against a dead DB and asserts the wiring completes (it reaches "listening"
// or hangs on the DB) rather than throwing a ReferenceError.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('server boots past dependency wiring without a ReferenceError', async () => {
  const repoRoot = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'server-boot-smoke-test-secret-0123456789',
      PORT: '0', // ephemeral port — never collides
      // A dead DB: the lazy mysql2 pool never connects, but the synchronous
      // wiring (where a TDZ would throw) runs regardless.
      DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'x', DB_PASSWORD: 'x', DB_NAME: 'x',
      TSDB_ENABLED: 'false',
      DISCOVERY_ENABLED: 'false',
      LICENSE_VALIDATE_INTERVAL_HOURS: '24',
    },
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const outcome = await new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done({ kind: 'timeout' }), 12000);
    const check = () => {
      if (/ReferenceError|is not defined|before initialization/.test(out)) done({ kind: 'ref-error' });
      else if (/listening on port/.test(out)) done({ kind: 'listening' });
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.on('exit', (code) => done({ kind: 'exit', code }));
  });

  child.kill('SIGKILL');

  if (outcome.kind === 'ref-error') {
    assert.fail(`server.js wiring threw a ReferenceError at boot:\n${out.slice(0, 1200)}`);
  }
  if (outcome.kind === 'exit' && outcome.code && outcome.code !== 0) {
    // An early non-zero exit that ISN'T a wiring ReferenceError (e.g. a config
    // guard) — surface the output so it's diagnosable, but only fail on a
    // ReferenceError, which is what this test guards.
    assert.ok(!/ReferenceError|before initialization/.test(out), `boot ReferenceError:\n${out.slice(0, 1200)}`);
  }
  // 'listening' or 'timeout' (wiring done, hung on the dead DB) both mean the
  // synchronous wiring completed — no TDZ. Pass.
  assert.ok(outcome.kind === 'listening' || outcome.kind === 'timeout' || outcome.kind === 'exit', `unexpected outcome ${outcome.kind}`);
});
