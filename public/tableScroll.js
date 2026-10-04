// public/tableScroll.js — every table gets a scroll box, whether or not its
// screen remembered to ask for one.
//
// A table is as wide as its data and a phone is 360px wide, so a wide one used
// to push the whole DOCUMENT sideways: the sidebar, the topbar and the left
// edge of every other card scrolled off with it. A card whose first column sits
// outside the screen is this — not a broken card.
//
// `.tablewrap` has always been the fix, and sixteen of the ninety-odd tables in
// this dashboard use it. The rest do not, and a convention nobody can see is one
// that is already broken. So this does not ask: it watches what gets rendered —
// views, modals, drawers, the Service Assurance module's own async mounts — and
// drops a styleless `.tablescroll` box around any table that is not already in
// one. A screen written next month is covered without its author knowing this
// file exists.
//
// Cheap by construction: it only walks nodes as they are added, and a table
// already inside a scroll box is skipped, so moving the table — which mutates
// the very tree this observer watches — cannot loop.

(function (root) {
  'use strict';

  // Containers that already scroll. Wrapping inside one of these would add a
  // second scroll axis around the first.
  var SKIP = '.tablescroll, .tablewrap, .docs-tablewrap, .inv-evidence';

  // `table.dt` — the contract's DataTable (ui.js) — opts out, for two reasons
  // that both say leave it alone: it is `table-layout: fixed; width: 100%`, so
  // it can never be wider than the space it is given, and its header is
  // `position: sticky`. A scroll box would become that header's containing
  // scroller and the header would stop sticking to the viewport — a fix for an
  // overflow it does not have, paid for with a feature it does.
  var EXEMPT = 'table.dt';

  function wrapTables(node) {
    if (!node || node.nodeType !== 1) return 0;
    var tables = [];
    if (node.matches && node.matches('table')) tables.push(node);
    if (node.querySelectorAll) {
      Array.prototype.push.apply(tables, node.querySelectorAll('table'));
    }
    var wrapped = 0;
    for (var i = 0; i < tables.length; i += 1) {
      var table = tables[i];
      if (table.matches(EXEMPT)) continue;
      if (table.closest(SKIP)) continue;
      var parent = table.parentNode;
      if (!parent) continue;
      var box = table.ownerDocument.createElement('div');
      box.className = 'tablescroll';
      parent.insertBefore(box, table);
      box.appendChild(table);
      wrapped += 1;
    }
    return wrapped;
  }

  // Wrap what is already there, then keep wrapping what arrives. Returns the
  // observer so a caller (a test, a teardown) can disconnect it.
  function startTableScrollGuard(target) {
    var el = target || (root.document && root.document.body);
    if (!el) return null;
    wrapTables(el);
    var Observer = (el.ownerDocument && el.ownerDocument.defaultView
      && el.ownerDocument.defaultView.MutationObserver) || root.MutationObserver;
    if (typeof Observer !== 'function') return null;
    var observer = new Observer(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j += 1) wrapTables(added[j]);
      }
    });
    observer.observe(el, { childList: true, subtree: true });
    return observer;
  }

  var api = { wrapTables: wrapTables, startTableScrollGuard: startTableScrollGuard };
  root.tableScroll = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
