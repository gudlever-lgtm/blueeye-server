'use strict';

// public/ui.js — the UI contract's components (docs/ui-contract.md).
//
// The components are the contract in code, so the rules that can be checked are
// checked here rather than re-read per screen: at most one primary in a
// PageHeader, badges only for status, the chart's axis and legend rules, the
// Drawer's focus behaviour, and one time formatter.

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const Ui = require('../public/ui.js');
const I18n = require('../public/i18n.js');

// The DOM helper and the tab builder come from app.js in the browser; here they
// are the smallest fakes that behave the same, so the components are under test
// rather than app.js.
function mount() {
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  const { window } = dom;
  global.document = window.document;
  const el = (tag, attrs = {}, ...kids) => {
    const node = window.document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null) continue;
      node.append(kid.nodeType ? kid : window.document.createTextNode(String(kid)));
    }
    return node;
  };
  const tabStrip = (items, opts = {}) => el('div', { class: 'subtabs', role: 'tablist' },
    items.map(([key, label]) => el('button', {
      class: 'subtab', role: 'tab', 'data-tab': key,
      'aria-selected': String(key === opts.active),
    }, label)));
  const ui = Ui.create({
    el,
    t: (k, p) => I18n.t(k, p),
    plural: (k, n, p) => I18n.plural(k, n, p),
    tabStrip,
    getLocale: () => 'en',
    relativeTime: (v) => I18n.relativeTime(v),
  });
  return { ui, el, window, doc: window.document };
}

// ---------------------------------------------------------------- PageHeader
test('PageHeader: title, one line of lead, help behind (?), actions right', () => {
  const { ui, doc } = mount();
  const head = ui.pageHeader({
    title: 'Changes',
    lead: 'What happened since you last looked',
    help: { title: 'About Changes', body: () => [] },
    actions: [ui.button('secondary', 'Fleet grid'), ui.button('primary', 'Mark as seen')],
  });
  doc.body.append(head);
  assert.equal(head.querySelector('h1').textContent.replace('?', ''), 'Changes');
  assert.equal(head.querySelectorAll('p').length, 1, 'the lead is one line');
  assert.ok(head.querySelector('h1 .help-btn'), 'the (?) sits with the title');
  // The contract's hard rule, enforced where it can be.
  assert.equal(head.querySelectorAll('.page-head-actions .btn-primary').length, 1);
  assert.equal(head.querySelectorAll('.hero').length, 0, 'a PageHeader is never an info banner');
});

test('PageHeader: the (?) opens one popover, and Escape closes it', () => {
  const { ui, doc, window } = mount();
  const head = ui.pageHeader({
    title: 'Changes', lead: 'x',
    help: { title: 'About Changes', body: () => [ui.meta('the explanation')] },
  });
  doc.body.append(head);
  const btn = head.querySelector('.help-btn');
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(doc.querySelectorAll('.ui-popover').length, 1);
  assert.match(doc.querySelector('.ui-popover').textContent, /the explanation/);
  // A second press toggles it shut rather than stacking a second one.
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(doc.querySelectorAll('.ui-popover').length, 0);
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(doc.querySelectorAll('.ui-popover').length, 0, 'Escape leaves it open');
});

