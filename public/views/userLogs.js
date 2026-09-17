// public/views/userLogs.js — User Logs, as a ListPage (template A).
//
// THE audit log: one row per action a person performed, with the account behind
// it, when, what, and a flag when the row deserves a second look. Built from
// the contract's components (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * `.history-controls` — a flex row with a select, a bare checkbox, a search
//     field, two buttons, a spacer, a summary and a status — becomes a Toolbar
//     with the two actions on the right, and a StatStrip carrying the summary;
//   * "flagged: 3" was a warn badge inside that grey line. A count that is the
//     reason to open the page is a stat, and clicking it filters — the same
//     move Events, Situations and Discovery made. The checkbox goes with it;
//   * every row carried three stacked lines per cell — the label over the raw
//     action key over `POST /auth/login · HTTP 401 · 10.0.0.44`, and a flag's
//     reasons under its badge. Six columns of that overflowed the panel at
//     1280 and pushed the flag text off the right edge. A row is one line, and
//     everything under it opens in a **Drawer** — which is where the contract
//     puts detail, and where there is room for the whole request line;
//   * an empty result was `<td colspan="6">` with one of two sentences in it.
//     They are two different states now, and only the filtered one offers a
//     Clear;
//   * a failed load replaced the rows with a red box ABOVE an empty table, so
//     the screen showed a failure and an empty log at once. It is an ErrorState
//     in the panel, naming the call, with a Retry.
//
// What is deliberately kept: an unflagged row gets NO badge. A green "OK" on
// every line is noise, and the flags only mean anything if they are rare enough
// to notice. The flag rules and their explanations stay server-side in
// src/audit/userActivity.js — this view only renders them, so the dashboard and
// the CSV export can never disagree about why something was flagged.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var FLAG_TONE = { critical: 'crit', warn: 'warn', notice: 'neutral' };


    function view() {
      var state = deps.state;
      var page = ui.page();
      var stripHost = el('div', {});
      var barHost = el('div', {});
      var tableHost = el('div', {});
      var users = [];

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('logs.user.title'),
        lead: t('logs.user.lead'),
        help: { title: info.title, body: info.body },
        actions: [ui.button('secondary', t('logs.user.export'), {
          onclick: function () { deps.exportCsv(state); },
        })],
      }), stripHost, barHost, tableHost);

      var search = el('input', {
        type: 'search', placeholder: t('logs.user.filter.searchPlaceholder'), value: state.q || '',
      });
      var searchTimer = null;
      search.addEventListener('input', function () {
        // The toolbar is not rebuilt per keystroke — that would take the focus
        // with it — so the field is built once and only the table is redrawn.
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = deps.debounce(function () { state.q = search.value.trim(); load(); });
      });

      function drawStrip(s) {
        stripHost.replaceChildren(ui.statStrip([
          { value: s.total || 0, label: t('logs.user.stat.actions') },
          { value: s.users || 0, label: t('logs.user.stat.people') },
          {
            value: s.flagged || 0,
            label: t('logs.user.stat.flagged'),
            tone: s.flagged ? 'warn' : undefined,
            active: !!state.flagged,
            title: t('logs.user.stat.flaggedHint'),
            onclick: function () { state.flagged = !state.flagged; load(); },
          },
        ]));
      }

      function clearAll() {
        state.user = ''; state.flagged = false; state.q = '';
        search.value = '';
        load();
      }

      function drawBar() {
        var userSel = ui.select({
          label: t('logs.user.filter.user'),
          value: state.user,
          options: [['', t('logs.user.filter.allUsers')]].concat(users.map(function (u) {
            return [String(u.id), (u.name ? u.name + ' · ' : '') + u.email + ' (#' + u.id + ')'];
          })),
          onchange: function (e) { state.user = e.target.value; load(); },
        });
        barHost.replaceChildren(ui.toolbar({
          filters: [
            ui.filter(t('logs.user.filter.user'), userSel),
            ui.filter(t('logs.user.filter.search'), search),
            ui.button('ghost', t('logs.user.clearFilters'), {
              disabled: !state.user && !state.flagged && !state.q,
              onclick: clearAll,
            }),
          ],
          actions: [ui.button('secondary', t('logs.user.refresh'), { onclick: function () { load(); } })],
        }));
      }

      function detailLine(e) {
        var bits = [];
        if (e.method && e.path) bits.push(e.method + ' ' + e.path);
        if (e.status != null) bits.push('HTTP ' + e.status);
        if (e.ip) bits.push(e.ip);
        if (typeof e.detail === 'string' && e.detail) bits.push(e.detail);
        else if (e.detail && typeof e.detail === 'object' && Object.keys(e.detail).length) bits.push(JSON.stringify(e.detail));
        return bits.length ? bits.join(' · ') : null;
      }

      function reasonsOf(e) { return (e.flags || []).map(function (f) { return f.message; }); }

      function row(e) {
        var flagged = e.flagLevel && e.flagLevel !== 'none';
        return {
          e: e,
          cells: {
            when: ui.meta(ui.fmt.short(e.ts)),
            who: e.name
              ? el('span', {}, e.name)
              : ui.meta(e.email || t('logs.user.noName')),
            action: e.actionLabel || e.action,
            target: e.target ? e.target : ui.meta('–'),
            // No badge at all on an unflagged row: a green OK on every line is
            // noise, and a rare flag is the only kind worth having. The reasons
            // are on the badge's title and in full in the drawer.
            flag: flagged
              ? el('span', { title: reasonsOf(e).join(' ') },
                ui.badge(FLAG_TONE[e.flagLevel] || 'neutral', t('logs.user.flag.' + e.flagLevel)))
              : ui.meta('–'),
          },
        };
      }

      // One row, in full: the account behind it, the request it made, and why
      // it was flagged. The table says what happened; this says everything else.
      function openRow(e, tr) {
        var flagged = e.flagLevel && e.flagLevel !== 'none';
        var reasons = reasonsOf(e);
        var detail = detailLine(e);
        ui.openDrawer({
          title: e.actionLabel || e.action,
          meta: ui.fmt.abs(e.ts),
          status: flagged
            ? ui.badge(FLAG_TONE[e.flagLevel] || 'neutral', t('logs.user.flag.' + e.flagLevel))
            : null,
          row: tr,
          sections: [
            flagged && reasons.length
              ? ui.drawerSection(t('logs.user.drawer.why'),
                el('ul', {}, reasons.map(function (r) { return el('li', {}, r); })))
              : null,
            ui.drawerSection(t('logs.user.drawer.account'), ui.keyValues([
              [t('logs.user.col.userId'), e.userId == null ? '–' : '#' + e.userId],
              [t('logs.user.col.name'), e.name || t('logs.user.noName')],
              [t('logs.user.drawer.email'), e.email || '–'],
              e.deletedUser ? [t('logs.user.drawer.state'), t('logs.user.deletedUser')] : null,
            ])),
            ui.drawerSection(t('logs.user.drawer.what'), ui.keyValues([
              [t('logs.user.drawer.key'), el('code', {}, e.action)],
              [t('logs.user.col.target'), e.target || '–'],
              // The timestamp is already in the drawer's own head line.
            ])),
            detail
              ? ui.drawerSection(t('logs.user.drawer.request'), ui.keyValues([
                (e.method && e.path) ? [t('logs.user.drawer.call'), el('code', {}, e.method + ' ' + e.path)] : null,
                e.status != null ? [t('logs.user.drawer.status'), String(e.status)] : null,
                e.ip ? [t('logs.user.drawer.ip'), el('code', {}, e.ip)] : null,
                e.detail ? [t('logs.user.drawer.detail'),
                  el('code', {}, typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail))] : null,
              ]))
              : null,
          ],
        });
      }

      function draw(data) {
        var entries = data.entries || [];
        if (!entries.length) {
          var filtered = state.user || state.flagged || state.q;
          tableHost.replaceChildren(ui.panel({
            title: t('logs.user.panel'),
            children: [filtered
              ? ui.emptyState({
                title: t('logs.user.emptyFiltered'),
                body: t('logs.user.emptyFilteredHint'),
                action: ui.button('secondary', t('logs.user.clearFilters'), { onclick: clearAll }),
              })
              : ui.emptyState({ icon: '👤', title: t('logs.user.empty'), body: t('logs.user.emptyHint') })],
          }));
          return;
        }
        tableHost.replaceChildren(ui.panel({
          title: t('logs.user.panel'),
          note: t('logs.user.count', { shown: entries.length, total: data.total == null ? entries.length : data.total }),
          children: [ui.dataTable({
            columns: [
              { key: 'when', label: t('logs.user.col.when'), width: '148px', time: true },
              { key: 'who', label: t('logs.user.col.name'), width: '220px' },
              // The action is the point of the row, so it takes what is left.
              { key: 'action', label: t('logs.user.col.action') },
              { key: 'target', label: t('logs.user.col.target'), width: '180px' },
              // "Needs attention" is the longest badge label; at 150px it clipped.
              { key: 'flag', label: t('logs.user.col.flag'), width: '180px' },
            ],
            rows: entries.map(row),
            onOpen: function (r, tr) { openRow(r.e, tr); },
          })],
        }));
      }

      function load() {
        return deps.fetchLog(state)
          .then(function (data) {
            drawStrip(data.summary || { total: 0, users: 0, flagged: 0 });
            drawBar();
            draw(data);
          })
          .catch(function (e) {
            // A failure used to leave a red box above an empty table, so the
            // screen showed "it broke" and "nothing happened here" at once.
            stripHost.replaceChildren();
            drawBar();
            tableHost.replaceChildren(ui.panel({
              title: t('logs.user.panel'),
              children: [ui.errorState({
                title: t('logs.user.err.title'),
                body: deps.errText(e),
                detail: 'GET /api/audit/users',
                onRetry: load,
              })],
            }));
          });
      }

      drawBar();
      tableHost.replaceChildren(ui.panel({ title: t('logs.user.panel'), children: [ui.loadingState(6)] }));
      // The dropdown lists the accounts that exist NOW, so an admin can pick a
      // colleague who has no rows in the current window. A missing dropdown is
      // not fatal — the log itself is what matters.
      return deps.fetchUsers()
        .then(function (list) { users = list || []; })
        .catch(function () { users = []; })
        .then(load)
        .then(function () { return page; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.UserLogsPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
