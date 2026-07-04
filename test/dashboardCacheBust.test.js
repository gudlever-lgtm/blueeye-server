'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp } = require('../test-support/fakes');
const { version: appVersion } = require('../package.json');

// The dashboard entry point must version-stamp its local assets so a server
// upgrade forces browsers to re-fetch app.js/styles.css instead of calling
// retired endpoints from a cached copy (the /api/transaction-tests → 404 class).
test('GET / serves index.html with version-stamped app.js and styles.css', async () => {
  const res = await request(makeApp()).get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.ok(res.text.includes(`src="/app.js?v=${appVersion}"`), 'app.js is version-stamped');
  assert.ok(res.text.includes(`href="/styles.css?v=${appVersion}"`), 'styles.css is version-stamped');
  // The raw, unstamped tag must be gone so no client can load an uncached copy.
  assert.ok(!res.text.includes('src="/app.js"'), 'no unstamped app.js tag remains');
});

test('GET /index.html is stamped identically to /', async () => {
  const app = makeApp();
  const [root, explicit] = await Promise.all([
    request(app).get('/'),
    request(app).get('/index.html'),
  ]);
  assert.equal(explicit.status, 200);
  assert.equal(explicit.text, root.text);
});

// The stamped URL still resolves — express.static ignores the query string and
// serves the real file, so the busted URL is not itself a 404.
test('GET /app.js?v=<version> resolves to the real asset', async () => {
  const res = await request(makeApp()).get(`/app.js?v=${appVersion}`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
});