test('the (?) popover is placed where it FITS, and its body is what scrolls', () => {
  const { ui, doc, window } = mount();
  // A short window with the button near the bottom: the old code put the
  // popover at button.bottom + 8 and left the rest of the help text below the
  // fold, unreachable — no clamp, no scroll.
  Object.defineProperty(doc.documentElement, 'clientHeight', { value: 700, configurable: true });
  Object.defineProperty(doc.documentElement, 'clientWidth', { value: 1200, configurable: true });

  const head = ui.pageHeader({
    title: 'Discovery', lead: 'x',
    help: { title: 'About Discovery', body: () => [ui.meta('a very long explanation')] },
  });
  doc.body.append(head);
  const btn = head.querySelector('.help-btn');
  // Near the bottom edge, so "below the button" is 60px of room.
  btn.getBoundingClientRect = () => ({ top: 600, bottom: 624, left: 40, right: 64, width: 24, height: 24 });

  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  const pop = doc.querySelector('.ui-popover');
  assert.ok(pop, 'the popover has to open at all — a throw in placement used to swallow it');

  // Below the button there are 60px, above it 576: it flips rather than
  // hanging off the edge, and it is told how much room it actually has.
  // (jsdom has no layout, so offsetHeight reads 0 — the invariants asserted
  // here are the ones that do not depend on a measured height.)
  const top = parseFloat(pop.style.top);
  const maxH = parseFloat(pop.style.maxHeight);
  assert.ok(top >= 16, `clamped inside the top edge, got ${top}`);
  assert.ok(top <= 600 - 8, 'it should sit above a button this close to the bottom');
  assert.ok(maxH > 0 && maxH <= 600 - 8 - 16,
    `max-height has to be the room above, not more: ${maxH}`);

  // The head is outside the scroll region, so the close button cannot scroll
  // out of reach of somebody reading a long help text.
  assert.ok(pop.querySelector('.pop-head .pop-close'), 'the close button belongs to the fixed head');
  assert.ok(pop.querySelector('.pop-body'), 'the body is the part that scrolls');
  assert.equal(pop.querySelector('.pop-body').contains(pop.querySelector('.pop-close')), false);
});

test('with room below, the popover opens under the button and ends inside the window', () => {
  const { ui, doc, window } = mount();
  Object.defineProperty(doc.documentElement, 'clientHeight', { value: 900, configurable: true });
  Object.defineProperty(doc.documentElement, 'clientWidth', { value: 1200, configurable: true });

  const head = ui.pageHeader({ title: 'x', help: { title: 'h', body: () => [ui.meta('b')] } });
  doc.body.append(head);
  const btn = head.querySelector('.help-btn');
  btn.getBoundingClientRect = () => ({ top: 80, bottom: 104, left: 40, right: 64, width: 24, height: 24 });

  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  const pop = doc.querySelector('.ui-popover');
  const top = parseFloat(pop.style.top);
  const maxH = parseFloat(pop.style.maxHeight);
  assert.equal(top, 112, 'under the button, with the gap');
  assert.equal(top + maxH, 900 - 16, 'the tallest it may grow still ends inside the window');
});

test('the popover is clamped inside the right edge too', () => {
  const { ui, doc, window } = mount();
  Object.defineProperty(doc.documentElement, 'clientHeight', { value: 900, configurable: true });
  Object.defineProperty(doc.documentElement, 'clientWidth', { value: 500, configurable: true });

  const head = ui.pageHeader({ title: 'x', help: { title: 'h', body: () => [ui.meta('b')] } });
  doc.body.append(head);
  const btn = head.querySelector('.help-btn');
  btn.getBoundingClientRect = () => ({ top: 100, bottom: 124, left: 460, right: 484, width: 24, height: 24 });

  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  const left = parseFloat(doc.querySelector('.ui-popover').style.left);
  assert.ok(left >= 16, `clamped inside the left edge, got ${left}`);
  assert.ok(left <= 484, 'a button at the right edge must not push the popover off it');
});

// ---------------------------------------------------------------- Badge
test('Badge carries only the status tones; metadata is muted text', () => {
  const { ui } = mount();
  for (const tone of ['crit', 'warn', 'info', 'ok', 'neutral']) {
    assert.ok(ui.badge(tone, 'X').classList.contains(tone), tone);
  }
  // The contract's other half: a count is text, so it cannot be mistaken for
  // a state the way a chip is.
  const m = ui.meta('135×');
  assert.equal(m.className, 'meta');
  assert.equal(m.tagName, 'SPAN');
  assert.ok(!m.classList.contains('badge-ui'));
});

test('HostLink is a link in its own right, and does not open the row under it', () => {
  const { ui, window } = mount();
  let opened = 0;
  let rowClicks = 0;
  const link = ui.hostLink('oslo-edge-01', () => { opened++; });
  const row = ui.page(link);
  row.addEventListener('click', () => { rowClicks++; });
  assert.equal(link.tagName, 'A');
  link.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(opened, 1);
  assert.equal(rowClicks, 0, 'the host link must not also open the row');
});

