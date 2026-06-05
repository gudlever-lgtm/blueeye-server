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

test('dashboard exposes settings (users+license) tab, auto-refresh and traffic chart', async () => {
  const app = makeApp();
  const html = (await request(app).get('/')).text;
  assert.match(html, /data-view="settings"/); // settings tab (user admin + license live under it)
  assert.match(html, /id="autorefresh"/); // auto-refresh toggle

  const js = (await request(app).get('/app.js')).text;
  assert.match(js, /views\.settings/); // settings overview view
  assert.match(js, /views\.users/); // user-admin view (now reused inside settings)
  assert.match(js, /trafficChart/); // traffic-over-time chart
  assert.match(js, /setAutoRefresh/); // auto-refresh logic
  assert.match(js, /agentSourceCell/); // per-agent traffic source
  assert.match(js, /monitor_config/); // source selection sent to the API
  assert.match(js, /showLocationTraffic/); // live per-location correlated traffic
  assert.match(js, /\/traffic/); // calls the location traffic endpoint
  assert.match(js, /agentHealthCell/); // agent health derived from last report
  assert.match(js, /newAgent/); // operator "+ New agent" (enrollment code)
  assert.match(js, /function openDrawer/); // slide-in info drawer
  assert.match(js, /PAGE_INFO/); // per-page hero/info content
  assert.match(js, /refreshLicense/); // "Re-validate now" on the license page
  assert.match(js, /\/license\/refresh/); // calls the refresh endpoint
  assert.match(js, /showLocationHistory/); // historical traffic between dates
  assert.match(js, /traffic\/history/); // calls the history endpoint
  assert.match(js, /showAgentFlows/); // NetFlow port/protocol search
  assert.match(js, /\/flows\?/); // calls the flows endpoint
  assert.match(js, /views\.overview/); // full-width traffic overview
  assert.match(js, /function multiChart/); // multi-series chart
  assert.match(html, /data-view="overview"/); // overview tab
  assert.match(js, /trafficTypesCard/); // Traffic types aggregate card beside History
  assert.match(js, /hist-row/); // History + Traffic types laid out side by side
  assert.match(js, /who-email/); // shows logged-in email + role
  assert.match(js, /data\.user\.email/); // captures email on login
  assert.match(js, /views\.map/); // locations map view
  assert.match(html, /data-view="map"/); // map tab
  assert.match(html, /leaflet/i); // Leaflet assets included
  assert.match(js, /payload\.system/); // shows host CPU/memory metrics
  assert.match(js, /storageCards/); // server disk + database storage cards
  assert.match(js, /\/system\/storage/); // calls the storage endpoint
});

test('dashboard offers selectable colour themes saved per user', async () => {
  const app = makeApp();
  const js = (await request(app).get('/app.js')).text;
  assert.match(js, /const PALETTES =/); // palette catalogue (each with light + dark)
  assert.match(js, /settingsAppearanceView/); // Settings → Appearance theme picker
  assert.match(js, /\/me\/preferences/); // persists the chosen theme per user
  assert.match(js, /loadProfile/); // applies the saved theme on session start
  assert.match(js, /dual: p\.dark\.key/); // every variant knows its opposite-brightness pair
  assert.match(js, /themeMeta\(document\.documentElement\.dataset\.theme\)\.dual/); // toggle flips brightness within the palette

  const css = (await request(app).get('/styles.css')).text;
  assert.match(css, /\[data-theme="nord"\]/); // a dark colour palette is defined
  assert.match(css, /\[data-theme="nord-light"\]/); // …paired with a light variant
  assert.match(css, /\[data-theme="solarized-dark"\]/);
  assert.match(css, /\.theme-grid/); // picker styling
});
