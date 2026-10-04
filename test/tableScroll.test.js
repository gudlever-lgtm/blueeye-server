'use strict';

// The horizontal-overflow guard: a wide table scrolls inside its own box rather
// than making the whole page scroll sideways on a phone.
//
// These are the rules that are easy to break by accident later — that it leaves
// already-scrolling containers alone, that it never double-wraps, and above all
// that moving a table inside the tree it is observing does not make it observe
// its own move forever.

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

const { wrapTables, startTableScrollGuard } = require('../public/tableScroll.js');

function dom(html) {
  const d = new JSDOM(`<!doctype html><body>${html}</body>`);
  return d.window.document;
}

// The observer fires on a microtask, so a test that asserts straight after an
// append sees the DOM before the guard has run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a bare table gets a scroll box', () => {
  const doc = dom('<div id="host"><table><tr><td>x</td></tr></table></div>');
  assert.equal(wrapTables(doc.getElementById('host')), 1);
  const table = doc.querySelector('table');
  assert.equal(table.parentElement.className, 'tablescroll');
  assert.equal(table.parentElement.parentElement.id, 'host');
});

test('the table itself can be the node passed in', () => {
  const doc = dom('<div id="host"><table></table></div>');
  assert.equal(wrapTables(doc.querySelector('table')), 1);
  assert.equal(doc.querySelector('table').parentElement.className, 'tablescroll');
});

test('a table that already scrolls is left alone', () => {
  for (const cls of ['tablescroll', 'tablewrap', 'docs-tablewrap', 'inv-evidence']) {
    const doc = dom(`<div class="${cls}"><table></table></div>`);
    assert.equal(wrapTables(doc.body), 0, cls);
    assert.equal(doc.querySelectorAll('.tablescroll').length, cls === 'tablescroll' ? 1 : 0);
  }
});

// table-layout:fixed means it cannot overflow, and its sticky header would stop
// sticking if a scroll box became its containing scroller.
test('the contract DataTable opts out', () => {
  const doc = dom('<div><table class="dt"></table></div>');
  assert.equal(wrapTables(doc.body), 0);
  assert.equal(doc.querySelector('table').parentElement.className, '');
});

test('running twice wraps nothing a second time', () => {
  const doc = dom('<div><table></table><table></table></div>');
  assert.equal(wrapTables(doc.body), 2);
  assert.equal(wrapTables(doc.body), 0);
  assert.equal(doc.querySelectorAll('.tablescroll').length, 2);
});

test('a nested table is wrapped once, by its own box', () => {
  const doc = dom('<div><table><tr><td><table class="inner"></table></td></tr></table></div>');
  wrapTables(doc.body);
  // The outer table's box is the only one: the inner table is already inside it.
  assert.equal(doc.querySelectorAll('.tablescroll').length, 1);
  assert.ok(doc.querySelector('table:not(.inner)').parentElement.classList.contains('tablescroll'));
});

test('tables rendered later are wrapped too', async () => {
  const doc = dom('<main id="view"></main>');
  const view = doc.getElementById('view');
  const observer = startTableScrollGuard(view);
  assert.ok(observer, 'observer started');

  const panel = doc.createElement('div');
  panel.innerHTML = '<table><tr><td>late</td></tr></table>';
  view.appendChild(panel);
  await settle();

  assert.equal(doc.querySelectorAll('.tablescroll').length, 1);
  assert.equal(doc.querySelector('table').parentElement.className, 'tablescroll');
  observer.disconnect();
});

// The guard moves a table inside the tree it is watching, which is itself a
// mutation. Without the skip it would wrap its own wrapper, forever.
test('wrapping a table does not retrigger the guard', async () => {
  const doc = dom('<main id="view"></main>');
  const view = doc.getElementById('view');
  const observer = startTableScrollGuard(view);

  view.appendChild(doc.createElement('table'));
  await settle();
  await settle();

  assert.equal(doc.querySelectorAll('.tablescroll').length, 1);
  observer.disconnect();
});

test('a non-element node is ignored', () => {
  const doc = dom('<div></div>');
  assert.equal(wrapTables(doc.createTextNode('hello')), 0);
  assert.equal(wrapTables(null), 0);
});