// ---------------------------------------------------------------- DataTable
function sampleTable(ui, over = {}) {
  return ui.dataTable(Object.assign({
    columns: [
      { key: 'time', label: 'Time', width: '136px', sortable: true, time: true },
      { key: 'host', label: 'Host' },
      { key: 'n', label: 'Repeats', num: true, sortable: true },
    ],
    rows: [
      { id: 1, cells: { time: '12/09, 14:02', host: 'a', n: '3×' } },
      { id: 2, cells: { time: '12/09, 13:58', host: 'b', n: '—' }, dimmed: true },
    ],
    sort: { key: 'time', dir: 'desc' },
    onSort: () => {},
  }, over));
}

test('DataTable is a real table: fixed columns, sticky-capable header, sortable headers', () => {
  const { ui } = mount();
  const wrap = sampleTable(ui);
  const table = wrap.querySelector('table.dt');
  assert.ok(table, 'not a <table>');
  assert.equal(table.querySelectorAll('colgroup col').length, 3, 'columns are not fixed');
  assert.equal(table.querySelector('th[aria-sort]').getAttribute('aria-sort'), 'descending');
  assert.equal(table.querySelectorAll('th.col-num').length, 1);
  assert.equal(table.querySelectorAll('td.col-num').length, 2);
  assert.equal(table.querySelector('td.col-time').textContent, '12/09, 14:02');
});

