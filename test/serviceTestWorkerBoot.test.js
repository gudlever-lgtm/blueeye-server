'use strict';

// Boot smoke test for the Service Assurance worker entrypoint.
//
// scripts/service-test-worker.js is the one file in the module that the rest of
// the suite never runs: every other spec drives the worker LOOP with injected
// fakes, and the entrypoint is what wires the real pool, secret box and logger
// to it. That gap hid a one-word bug for a release — the script did
// `const config = require('../src/config')` where the module exports
// `{ config }`, so `config.db` was undefined and the worker died on its first
// statement. In Docker that reads as "Started" followed by a restart loop, and
// the dashboard simply says no worker is connected.
//
// So: spawn it against a dead database and assert it gets as far as announcing
// that it is polling. The pool is lazy, so nothing here needs MySQL.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

test('the worker entrypoint boots far enough to poll for work', async () => {
  const repoRoot = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['scripts/service-test-worker.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      JWT_SECRET: 'worker-boot-smoke-test-secret-0123456789',
      SERVICE_TEST_WORKER_ID: 'boot-smoke-test',
      // A dead DB: mysql2 connects lazily, so the wiring runs regardless and the
      // loop's first tick simply fails to reach it.
      DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'x', DB_PASSWORD: 'x', DB_NAME: 'x',
      SERVICE_TEST_ARTIFACT_ROOT: path.join(os.tmpdir(), 'blueeye-worker-boot-test'),
      LOG_LEVEL: 'info',
    },
  });

  let out = '';
  const outcome = await new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done({ kind: 'timeout' }), 15000);
    const check = (d) => {
      out += d;
      if (/failed to start/.test(out)) done({ kind: 'failed-to-start' });
      else if (/polling for work/.test(out)) done({ kind: 'polling' });
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.on('exit', (code) => done({ kind: 'exit', code }));
  });

  child.kill('SIGKILL');

  assert.notEqual(outcome.kind, 'failed-to-start', `the worker died during wiring:\n${out.slice(0, 1200)}`);
  assert.notEqual(outcome.kind, 'exit', `the worker exited instead of polling (code ${outcome.code}):\n${out.slice(0, 1200)}`);
  assert.equal(outcome.kind, 'polling', `the worker never reported polling:\n${out.slice(0, 1200)}`);
});
