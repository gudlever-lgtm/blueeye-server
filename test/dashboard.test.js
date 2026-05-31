'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp } = require('../test-support/fakes');

test('GET / serves the dashboard HTML', async () => {
  const res = await request(makeApp()).get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /BlueEye/);
});

test('GET /app.js serves the dashboard script', async () => {
  const res = await request(makeApp()).get('/app.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
});

test('unknown API path still returns JSON 404 (falls through static)', async () => {
  const res = await request(makeApp()).get('/definitely-not-a-file');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Not Found');
});

test('dashboard exposes users tab, auto-refresh and traffic chart', async () => {
  const app = makeApp();
  const html = (await request(app).get('/')).text;
  assert.match(html, /data-view="users"/); // user-admin tab
  assert.match(html, /id="autorefresh"/); // auto-refresh toggle

  const js = (await request(app).get('/app.js')).text;
  assert.match(js, /views\.users/); // user-admin view
  assert.match(js, /trafficChart/); // traffic-over-time chart
  assert.match(js, /setAutoRefresh/); // auto-refresh logic
  assert.match(js, /agentSourceCell/); // per-agent traffic source
  assert.match(js, /monitor_config/); // source selection sent to the API
  assert.match(js, /showLocationTraffic/); // live per-location correlated traffic
  assert.match(js, /\/traffic/); // calls the location traffic endpoint
  assert.match(js, /agentHealthCell/); // agent health derived from last report
  assert.match(js, /newAgent/); // operator "+ Ny agent" (enrollment code)
  assert.match(js, /function openDrawer/); // slide-in info drawer
  assert.match(js, /PAGE_INFO/); // per-page hero/info content
});
