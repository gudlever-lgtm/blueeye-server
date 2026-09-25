// public/views/agents.js — Agents, as a ListPage (template A).
//
// Every agent the server knows about: what it runs on, whether it is reporting,
// where it is, and what it can be told to do. Built from the contract's
// components (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * **nine** buttons in every row's last cell — Traffic, Flows, Ping,
//     Diagnose, Speed, Run test, Edit, Update, Delete — with Delete at the end
//     of the run. The row opens the agent, "Run test" is the row's action, and
//     everything else is behind the ⋯ menu, grouped: the four read-only checks,
//     then the two that change something, then Delete alone behind a separator;
//   * the table sorted itself by rewriting `th.textContent` with a ▲ or ▼ glued
//     to the label, and rebuilt `aria-sort` by hand. It is a DataTable, which
//     owns both;
//   * status was `.badge <status> clickable` — a chip you could click, which is
//     a button wearing a badge. The connection diagnosis is in the menu now,
//     where the other checks are, and **the Status column is gone**: Health is
//     derived from it (`status !== 'online'` IS `down`), so the two columns
//     said the same thing, one of them less precisely;
//   * nine fixed-width columns came to 1196px and ran off the panel at 1280 —
//     "Last reported" and the whole action column were past the right edge.
//     The ID went (the row opens the agent, and its id is in that address), the
//     version moved onto the platform line, and the agent's capability list and
//     hsflowd state moved to the agent page, which is where the detail lives;
//   * "No agents match your filter" was a `<td colspan="9">`. An estate with no
//     agents and a filter that matches nothing are two different problems, and
//     only one of them has a Clear.
//
// The panels the menu opens (traffic, flows, ping, the flow-pipeline self-check,
// the speed test, the edit form, the update flows) are NOT migrated.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var HEALTH_TONE = { healthy: 'ok', delayed: 'warn', nodata: 'warn', down: 'crit' };

    function view() {
      var state = deps.state;
      if (!state.sort) state.sort = { key: 'name', dir: 'asc' };
      if (state.q == null) state.q = '';

      var page = ui.page();
      var headHost = el('div', {});
      var barHost = el('div', {});
      var tableHost = el('div', {});
      var agents = [];
      var versions = { offered: null, source: null };

      var search = el('input', {
        type: 'search', placeholder: t('ag.searchPh'), value: state.q,
      });
      search.addEventListener('input', function () {
        // Filtering is over rows already in hand, so it is immediate — and the
        // toolbar is not rebuilt, which would take the caret with it.
        state.q = search.value.trim().toLowerCase();
        drawTable();
      });

      var info = deps.help();
      page.append(headHost, barHost, tableHost);

      // The header carries a count-bearing action ("Update outdated (3)"), so it
      // is rebuilt once the agents are in rather than assembled empty and
      // patched afterwards.
      function drawHead() {
        // Only systemd agents can be rebuilt and restarted from here; the rest
        // would decline, so the bulk action counts the ones it can actually act
        // on rather than every agent that is behind.
        var outdated = agents.filter(function (a) {
          return deps.selfUpdatable(a) && deps.isBehind(a, deps.updateTarget(a, versions));
        });
        headHost.replaceChildren(ui.pageHeader({
          title: t('ag.title'),
          lead: t('ag.lead'),
          help: { title: info.title, body: info.body },
          actions: [
            (deps.canDelete() && outdated.length)
              ? ui.button('secondary', t('ag.updateOutdated', { n: outdated.length }), {
                title: t('ag.updateOutdatedHint'),
                onclick: function () { deps.bulkUpdate(outdated, versions.offered); },
              })
              : null,
            deps.canWrite() ? ui.button('primary', t('ag.new'), { onclick: function () { deps.newAgent(); } }) : null,
          ],
        }));
      }

      function drawBar() {
        barHost.replaceChildren(ui.toolbar({
          filters: [
            ui.filter(t('ag.search'), search),
            ui.button('ghost', t('ag.clear'), {
              disabled: !state.q,
              onclick: function () { state.q = ''; search.value = ''; drawTable(); },
            }),
          ],
        }));
      }

      // ---- one row ----------------------------------------------------------
      function menuFor(a) {
        var target = deps.updateTarget(a, versions);
        var behind = deps.isBehind(a, target);
        var flowSource = a.monitor_config && (a.monitor_config.source === 'netflow' || a.monitor_config.source === 'sflow');
        return [
          // The four that only look.
          { label: t('ag.act.traffic'), onclick: function () { deps.showResults(a); } },
          flowSource ? { label: t('ag.act.flows'), onclick: function () { deps.showFlows(a); } } : null,
          { label: t('ag.act.connection'), onclick: function () { deps.showConnection(a); } },
          { label: t('ag.act.ping'), onclick: function () { deps.ping(a); } },
          { label: t('ag.act.diagnose'), onclick: function () { deps.diagnose(a); } },
          { label: t('ag.act.speed'), onclick: function () { deps.speedtest(a); } },
          // …and the ones that change something.
          deps.canWrite() ? '-' : null,
          deps.canWrite() ? { label: t('ag.act.edit'), onclick: function () { deps.edit(a); } } : null,
          // SNMP is optional and applies to one source out of four, so it lives
          // here rather than in the middle of the Edit form where it pushed the
          // settings most agents DO use below the fold.
          deps.canWrite() ? { label: t('ag.act.snmp'), onclick: function () { deps.editSnmp(a); } } : null,
          deps.canWrite() && deps.editPosition ? { label: t('ag.act.position'), onclick: function () { deps.editPosition(a); } } : null,
          deps.canDelete() ? updateEntry(a, target, behind) : null,
          deps.canDelete() ? '-' : null,
          deps.canDelete() ? { label: t('ag.act.delete'), danger: true, onclick: function () { deps.remove(a); } } : null,
        ].filter(Boolean);
      }

      // A Windows agent is not stuck: it gets a one-liner that updates it in
      // place, rather than being told to reinstall.
      function updateEntry(a, target, behind) {
        if (!deps.selfUpdatable(a) && deps.isWindows(a) && behind) {
          return { label: t('agentUpdate.win.button'), onclick: function () { deps.windowsUpdate(a, target); } };
        }
        if (!deps.selfUpdatable(a)) return null;
        return {
          label: behind ? t('ag.act.update', { v: target }) : t('ag.act.upgrade'),
          onclick: function () { deps.update(a, target); },
        };
      }

      function healthOf(a) {
        var last = a.last_report_at ? new Date(a.last_report_at).getTime() : 0;
        var age = last ? Date.now() - last : Infinity;
        if (a.status !== 'online') return { key: 'down', rank: 2, last: last };
        if (age <= 5 * 60 * 1000) return { key: 'healthy', rank: 0, last: last };
        return { key: last ? 'delayed' : 'nodata', rank: 1, last: last };
      }

      // The version gets a column of its own: it is what "Update outdated (3)"
      // in the header is about, and sharing the platform cell with it truncated
      // both. A DataTable row is one line, and this used to be two.
      function versionCell(a) {
        var target = deps.updateTarget(a, versions);
        var v = a.capabilities && a.capabilities.agentVersion;
        if (!v) return ui.meta('–');
        if (!deps.isBehind(a, target)) return ui.meta('v' + v);
        // An installer-only agent is not stuck and not one click from fixed, so
        // its badge says which — grey, not amber, because nothing here will do
        // it for you.
        var oneClick = deps.selfUpdatable(a) || deps.isWindows(a);
        return el('span', {},
          ui.meta('v' + v), ' ',
          ui.badge(oneClick ? 'warn' : 'neutral', oneClick ? t('ag.update') : t('ag.updateInstaller')));
      }

      // What the agent collects. Metadata, not a state, so it is muted text —
      // the capability list and the hsflowd state are on the agent page.
      function sourceCell(a) {
        var mc = a.monitor_config || {};
        var src = mc.source || 'proc';
        return ui.meta(src === 'snmp' && mc.snmp ? src + ' (' + mc.snmp.host + ')' : src);
      }

      function row(a) {
        var h = healthOf(a);
        return {
          a: a,
          cells: {
            name: a.display_name || a.hostname || '–',
            version: versionCell(a),
            health: ui.badge(HEALTH_TONE[h.key] || 'neutral', t('ag.health.' + h.key)),
            source: sourceCell(a),
            location: a.location_name ? a.location_name : ui.meta('–'),
            last: ui.meta(a.last_report_at ? ui.fmt.short(a.last_report_at) : '–'),
            act: ui.rowActions(
              deps.canWrite() ? { label: t('ag.act.run'), onclick: function () { deps.runTest(a); } } : null,
              menuFor(a)),
          },
        };
      }

      // ---- sorting + filtering ----------------------------------------------
      var SORT = {
        name: function (a) { return String(a.display_name || a.hostname || '').toLowerCase(); },
        // Behind first: the reason to sort by version is to find the stragglers.
        version: function (a) {
          var v = a.capabilities && a.capabilities.agentVersion;
          if (!v) return '2';
          return (deps.isBehind(a, deps.updateTarget(a, versions)) ? '0' : '1') + v;
        },
        status: function (a) { return a.status || ''; },
        health: function (a) { return healthOf(a).rank; },
        source: function (a) { return String((a.monitor_config && a.monitor_config.source) || 'proc'); },
        location: function (a) { return String(a.location_name || '').toLowerCase(); },
        last: function (a) { return a.last_report_at ? new Date(a.last_report_at).getTime() : 0; },
      };

      function matches(a) {
        if (!state.q) return true;
        return [a.id, a.display_name, a.hostname, a.platform, a.arch, a.status,
          a.location_name, a.monitor_config && a.monitor_config.source,
          a.capabilities && a.capabilities.agentVersion]
          .filter(function (v) { return v != null; })
          .join(' ').toLowerCase().indexOf(state.q) >= 0;
      }

      function drawTable() {
        drawBar();
        if (!agents.length) {
          tableHost.replaceChildren(ui.panel({
            title: t('ag.panel'),
            children: [ui.emptyState({
              icon: '◎',
              title: t('ag.none'),
              body: t('ag.noneHint'),
              action: deps.canWrite()
                ? ui.button('primary', t('ag.new'), { onclick: function () { deps.newAgent(); } })
                : null,
            })],
          }));
          return;
        }
        var get = SORT[state.sort.key] || SORT.name;
        var list = agents.filter(matches).sort(function (x, y) {
          var vx = get(x);
          var vy = get(y);
          var r = (typeof vx === 'number' && typeof vy === 'number') ? vx - vy : String(vx).localeCompare(String(vy));
          return state.sort.dir === 'asc' ? r : -r;
        });
        if (!list.length) {
          tableHost.replaceChildren(ui.panel({
            title: t('ag.panel'),
            children: [ui.emptyState({
              title: t('ag.noMatch'),
              body: t('ag.noMatchHint'),
              action: ui.button('secondary', t('ag.clear'), {
                onclick: function () { state.q = ''; search.value = ''; drawTable(); },
              }),
            })],
          }));
          return;
        }
        tableHost.replaceChildren(ui.panel({
          title: t('ag.panel'),
          note: state.q ? t('ag.ofTotal', { n: list.length, total: agents.length }) : t('ag.total', { n: agents.length }),
          children: [ui.dataTable({
            columns: [
              // Only the badge, the timestamp and the action column are pinned;
              // the browser lays the four text columns out. Pinning all seven
              // squeezed the agent's own name — the point of the row — down to
              // a hundred pixels and truncated it.
              { key: 'name', label: t('ag.col.name'), sortable: true },
              // Platform is not a column. It changes once in an agent's life,
              // and the one decision it drove — whether an update is one click
              // or an installer job — is on the version badge. It is on the
              // agent page, which the row opens, and the filter still matches
              // it, so "windows" still finds the Windows agents.
              { key: 'version', label: t('ag.col.version'), width: '168px', sortable: true },
              { key: 'health', label: t('ag.col.health'), width: '116px', sortable: true },
              { key: 'source', label: t('ag.col.source'), sortable: true },
              { key: 'location', label: t('ag.col.location'), sortable: true },
              { key: 'last', label: t('ag.col.last'), width: '148px', sortable: true, time: true },
              { key: 'act', label: '', width: '116px' },
            ],
            rows: list.map(row),
            sort: state.sort,
            onSort: function (k) {
              state.sort = state.sort.key === k
                ? { key: k, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
                : { key: k, dir: 'asc' };
              drawTable();
            },
            onOpen: function (r) { deps.open(r.a.id); },
          })],
        }));
      }

      function load() {
        tableHost.replaceChildren(ui.panel({ title: t('ag.panel'), children: [ui.loadingState(6)] }));
        return deps.fetchAll()
          .then(function (d) {
            agents = d.agents || [];
            versions = d.versions;
            drawHead();
            drawTable();
          })
          .catch(function (e) {
            tableHost.replaceChildren(ui.panel({
              title: t('ag.panel'),
              children: [ui.errorState({
                title: t('ag.err.title'),
                body: deps.errText(e),
                detail: 'GET /agents',
                onRetry: load,
              })],
            }));
          });
      }

      drawHead();
      drawBar();
      return load().then(function () { return page; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.AgentsPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
