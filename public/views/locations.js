// public/views/locations.js — Locations, as a ListPage (template A).
//
// The sites the estate is organised by: a row per location, what it is called,
// what it is for, and everything you can do with it. Built from the contract's
// components (public/ui.js, docs/ui-contract.md).
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

    function view() {
      var page = ui.page();
      var host = el('div', {});

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('loc.title'),
        lead: t('loc.lead'),
        help: { title: info.title, body: info.body },
        actions: [deps.canWrite()
          ? ui.button('primary', t('loc.new'), { onclick: function () { deps.edit(); } })
          : null],
      }), host);

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

      return load().then(function () { return page; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.LocationsPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