test('DataTable: a row opens the Drawer, a dimmed row does not, and neither is a button', () => {
  const { ui, window } = mount();
  const opened = [];
  const wrap = sampleTable(ui, { onOpen: (row) => opened.push(row.id) });
  const rows = [...wrap.querySelectorAll('tbody tr')];
  assert.equal(rows[0].getAttribute('tabindex'), '0', 'an openable row is reachable by keyboard');
  assert.equal(rows[1].getAttribute('tabindex'), null, 'a dimmed row is not a target');
  rows[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  rows[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual(opened, [1]);
  // Enter and Space open it too — that is what the tabindex is for.
  rows[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(opened, [1, 1]);
});

test('row actions: one primary on hover, everything else behind the ⋯ menu', () => {
  const { ui, doc, window } = mount();
  let acked = 0;
  let muted = 0;
  const cell = ui.rowActions(
    { label: 'Acknowledge', onclick: () => { acked++; } },
    [{ label: 'Open', onclick: () => {} }, '-', { label: 'Mute', danger: true, onclick: () => { muted++; } }],
  );
  doc.body.append(cell);
  assert.equal(cell.querySelectorAll('.btn').length, 2, 'a row shows one action plus the menu');
  assert.ok(cell.querySelector('.on-hover'), 'the primary is the hover one');
  cell.querySelector('.on-hover').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(acked, 1);

  cell.querySelector('[aria-haspopup="menu"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  const menu = doc.querySelector('.ui-rowmenu');
  assert.ok(menu, 'the ⋯ opened nothing');
  assert.equal(menu.querySelectorAll('button').length, 2);
  assert.ok(menu.querySelector('button.danger'), 'the destructive item is marked');
  menu.querySelector('button.danger').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(muted, 1);
  assert.equal(doc.querySelector('.ui-rowmenu'), null, 'the menu stayed open after a choice');
});

// ---------------------------------------------------------------- Drawer
test('Drawer: 480px right panel, header with title + status + close, Escape closes', () => {
  const { ui, doc, window } = mount();
  const row = ui.page();
  row.setAttribute('aria-selected', 'false');
  ui.openDrawer({
    title: 'Latency tripled',
    status: ui.badge('crit', 'CRITICAL'),
    meta: '12/09/2026, 14:02',
    row,
    sections: [ui.drawerSection('What happened', ui.meta('it went up'))],
    footer: ui.drawerFooter([], [ui.button('primary', 'Acknowledge')]),
  });
  const drawer = doc.querySelector('.ui-drawer');
  assert.ok(drawer);
  assert.ok(drawer.classList.contains('ui'), 'the overlay must carry the component scope');
  assert.equal(drawer.getAttribute('role'), 'dialog');
  assert.equal(drawer.getAttribute('aria-modal'), 'true');
  assert.ok(drawer.querySelector('.drawer-head .badge-ui.crit'));
  assert.ok(doc.querySelector('.ui-scrim'), 'no scrim behind the drawer');
  assert.equal(row.getAttribute('aria-selected'), 'true', 'the open row is not marked');

  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(doc.querySelector('.ui-drawer'), null);
  assert.equal(doc.querySelector('.ui-scrim'), null);
  assert.equal(row.getAttribute('aria-selected'), 'false', 'the row stayed marked after close');
});

test('Drawer: opening a second one replaces the first', () => {
  const { ui, doc } = mount();
  ui.openDrawer({ title: 'One', sections: [] });
  ui.openDrawer({ title: 'Two', sections: [] });
  assert.equal(doc.querySelectorAll('.ui-drawer').length, 1);
  assert.equal(doc.querySelector('.ui-drawer h2').textContent, 'Two');
  ui.closeDrawer();
});

// ---------------------------------------------------------------- FormSection
test('FormSection: label above, hint under, error under in the crit colour, max two columns', () => {
  const { ui, el } = mount();
  const sec = ui.formSection({
    title: 'From where, and to what',
    hint: 'The test runs from the agent.',
    fields: [
      ui.field({ id: 'a', label: 'Agent', control: el('select', { id: 'a' }), hint: 'online' }),
      ui.field({ id: 'b', label: 'Target', control: el('input', { id: 'b' }), error: 'Enter an address.' }),
    ],
  });
  const fields = [...sec.querySelectorAll('.f')];
  assert.equal(fields.length, 2);
  for (const f of fields) {
    const kids = [...f.children].map((n) => n.tagName + '.' + n.className);
    assert.equal(kids[0], 'LABEL.', 'the label is not first');
  }
  assert.equal(fields[0].querySelector('label').getAttribute('for'), 'a');
  assert.equal(fields[1].querySelector('.field-error').textContent, 'Enter an address.');
  assert.equal(fields[1].querySelector('input').getAttribute('aria-invalid'), 'true',
    'a field with an error must say so to a screen reader too');
});

// ---------------------------------------------------------------- States
test('states: Empty, Loading and Error are the same three everywhere', () => {
  const { ui } = mount();
  const empty = ui.emptyState({ title: 'Nothing here', body: 'and that is the answer' });
  assert.ok(empty.classList.contains('state'));
  assert.equal(empty.classList.contains('is-error'), false);

  const loading = ui.loadingState(3);
  assert.equal(loading.querySelectorAll('.skel-row').length, 3);
  assert.equal(loading.getAttribute('aria-busy'), 'true');

  let retried = 0;
  const err = ui.errorState({ detail: 'GET /api/changes', onRetry: () => { retried++; } });
  assert.ok(err.classList.contains('is-error'));
  assert.match(err.textContent, /GET \/api\/changes/, 'an ErrorState says what failed');
  assert.ok(err.querySelector('.btn'), 'an ErrorState always offers a retry');
  err.querySelector('.btn').click();
  assert.equal(retried, 1);
});

// ------------------------------------------------------- Empty state kinds
test('EmptyState: "no data" is a red minus with a way out, not a green tick', () => {
  const { ui } = mount();
  const none = ui.emptyState({ kind: 'nodata', title: 'No flows' });
  assert.ok(none.classList.contains('is-nodata'));
  assert.notEqual(none.querySelector('.state-ico').textContent, '✓',
    'an empty result is not an achievement — a tick reads as "all good"');
  assert.match(none.textContent, /time range|agent/i,
    'an empty result must say what to try next');

  // A tick is still right where empty IS the good news.
  const ok = ui.emptyState({ kind: 'ok', title: 'No faults found' });
  assert.equal(ok.querySelector('.state-ico').textContent, '✓');
  assert.ok(ok.classList.contains('is-ok'));
});

// ---------------------------------------------------------------- Toast
test('Toast: top right, stacked, and an error stays until it is dismissed', async () => {
  const { ui, doc } = mount();
  ui.toast('Saved', 'the good kind');
  ui.toast('Failed', 'the bad kind', { bad: true });
  const host = doc.getElementById('ui-toasts');
  assert.ok(host.classList.contains('ui'), 'the toast host must carry the component scope');
  assert.equal(host.querySelectorAll('.ui-toast').length, 2, 'toasts do not stack');
  assert.equal(host.querySelectorAll('.ui-toast.err').length, 1);
  host.querySelector('.ui-toast.err .btn').click();
  assert.equal(host.querySelectorAll('.ui-toast.err').length, 0);
});

test('Toast: the same message twice is one message, not a growing stack', () => {
  const { ui, doc } = mount();
  for (let i = 0; i < 5; i++) ui.toast('Pick an agent', null, { bad: true });
  const host = doc.getElementById('ui-toasts');
  assert.equal(host.querySelectorAll('.ui-toast').length, 1,
    'clicking a button five times must not stack five identical complaints');
  ui.toast('Pick a target', null, { bad: true });
  assert.equal(host.querySelectorAll('.ui-toast').length, 2, 'a DIFFERENT message is still its own toast');
});

test('Toast: an error goes away on its own, and never buries the page', async () => {
  const { ui, doc } = mount();
  const host = () => doc.getElementById('ui-toasts');
  ui.toast('Failed', 'one', { bad: true, ttlMs: 20 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(host().querySelectorAll('.ui-toast').length, 0,
    'an error that nobody dismissed must not sit on the page forever');

  for (let i = 0; i < 7; i++) ui.toast(`Failed ${i}`, null, { bad: true });
  assert.ok(host().querySelectorAll('.ui-toast').length <= 4, 'the stack is capped');
});

test('Toast: a "pick something" alert focuses and rings the field it means', () => {
  const { ui, doc } = mount();
  const field = doc.createElement('select');
  doc.body.append(field);
  ui.toast('Pick an agent', null, { bad: true, focus: field });
  assert.equal(doc.activeElement, field, 'the alert did not put the cursor in the field');
  assert.ok(field.classList.contains('is-asked'), 'the field is not marked');
  field.dispatchEvent(new doc.defaultView.Event('change'));
  assert.ok(!field.classList.contains('is-asked'), 'the ring must clear once the field is touched');
});

// ---------------------------------------------------------------- Chart
test('chart axis: whole numbers when the data is whole, stepping by 1 up to 10', () => {
  const { ui } = mount();
  assert.deepEqual(ui.axisTicks(3, true), [0, 1, 2, 3], 'a max of 3 gets every whole number');
  assert.deepEqual(ui.axisTicks(1, true), [0, 1], 'a max of 1 must not produce two identical lines');
  assert.deepEqual(ui.axisTicks(10, true), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // Above 10 it steps by a round number instead, and never repeats a label.
  const big = ui.axisTicks(47, true);
  assert.ok(big.length >= 3 && big.length <= 7, `unreadable axis: ${big.join(',')}`);
  assert.deepEqual(big, [...new Set(big)], 'a repeated tick is two lines in one place');
  assert.ok(big[big.length - 1] >= 47, 'the axis must reach the data');
  assert.ok(big.every(Number.isInteger), 'integer data must not get fractional labels');
  // Fractional data keeps its precision rather than being rounded into a lie.
  assert.ok(ui.axisTicks(2.4, false).some((v) => !Number.isInteger(v)) || ui.axisTicks(2.4, false).includes(2.5));
});

test('chart: the legend is under the plot and always drawn, and few points become bars', () => {
  const { ui } = mount();
  const four = ui.chart({
    title: 'Runs',
    series: [
      { label: 'passed', points: [{ y: 3 }, { y: 1 }, { y: 4 }, { y: 2 }] },
      { label: 'failed', points: [{ y: 0 }, { y: 2 }, { y: 0 }, { y: 1 }] },
    ],
  });
  const kids = [...four.children].map((n) => n.className);
  assert.deepEqual(kids, ['ui-chart-plot', 'ui-chart-legend'], 'the legend belongs under the plot');
  assert.equal(four.querySelectorAll('.ui-legend-item').length, 2, 'every series is named');
  assert.ok(four.querySelectorAll('rect.ui-chart-bar').length > 0, 'four points should be bars, not a line');
  assert.equal(four.querySelectorAll('path.ui-chart-line').length, 0);

  const many = ui.chart({
    series: [{ label: 'rtt', points: Array.from({ length: 40 }, (_, i) => ({ y: i })) }],
  });
  assert.equal(many.querySelectorAll('path.ui-chart-line').length, 1, 'forty points should be a line');
  // Every axis label names a value the chart actually reaches.
  const yLabels = [...many.querySelectorAll('.ui-chart-axis')]
    .map((n) => Number(n.textContent)).filter((n) => !Number.isNaN(n));
  assert.ok(Math.max(...yLabels) >= 39, 'the axis stops short of the data');
});

test('chart: no series is an EmptyState, not an empty box', () => {
  const { ui } = mount();
  const node = ui.chart({ series: [] });
  assert.ok(node.classList.contains('state'));
});

// ---------------------------------------------------------------- Time
test('one time formatter: three shapes, one source, and nothing renders as Invalid Date', () => {
  const { ui } = mount();
  const iso = '2026-09-12T14:02:33.000Z';
  assert.match(ui.fmt.short(iso), /^\d{2}\/\d{2}, \d{2}:\d{2}$/, ui.fmt.short(iso));
  assert.ok(ui.fmt.abs(iso).includes('2026'), 'the full form carries the year');
  assert.match(ui.fmt.clock(iso), /^\d{2}:\d{2}:\d{2}$/);
  for (const bad of [null, undefined, '', 'not a date', NaN]) {
    for (const shape of ['abs', 'short', 'clock']) {
      assert.equal(ui.fmt[shape](bad), '—', `${shape}(${String(bad)})`);
    }
  }
  assert.equal(ui.fmt.duration(740), '740 ms');
  assert.equal(ui.fmt.duration(1400), '1.4 s');
  assert.equal(ui.fmt.duration(90000), '2 min');
  assert.equal(ui.fmt.duration('nope'), '—');
});

// ---------------------------------------------------------------- Scope
test('every body-level overlay carries the `ui` marker, or it loses its styling', () => {
  const { ui, doc } = mount();
  // The Drawer, the popover, the row menu and the toast host are appended to
  // <body>, outside the page root — without the marker a button in them falls
  // back to the legacy `button` rule and renders as a filled accent button.
  ui.openDrawer({ title: 'x', sections: [] });
  ui.rowActions(null, [{ label: 'a', onclick: () => {} }]);
  ui.toast('x');
  const head = ui.pageHeader({ title: 'x', lead: 'y', help: { title: 'h', body: () => [] } });
  doc.body.append(head);
  head.querySelector('.help-btn').click();

  for (const sel of ['.ui-drawer', '.ui-scrim', '.ui-popover', '.ui-toasts']) {
    const node = doc.querySelector(sel);
    assert.ok(node, `${sel} not created`);
    assert.ok(node.classList.contains('ui'), `${sel} is outside the component scope`);
  }
  ui.closeOverlays();
  assert.equal(doc.querySelector('.ui-drawer'), null, 'closeOverlays left the drawer behind');
  assert.equal(doc.querySelector('.ui-popover'), null, 'closeOverlays left the popover behind');
});

// ------------------------------------------------------- Row menu placement
test('the row menu stays inside the window instead of running off the right edge', () => {
  const { ui, doc } = mount();
  const win = doc.defaultView;
  Object.defineProperty(win, 'innerWidth', { value: 1200, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: 800, configurable: true });
  // jsdom lays nothing out, so the menu would measure 0x0 and every clamp would
  // trivially pass. Give every element the size the stylesheet gives this one.
  Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { value: 260, configurable: true });
  Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { value: 180, configurable: true });

  // A ⋯ button hard against the right edge and near the bottom, which is where
  // it sits in the last column of the last row.
  const cell = ui.rowActions(null, [{ label: 'Acknowledge', onclick: () => {} }]);
  doc.body.append(cell);
  const trigger = cell.querySelector('[aria-haspopup="menu"]');
  assert.ok(trigger, 'the ⋯ trigger is missing');
  trigger.getBoundingClientRect = () => ({ top: 760, bottom: 780, left: 1170, right: 1190, width: 20, height: 20 });
  trigger.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));

  const menu = doc.querySelector('.ui-rowmenu');
  assert.ok(menu, 'no menu opened');
  const left = parseInt(menu.style.left, 10);
  const top = parseInt(menu.style.top, 10);
  assert.ok(left >= 8, `the menu starts off-screen at ${left}px`);
  assert.ok(left + 260 <= 1200, `the menu runs off the right edge (left ${left})`);
  assert.ok(top >= 8, `the menu is above the window (top ${top})`);
  assert.ok(top + 180 <= 800, `the menu runs past the bottom (top ${top})`);
  assert.ok(top < 760, 'with no room below, the menu must flip above the trigger');
});

// ---------------------------------------------------------------- ModeSwitch
// Two lenses on one screen. The rules worth pinning are the ones a screen can
// get wrong on its own: exactly one half is pressed, the choice is remembered
// PER SCREEN (so Troubleshooting's graph and Sites' table can both be the
// default), and a stored key that no longer exists falls back instead of
// drawing a pane that is gone.
function withStorage(window) {
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return global.localStorage;
}

test('ModeSwitch: one pressed half, a label and an icon on each', () => {
  const { ui, doc, window } = mount();
  withStorage(window);
  const sw = ui.modeSwitch({
    label: 'View',
    value: 'evidence',
    items: [
      { key: 'explain', label: 'Explanation', icon: 'explain' },
      { key: 'evidence', label: 'Evidence', icon: 'evidence' },
    ],
  });
  doc.body.append(sw);
  const btns = [...sw.querySelectorAll('.mode-btn')];
  assert.equal(btns.length, 2);
  assert.equal(sw.getAttribute('role'), 'group');
  assert.equal(sw.getAttribute('aria-label'), 'View');
  assert.equal(sw.querySelectorAll('[aria-pressed="true"]').length, 1, 'exactly one half is on');
  assert.equal(btns[1].getAttribute('aria-pressed'), 'true', 'the value decides which');
  // Text AND icon: the icon alone makes "Evidence" a guess.
  assert.equal(btns[0].querySelector('.mode-label').textContent, 'Explanation');
  assert.ok(btns[0].querySelector('svg.mode-ico'), 'each half carries its icon');
});

test('ModeSwitch: a click moves the pressed state and reports the new key once', () => {
  const { ui, doc, window } = mount();
  withStorage(window);
  const seen = [];
  const sw = ui.modeSwitch({
    value: 'graph',
    items: [{ key: 'graph', label: 'Graph', icon: 'graph' }, { key: 'list', label: 'List', icon: 'list' }],
    onchange: (k) => seen.push(k),
  });
  doc.body.append(sw);
  const [graph, list] = [...sw.querySelectorAll('.mode-btn')];
  list.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(seen, ['list']);
  assert.equal(list.getAttribute('aria-pressed'), 'true');
  assert.equal(graph.getAttribute('aria-pressed'), 'false');
  // Pressing the half that is already on is not a change — a screen that
  // redrew here would throw the reader's scroll position away for nothing.
  list.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(seen, ['list']);
});

test('ModeSwitch: the choice is remembered per screen, not globally', () => {
  const { ui, doc, window } = mount();
  withStorage(window);
  const sw = ui.modeSwitch({
    store: 'sites',
    value: 'map',
    items: [{ key: 'map', label: 'Map', icon: 'map' }, { key: 'list', label: 'List', icon: 'list' }],
  });
  doc.body.append(sw);
  sw.querySelectorAll('.mode-btn')[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(ui.storedMode('sites', ['map', 'list'], 'map'), 'list');
  // Another screen is untouched: that is the whole point of the per-screen key.
  assert.equal(ui.storedMode('troubleshooting', ['graph', 'list'], 'graph'), 'graph');
});

test('ModeSwitch: an unknown or stale stored key falls back to the default', () => {
  const { ui, window } = mount();
  const storage = withStorage(window);
  storage.setItem('blueeye.mode.analysis', 'evidence');
  assert.equal(ui.storedMode('analysis', ['explain', 'evidence'], 'explain'), 'evidence');
  // A key an older build wrote, for a pane this one no longer has.
  storage.setItem('blueeye.mode.analysis', 'raw');
  assert.equal(ui.storedMode('analysis', ['explain', 'evidence'], 'explain'), 'explain');
  // Storage switched off entirely is the ordinary private-window case, not an
  // error: the screen opens on its default.
  delete global.localStorage;
  assert.equal(ui.storedMode('analysis', ['explain', 'evidence'], 'explain'), 'explain');
});

test('ModeSwitch: left and right move between the halves', () => {
  const { ui, doc, window } = mount();
  withStorage(window);
  const seen = [];
  const sw = ui.modeSwitch({
    value: 'doc',
    items: [{ key: 'doc', label: 'Document', icon: 'doc' }, { key: 'data', label: 'Data', icon: 'data' }],
    onchange: (k) => seen.push(k),
  });
  doc.body.append(sw);
  const [first] = [...sw.querySelectorAll('.mode-btn')];
  first.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.deepEqual(seen, ['data']);
  assert.equal(sw.querySelectorAll('[aria-pressed="true"]').length, 1);
});

// ---- headerMode / reveal ----------------------------------------------------
// The switch lives in the topbar now (docs/ui-contract.md → ModeSwitch): on
// every screen that has one, the lens it re-draws is below the fold, and a
// control whose effect you cannot see reads as a broken control.

test('headerMode: the switch is mounted in the topbar slot, not where it was built', () => {
  const { ui, doc, window } = mount();
  withStorage(window);
  const slot = doc.createElement('div');
  slot.id = 'topbar-mode';
  doc.body.append(slot);
  ui.headerMode({
    store: 'analysis',
    value: 'explain',
    items: [{ key: 'explain', label: 'Explanation', icon: 'explain' }, { key: 'evidence', label: 'Evidence', icon: 'evidence' }],
  });
  assert.equal(slot.querySelectorAll('.mode-switch').length, 1, 'the switch went into the topbar');
  // A second screen replaces it rather than stacking a second switch.
  ui.headerMode({
    store: 'sites',
    value: 'map',
    items: [{ key: 'map', label: 'Map', icon: 'map' }, { key: 'list', label: 'List', icon: 'list' }],
  });
  assert.equal(slot.querySelectorAll('.mode-switch').length, 1, 'one screen, one switch');
  assert.ok(slot.querySelector('.mode-btn[data-mode="map"]'), 'the newest screen owns the slot');
  ui.clearHeaderMode();
  assert.equal(slot.children.length, 0, 'navigation leaves no stale switch behind');
});

test('headerMode: a page with no slot still builds (nothing throws)', () => {
  const { ui, window } = mount();
  withStorage(window);
  const sw = ui.headerMode({
    value: 'map',
    items: [{ key: 'map', label: 'Map', icon: 'map' }, { key: 'list', label: 'List', icon: 'list' }],
  });
  assert.ok(sw.querySelector('.mode-btn'), 'the switch is still returned to the caller');
});

test('reveal: an off-screen lens is scrolled to and flashed; a visible one is left alone', () => {
  const { ui, doc, window } = mount();
  withStorage(window);
  const slot = doc.createElement('div');
  slot.id = 'topbar-mode';
  doc.body.append(slot);
  const lens = doc.createElement('div');
  doc.body.append(lens);
  const scrolled = [];
  lens.scrollIntoView = (opts) => scrolled.push(opts);

  // Off-screen: jsdom gives every element a zero rect, so the rect is scripted.
  let rect = { top: 2000, bottom: 2600, height: 600 };
  lens.getBoundingClientRect = () => rect;
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

  const sw = ui.headerMode({
    value: 'explain',
    items: [{ key: 'explain', label: 'Explanation', icon: 'explain' }, { key: 'evidence', label: 'Evidence', icon: 'evidence' }],
    reveal: () => lens,
  });
  sw.querySelector('.mode-btn[data-mode="evidence"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(scrolled.length, 1, 'the part that changed was brought on screen');
  assert.ok(lens.classList.contains('reveal-flash'), 'and says which part it was');

  // Already on screen: the reader is looking at the change, so nothing jumps.
  lens.classList.remove('reveal-flash');
  rect = { top: 40, bottom: 640, height: 600 };
  sw.querySelector('.mode-btn[data-mode="explain"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(scrolled.length, 1, 'a visible lens is not scrolled');
  assert.equal(lens.classList.contains('reveal-flash'), false);
});
