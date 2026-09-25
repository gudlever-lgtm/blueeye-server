// public/views/locations.js — the site register: the Register tab of Sites.
//
// The sites the estate is organised by: a row per site, what it is called, what
// it is for, and everything you can do with it. Built from the contract's
// components (public/ui.js, docs/ui-contract.md).
//
// It used to be a screen of its own under Administration, opposite a map under
// Monitoring, each carrying a button pointing at the other. Two halves of one
// screen that knew it — so this is the half with the records in it, hosted by
// public/views/sites.js (docs/fleet-and-sites-consolidation.md). It exports a
// BODY rather than a page: the header, the tabs and the help belong to the
// screen, and only one of them may own those.
//
// What this migration changes:
//   * SIX buttons in every row's last cell — Open, Traffic, History, AI status,
//     Edit, Delete — with Delete one mis-click from Edit. The row opens the
//     location (that is what a row does), Edit is the row's action on hover, and
//     the rest are behind the ⋯ menu with Delete marked destructive and last;
//   * "No locations." was a grey sentence that did not say what to do about it.
//     An empty estate is the first thing a new install sees, so it offers the
//     button that fixes it;
//   * a failed load used to take the page down with it. It is an ErrorState
//     naming the call, with a Retry.
//
// The three panels the row actions open (live traffic, history, the AI summary)
// are NOT migrated — they are modals with their own polling and charts.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    // Returns the node straight away and fills it when the read lands: the
    // screen that hosts it is already on the page, so it must not wait.
    function body() {
      var host = el('div', {});

      function rowMenu(l) {
        return [
          { label: t('loc.act.traffic'), onclick: function () { deps.traffic(l); } },
          { label: t('loc.act.history'), onclick: function () { deps.history(l); } },
          deps.hasAssistant() ? { label: t('loc.act.ai'), onclick: function () { deps.summary(l); } } : null,
          deps.canDelete() ? '-' : null,
          deps.canDelete() ? { label: t('loc.act.delete'), danger: true, onclick: function () { deps.remove(l); } } : null,
        ].filter(Boolean);
      }

      function toRow(l) {
        return {
          l: l,
          cells: {
            id: ui.meta(String(l.id)),
            name: ui.hostLink(l.name, function () { deps.open(l.id); }),
            description: l.description ? l.description : ui.meta('–'),
            act: ui.rowActions(
              deps.canWrite() ? { label: t('loc.act.edit'), onclick: function () { deps.edit(l); } } : null,
              rowMenu(l)),
          },
        };
      }

      function draw(locations) {
        if (!locations.length) {
          host.replaceChildren(ui.panel({
            title: t('loc.panel'),
            children: [ui.emptyState({
              icon: '◎',
              title: t('loc.none'),
              body: t('loc.noneHint'),
              action: deps.canWrite()
                ? ui.button('primary', t('loc.new'), { onclick: function () { deps.edit(); } })
                : null,
            })],
          }));
          return;
        }
        host.replaceChildren(ui.panel({
          title: t('loc.panel'),
          note: t('loc.count', { n: locations.length }),
          children: [ui.dataTable({
            columns: [
              { key: 'id', label: t('loc.col.id'), width: '72px', num: true },
              { key: 'name', label: t('loc.col.name'), width: '260px' },
              { key: 'description', label: t('loc.col.description') },
              { key: 'act', label: '', width: '112px' },
            ],
            rows: locations.map(toRow),
            onOpen: function (row) { deps.open(row.l.id); },
          })],
        }));
      }

      function load() {
        host.replaceChildren(ui.panel({ title: t('loc.panel'), children: [ui.loadingState(5)] }));
        return deps.fetchAll()
          .then(function (rows) { draw(rows || []); })
          .catch(function (e) {
            host.replaceChildren(ui.panel({
              title: t('loc.panel'),
              children: [ui.errorState({
                title: t('loc.err.title'),
                body: deps.errText(e),
                detail: 'GET /locations',
                onRetry: load,
              })],
            }));
          });
      }

      load();
      return host;
    }

    return { body: body };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.LocationsPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
