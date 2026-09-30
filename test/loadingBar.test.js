'use strict';

// The page-load line (public/loadingBar.js). What is worth pinning here is not
// that it draws — it is the three behaviours that decide whether the reader
// trusts it: a fast call must never flash, parallel calls must not switch each
// other off, and the width must never claim to be a measurement.
//
// The module takes its document as an argument (create(doc)), so this runs on
// a stub rather than jsdom, and the timers are mocked — the delay is 150 ms of
// real time nobody should spend per assertion.

const test = require('node:test');
const assert = require('node:assert/strict');

const LoadingBar = require('../public/loadingBar.js');

// The three DOM calls the module makes, and nothing else.
function fakeDoc() {
  const classes = new Set();
  const attrs = {};
  const fill = { style: { width: '', transition: '' } };
  const el = {
    isConnected: true,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
    querySelector: () => fill,
  };
  return {
    doc: { getElementById: (id) => (id === 'loading-bar' ? el : null) },
    classes,
    attrs,
    width: () => parseFloat(fill.style.width || '0'),
  };
}

test('a reply inside the delay window never draws anything', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { doc, classes } = fakeDoc();
  const bar = LoadingBar.create(doc);

  bar.start();
  t.mock.timers.tick(140);
  bar.stop();
  t.mock.timers.tick(1000);

  assert.equal(classes.has('is-on'), false, 'a fast call flashed the bar');
  assert.equal(classes.has('is-done'), false);
  assert.equal(bar.pending(), 0);
});

test('a slow reply shows the line, and the width creeps without ever reaching 90%', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { doc, classes, width, attrs } = fakeDoc();
  const bar = LoadingBar.create(doc);

  bar.start();
  t.mock.timers.tick(160);
  assert.equal(classes.has('is-on'), true, 'the line never appeared');
  assert.equal(attrs['aria-hidden'], undefined, 'it is visible, so it must not be hidden from a screen reader');
  const early = width();
  assert.ok(early > 0 && early < 90, `expected a partial width, got ${early}`);

  // Ten seconds of waiting: still moving, still short of the ceiling. A bar
  // that parks at a number is a bar the reader stops believing.
  t.mock.timers.tick(10_000);
  const late = width();
  assert.ok(late > early, 'the line stopped moving');
  assert.ok(late < 90.0001, `the creep passed its ceiling: ${late}`);
});

test('parallel fetches are counted: the first reply back does not clear the line', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { doc, classes, width } = fakeDoc();
  const bar = LoadingBar.create(doc);

  bar.start(); bar.start(); bar.start();
  t.mock.timers.tick(200);
  assert.equal(classes.has('is-on'), true);

  bar.stop();
  bar.stop();
  assert.equal(bar.pending(), 1);
  assert.equal(classes.has('is-on'), true, 'two of three replies took the line down');

  bar.stop();
  assert.equal(classes.has('is-on'), false);
  assert.equal(classes.has('is-done'), true);
  assert.equal(width(), 100, 'the line has to finish its travel, not vanish mid-way');
});

test('stop() is safe when nothing is pending, and never counts below zero', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { doc } = fakeDoc();
  const bar = LoadingBar.create(doc);

  bar.stop();
  bar.stop();
  assert.equal(bar.pending(), 0);

  bar.start();
  assert.equal(bar.pending(), 1, 'the counter went negative and swallowed the next request');
});

test('reset() drops everything in flight — the signed-out case', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { doc, classes, width, attrs } = fakeDoc();
  const bar = LoadingBar.create(doc);

  bar.start(); bar.start();
  t.mock.timers.tick(300);
  assert.equal(classes.has('is-on'), true);

  bar.reset();
  assert.equal(bar.pending(), 0);
  assert.equal(classes.has('is-on'), false);
  assert.equal(width(), 0);
  assert.equal(attrs['aria-hidden'], 'true');

  // …and the creep really stopped, rather than carrying on invisibly.
  t.mock.timers.tick(5000);
  assert.equal(width(), 0);
});

test('with no element on the page the calls are still safe', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const bar = LoadingBar.create({ getElementById: () => null });
  bar.start();
  t.mock.timers.tick(500);
  bar.stop();
  bar.reset();
  assert.equal(bar.pending(), 0);
});

// --- served, and only what exists is served --------------------------------
// The line is only ever seen if the browser can load its script. This is the
// 200/404 pair for the new asset, over the real Express app rather than the
// filesystem: a file on disk that the static mount does not reach is still a
// blank top-of-page.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const supertest = require('supertest');
const { makeApp } = require('../test-support/fakes');

test('GET /loadingBar.js is served as JavaScript, and a missing asset is a 404', async () => {
  const app = makeApp();

  const ok = await supertest(app).get('/loadingBar.js');
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /javascript/);
  assert.match(ok.text, /LoadingBar/);

  // No token needed: it is part of the login screen's own chrome, and a
  // gated loader would mean the very first request of the session shows
  // nothing.
  const missing = await supertest(app).get('/loadingBarr.js');
  assert.equal(missing.status, 404);
});
