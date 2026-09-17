// public/views/systemLogs.js — System Logs, as a ListPage (template A).
//
// Is the server healthy? Live server diagnostics plus the dashboard's own
// errors, in one ring. Built from the contract's components (public/ui.js,
// docs/ui-contract.md).
//
// What this migration changes:
//   * `.history-controls` — a flex row of three loose labels, a Refresh and a
//     status span — is a Toolbar. Refresh is a toolbar action, where every
//     other screen puts it;
//   * the level badge was `.badge danger|warn|neutral|active`, a fourth
//     vocabulary for severity. It is a contract Badge on the same crit/warn/
//     info/neutral tones the rest of the app reads;
//   * "server logs unavailable: …" was appended to the row count in the same
//     grey span. A server ring that cannot be read is not a footnote to a
//     count: it is an advisory above the table, and the rows below it are then
//     this browser's only;
//   * an empty result said nothing at all — the table simply had no rows. It
//     says whether there is nothing to show or nothing that matches.
//
// The faceted counts in the two dropdowns are kept exactly as they were: each
// counts over the set the OTHER filter narrowed, so a selection in one still
// shows meaningful tallies in it.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var LEVEL_TONE = { error: 'crit', warn: 'warn', debug: 'neutral', info: 'info' };
    var ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
    var LEVELS = ['', 'debug', 'info', 'warn', 'error'];
    var SOURCES = ['', 'server', 'client'];

    function view() {
      var state = deps.state;
      var page = ui.page();
      var barHost = el('div', {});
      var noteHost = el('div', {});
      var tableHost = el('div', {});

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('logs.system.title'),
        lead: t('logs.system.lead'),
        help: { title: info.title, body: info.body },
      }), barHost, noteHost, tableHost);

      // The two selects are rebuilt on every load (their labels carry counts),
      // so they are held here rather than closed over once.
      var levelSel = null;
      var sourceSel = null;
      var search = el('input', { type: 'search', placeholder: t('logs.searchPh'), value: state.q || '' });
      var searchTimer = null;
      search.addEventListener('input', function () {
        // Typing must not fire a request per keystroke, and rebuilding the
        // toolbar under the cursor would lose the focus — so the field is built
        // once and only the table is redrawn.
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = deps.debounce(function () { state.q = search.value.trim(); load(); });
      });

      function levelLabel(v) { return v ? t('logs.level.' + v) : t('logs.level.all'); }
      function sourceLabel(v) { return v ? t('logs.source.' + v) : t('logs.source.all'); }

      function drawBar(levelCounts, sourceCounts) {
        levelSel = ui.select({
          label: t('logs.level'),
          value: state.level,
          options: LEVELS.map(function (v) {
            return [v, levelCounts ? levelLabel(v) + ' (' + (levelCounts[v] || 0) + ')' : levelLabel(v)];
          }),
          onchange: function (e) { state.level = e.target.value; load(); },
        });
        sourceSel = ui.select({
          label: t('logs.source'),
          value: state.source,
          options: SOURCES.map(function (v) {
            return [v, sourceCounts ? sourceLabel(v) + ' (' + (sourceCounts[v] || 0) + ')' : sourceLabel(v)];
          }),
          onchange: function (e) { state.source = e.target.value; load(); },
        });
        var clear = ui.button('ghost', t('logs.clearFilters'), {
          disabled: !state.level && !state.source && !state.q,
          onclick: function () {
            state.level = ''; state.source = ''; state.q = '';
            search.value = '';
            load();
          },
        });
        barHost.replaceChildren(ui.toolbar({
          filters: [
            ui.filter(t('logs.level'), levelSel),
            ui.filter(t('logs.source'), sourceSel),
            ui.filter(t('logs.search'), search),
            clear,
          ],
          actions: [ui.button('secondary', t('logs.refresh'), { onclick: function () { load(); } })],
        }));
      }

      function row(r) {
        var meta = r.meta && Object.keys(r.meta).length ? JSON.stringify(r.meta) : '';
        return {
          dimmed: false,
          cells: {
            time: ui.meta(ui.fmt.short(r.ts)),
            level: ui.badge(LEVEL_TONE[r.level] || 'neutral', r.level),
            source: ui.meta(r.source === 'client' ? t('logs.source.client') : t('logs.source.server')),
            // el() appends children as text nodes, so the message and the meta
            // JSON are never escaped twice — that used to render literal &quot;.
            message: meta
              ? el('div', {}, el('div', {}, r.msg), ui.metaXs(meta))
              : el('div', {}, r.msg),
          },
        };
      }

      function draw(rows, total) {
        if (!rows.length) {
          var filtered = state.level || state.source || state.q;
          tableHost.replaceChildren(ui.panel({
            title: t('logs.panel'),
            children: [filtered
              ? ui.emptyState({
                title: t('logs.noMatch'),
                body: t('logs.noMatchHint'),
                action: ui.button('secondary', t('logs.clearFilters'), {
                  onclick: function () {
                    state.level = ''; state.source = ''; state.q = '';
                    search.value = '';
                    load();
                  },
                }),
              })
              : ui.emptyState({
                icon: '📄',
                title: t('logs.none'),
                body: t('logs.noneHint'),
              })],
          }));
          return;
        }
        tableHost.replaceChildren(ui.panel({
          title: t('logs.panel'),
          note: t('logs.shown', { n: rows.length, total: total }),
          children: [ui.dataTable({
            columns: [
              { key: 'time', label: t('logs.col.time'), width: '148px', time: true },
              // "debug" is the longest label the badge carries; at 92px it
              // clipped and spilled into the source column.
              { key: 'level', label: t('logs.col.level'), width: '108px' },
              { key: 'source', label: t('logs.col.source'), width: '110px' },
              { key: 'message', label: t('logs.col.message') },
            ],
            rows: rows.map(row),
          })],
        }));
      }

      function load() {
        return deps.fetchLogs(state.q).then(function (res) {
          // A server ring that cannot be read is an advisory, not a footnote to
          // the row count: what is below is then this browser's own log only.
          noteHost.replaceChildren.apply(noteHost, res.error
            ? [ui.inlineNote(t('logs.serverDown', { message: res.error }), 'warn')]
            : []);

          var base = res.entries;
          if (state.q) {
            var s = state.q.toLowerCase();
            base = base.filter(function (r) {
              return String(r.msg || '').toLowerCase().indexOf(s) >= 0
                || JSON.stringify(r.meta || {}).toLowerCase().indexOf(s) >= 0;
            });
          }
          function lvl(r) { return ORDER[r.level] == null ? 1 : ORDER[r.level]; }

          // Faceted: each dropdown counts over the set the OTHER filter
          // narrowed, so a selection in one still shows tallies in it.
          var bySource = state.source ? base.filter(function (r) { return r.source === state.source; }) : base;
          var byLevel = state.level ? base.filter(function (r) { return lvl(r) >= ORDER[state.level]; }) : base;
          var levelCounts = { '': bySource.length };
          LEVELS.forEach(function (v) {
            if (v) levelCounts[v] = bySource.filter(function (r) { return lvl(r) >= ORDER[v]; }).length;
          });
          var sourceCounts = {
            '': byLevel.length,
            server: byLevel.filter(function (r) { return r.source === 'server'; }).length,
            client: byLevel.filter(function (r) { return r.source === 'client'; }).length,
          };
          drawBar(levelCounts, sourceCounts);

          var rows = state.level
            ? bySource.filter(function (r) { return lvl(r) >= ORDER[state.level]; })
            : bySource;
          draw(rows, res.entries.length);
        });
      }

      drawBar(null, null);
      tableHost.replaceChildren(ui.panel({ title: t('logs.panel'), children: [ui.loadingState(6)] }));
      return load().then(function () { return page; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.SystemLogsPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
