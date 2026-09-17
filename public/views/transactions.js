// public/views/transactions.js — Transaction tests, as a ListPage (template A).
//
// A transaction test runs http/tcp/dns/icmp from assigned agents on an
// interval; this is where they are listed, created and read. Built from the
// contract's components (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * the heading with a loose "+ New test" button beside it becomes a
//     PageHeader with one primary action and the (?) popover;
//   * the list becomes a sortable DataTable. Edit and Delete were two buttons
//     in every row's last cell — Edit is the row's one action and Delete is
//     behind the ⋯ menu, where a destructive action belongs;
//   * `chip` carrying the test type becomes a Badge, and "Active / Disabled"
//     becomes a Badge too — it is a state, which is what a Badge is for.
//
// A SHELL MIGRATION, like Probes & Tests. The create/edit form (a multi-step
// http editor with secrets and agent assignment), the matrix and the per-test
// detail with its heatmap and trend are ~350 lines between them and each
// carries its own machinery. They are passed in whole and migrate in their own
// commits; `ui:check` holds this file to the contract meanwhile.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var TABS = ['list', 'matrix'];
    // A first click on a number sorts high-first, on text A-first. Both are
    // what the reader is asking for when they click that particular column.
    var NUMERIC = { agents: 1, interval: 1, status: 1 };

    function view() {
      var state = deps.state;
      if (!state.sort) state.sort = { key: 'name', dir: 'asc' };

      var page = ui.page();
      var body = el('div', {});

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('tx.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
        actions: [deps.isAdmin()
          ? ui.button('primary', t('tx.new'), { onclick: function () { deps.mount(body, function () { return deps.form(null, body); }); } })
          : null],
      }), ui.tabs(TABS.map(function (k) { return [k, t('tx.tab.' + k)]; }), {
        active: deps.tab(),
        ariaLabel: t('tx.title'),
        onPick: function (k) { deps.setTab(k); draw(); },
      }), body);

      function draw() {
        if (deps.tab() === 'matrix') deps.mount(body, function () { return deps.matrix(body); });
        else deps.mount(body, function () { return list(body); });
      }

      // ---- the list ----------------------------------------------------------
      function list(host) {
        return deps.fetchTests().then(function (tests) {
          if (!tests.length) {
            return ui.panel({
              title: t('tx.panel'),
              children: [ui.emptyState({
                title: t('tx.none'),
                body: t('tx.noneHint'),
                action: deps.isAdmin()
                  ? ui.button('primary', t('tx.new'), { onclick: function () { deps.mount(host, function () { return deps.form(null, host); }); } })
                  : null,
              })],
            });
          }
          var dir = state.sort.dir === 'asc' ? 1 : -1;
          var read = {
            name: function (x) { return String(x.name || '').toLowerCase(); },
            type: function (x) { return String(x.type || ''); },
            target: function (x) { return String(x.target || '').toLowerCase(); },
            agents: function (x) { return (x.agent_ids || []).length; },
            interval: function (x) { return Number(x.interval_sec) || 0; },
            status: function (x) { return x.enabled ? 1 : 0; },
          }[state.sort.key];
          var rows = read ? tests.slice().sort(function (x, y) {
            var a = read(x);
            var b = read(y);
            if (a < b) return -1 * dir;
            if (a > b) return 1 * dir;
            return 0;
          }) : tests;

          return ui.panel({
            title: t('tx.panel'),
            note: t('tx.count', { n: tests.length }),
            children: [ui.dataTable({
              columns: [
                { key: 'name', label: t('tx.col.name'), width: '240px', sortable: true },
                { key: 'type', label: t('tx.col.type'), width: '110px', sortable: true },
                { key: 'target', label: t('tx.col.target'), sortable: true },
                { key: 'agents', label: t('tx.col.agents'), width: '110px', sortable: true, num: true },
                { key: 'interval', label: t('tx.col.interval'), width: '120px', sortable: true, num: true },
                { key: 'status', label: t('tx.col.status'), width: '120px', sortable: true },
                deps.isAdmin() ? { key: 'act', label: '', width: '120px' } : null,
              ].filter(Boolean),
              rows: rows.map(function (test) {
                return {
                  test: test,
                  cells: {
                    name: ui.hostLink(test.name, function () {
                      deps.mount(host, function () { return deps.detail(test.id, host); });
                    }),
                    type: ui.badge('info', test.type),
                    target: ui.meta(test.target || '—'),
                    agents: String((test.agent_ids || []).length),
                    interval: test.interval_sec + 's',
                    status: ui.badge(test.enabled ? 'ok' : 'neutral',
                      test.enabled ? t('tx.active') : t('tx.disabled')),
                    // Delete lives in the menu: a destructive action does not
                    // belong one mis-click away from Edit.
                    act: deps.isAdmin()
                      ? ui.rowActions(
                        { label: t('tx.edit'), onclick: function () { deps.mount(host, function () { return deps.form(test, host); }); } },
                        [{ label: t('tx.delete'), danger: true, onclick: function () { deps.remove(test, host); } }])
                      : '',
                  },
                };
              }),
              sort: state.sort,
              onSort: function (k) {
                state.sort = state.sort.key === k
                  ? { key: k, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
                  : { key: k, dir: NUMERIC[k] ? 'desc' : 'asc' };
                draw();
              },
              onOpen: function (row) {
                deps.mount(host, function () { return deps.detail(row.test.id, host); });
              },
            })],
          });
        });
      }

      // The form, the matrix and the detail are app.js's and navigate back to
      // "the list" — which is this function now, so app.js is handed it.
      deps.exposeList(list);
      draw();
      return Promise.resolve(page);
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.TransactionsPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
