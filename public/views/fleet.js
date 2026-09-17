// public/views/fleet.js — Fleet, as a ListPage (template A).
//
// Every agent with one health stamp, so a shift can see where something is
// wrong. Built from the contract's components (public/ui.js,
// docs/ui-contract.md).
//
// Three things on this page are NOT the contract's and are passed in whole: the
// NOC header (KPI cards + the live network path), the fleet-wide traffic map
// (Leaflet, rendered once per view entry so the 10 s poll does not rebuild it
// under the reader), and the licence-gated issues rollup. They are panels' worth
// of their own machinery and migrate in their own commits.
//
// What this migration changes:
//   * the four metric cards become a StatStrip, which is what they always were;
//   * the removable filter-chip row goes, because a StatStrip card already shows
//     its own state — what the chips said that the cards could not (a site, a
//     health threshold) now reads as one line above the table;
//   * the agent grid becomes a DataTable with sorting in the header;
//   * six hardcoded Danish strings on an English screen go through the
//     catalogue, in both languages.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;
    var F = deps.FleetFilter;

    function view() {
      var state = deps.state;
      if (!state.sort) state.sort = { key: null, dir: 'desc' };

      var root2 = ui.page();
      var noteHost = el('div', {});
      var nocHost = el('div', {});
      var trafficHost = el('div', {});
      var stripHost = el('div', {});
      var toolbarHost = el('div', {});
      var tableHost = el('div', {});
      var issuesHost = el('div', {});
      var data = null;

      var info = deps.help();
      root2.append(ui.pageHeader({
        title: t('fleet.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
        actions: [ui.button('secondary', t('fleet.openAgents'), { onclick: function () { deps.gotoView('agents'); } })],
      }), noteHost, stripHost, toolbarHost, tableHost, nocHost, trafficHost, issuesHost);

      trafficHost.append(deps.trafficMap());

      // ---- live advisories --------------------------------------------------
      // A maintenance window is a fact about the DATA in front of the reader —
      // alerts are suppressed while it runs — so it stays on screen as an inline
      // note rather than moving behind the (?).
      function drawNotes(windows) {
        var active = (windows || []).filter(function (w) {
          var now = Date.now();
          return Date.parse(w.from) <= now && now <= Date.parse(w.to);
        });
        if (!active.length) { noteHost.replaceChildren(); return; }
        noteHost.replaceChildren(ui.inlineNote(
          '🛠 ' + t('fleet.maintenance', { names: active.map(function (w) { return w.name; }).join(', ') }),
          'warn'));
      }

      // ---- StatStrip: the four metric cards ---------------------------------
      function summaryTotal(s) { return deps.summaryTotal(s); }

      function drawStrip() {
        if (!data) { stripHost.replaceChildren(); return; }
        var s = data.summary || {};
        var agents = data.agents || [];
        var total = summaryTotal(s);
        var crit = (s.bad || 0) + (s.down || 0);
        // The summary is always whole-fleet, even when the server pre-narrowed
        // the agent list, so these counts stay honest under a filter.
        var offline = typeof s.offline === 'number'
          ? s.offline
          : agents.filter(function (a) { return !a.online; }).length;
        var healthPct = total ? Math.round(((s.ok || 0) / total) * 100) : null;

        stripHost.replaceChildren(ui.statStrip([
          {
            value: healthPct == null ? '–' : healthPct + '%',
            label: t('fleet.card.health'),
            title: t('fleet.card.healthHint'),
            active: deps.getSortByHealth(),
            // Health is a SORT, not a filter: it orders the grid worst-first.
            onclick: function () { deps.setSortByHealth(!deps.getSortByHealth()); draw(); },
          },
          {
            value: String(crit), label: t('changes.group.CRIT'), tone: 'crit',
            title: t('fleet.card.filterHint'),
            active: deps.filter().severity.indexOf('CRIT') >= 0,
            onclick: function () { deps.setFilter(F.toggleSeverity(deps.filter(), 'CRIT')); draw(); },
          },
          {
            value: String(s.warn || 0), label: t('changes.group.WARN'), tone: 'warn',
            title: t('fleet.card.filterHint'),
            active: deps.filter().severity.indexOf('WARN') >= 0,
            onclick: function () { deps.setFilter(F.toggleSeverity(deps.filter(), 'WARN')); draw(); },
          },
          {
            value: String(offline), label: t('fleet.card.offline'),
            title: t('fleet.card.offlineHint'),
            active: deps.filter().offline,
            onclick: function () { deps.setFilter(F.toggleOffline(deps.filter())); draw(); },
          },
        ]));
      }

      // ---- Toolbar ----------------------------------------------------------
      function drawToolbar() {
        var active = F.isActive(deps.filter());
        toolbarHost.replaceChildren(ui.toolbar({
          filters: [
            ui.filter(t('fleet.filter.site'), ui.select({
              label: t('fleet.filter.site'),
              value: deps.filter().site || '',
              options: [['', t('fleet.filter.allSites')]].concat(siteOptions()),
              onchange: function (e) {
                deps.setFilter(F.setSite(deps.filter(), e.target.value || null));
                draw();
              },
            })),
          ],
          actions: active
            ? [ui.button('secondary', t('fleet.clearFilters'), {
              onclick: function () { deps.setFilter(F.emptyState()); draw(); },
            })]
            : [],
        }));
      }

      function siteOptions() {
        var seen = {};
        var out = [];
        ((data && data.agents) || []).forEach(function (a) {
          var name = a.locationName;
          if (!name || seen[name]) return;
          seen[name] = true;
          out.push([name, name]);
        });
        return out.sort(function (x, y) { return String(x[1]).localeCompare(String(y[1])); });
      }

      // ---- DataTable --------------------------------------------------------
      function num(v, unit) { return v == null ? '–' : v + (unit || ''); }

      function toRow(a) {
        var m = (a.health && a.health.metrics) || {};
        var dq = a.quality && a.quality.status && a.quality.status !== 'ok' && a.quality.status !== 'unknown';
        return {
          a: a,
          cells: {
            agent: el('span', {},
              ui.hostLink(a.displayName, function () { deps.openAgent(a.agentId); }),
              // The data-quality flag is a warning about the MEASUREMENT, so it
              // sits with the name it qualifies rather than in the health cell.
              dq ? el('span', {
                class: 'meta-xs',
                title: t('fleet.quality', { reason: a.quality.reason || a.quality.status }),
              }, ' ⚠') : null,
              a.displayName !== a.hostname ? el('div', { class: 'meta-xs' }, a.hostname) : null),
            status: ui.badge(a.online ? 'ok' : 'neutral', t(a.online ? 'fleet.online' : 'fleet.offline')),
            health: deps.healthBadgeUi(a.health),
            loss: num(m.lossPct, '%'),
            latency: deps.latencyText(m),
            jitter: num(m.jitterMs, ' ms'),
            targets: m.targets ? m.reachable + '/' + m.targets : '–',
            speed: deps.throughputText(a.throughput),
            location: ui.meta(a.locationName || '–'),
            seen: m.lastTs ? ui.fmt.short(m.lastTs) : '–',
          },
        };
      }

      var SORTERS = {
        agent: function (a) { return String(a.displayName || '').toLowerCase(); },
        status: function (a) { return a.online ? 1 : 0; },
        health: function (a) { return (a.health && a.health.score) || 0; },
        loss: function (a) { return numOr(a, 'lossPct'); },
        latency: function (a) { return numOr(a, 'rttMs'); },
        jitter: function (a) { return numOr(a, 'jitterMs'); },
        location: function (a) { return String(a.locationName || '').toLowerCase(); },
        seen: function (a) { return Date.parse(((a.health || {}).metrics || {}).lastTs || 0) || 0; },
      };
      function numOr(a, key) {
        var v = ((a.health || {}).metrics || {})[key];
        return typeof v === 'number' ? v : -1;
      }

      function ordered(list) {
        if (state.sort.key && SORTERS[state.sort.key]) {
          var get = SORTERS[state.sort.key];
          var dir = state.sort.dir === 'asc' ? 1 : -1;
          return list.slice().sort(function (x, y) {
            var a = get(x);
            var b = get(y);
            if (a < b) return -1 * dir;
            if (a > b) return 1 * dir;
            return 0;
          });
        }
        // No column chosen: the Fleet-health card decides, and its whole purpose
        // is worst-first.
        return deps.getSortByHealth() ? F.sortByHealth(list) : list;
      }

      function drawTable() {
        if (!data) { tableHost.replaceChildren(); return; }
        var agents = data.agents || [];
        var total = summaryTotal(data.summary) || agents.length;
        if (!total) {
          tableHost.replaceChildren(ui.panel({
            title: t('fleet.panel'),
            children: [ui.emptyState({
              icon: '◎',
              title: t('fleet.noAgents'),
              body: t('fleet.noAgentsHint'),
              action: ui.button('secondary', t('fleet.openEnrollment'), {
                onclick: function () { deps.gotoView('enrollment'); },
              }),
            })],
          }));
          return;
        }
        var filtered = F.applyFilter(agents, deps.filter());
        var active = F.isActive(deps.filter());
        tableHost.replaceChildren(ui.panel({
          title: t('fleet.panel'),
          note: active
            ? t('fleet.countFiltered', { shown: filtered.length, total: total })
            : t('fleet.count', { total: total }),
          children: [
            filtered.length ? ui.dataTable({
              columns: [
                { key: 'agent', label: t('fleet.col.agent'), width: '200px', sortable: true },
                { key: 'status', label: t('fleet.col.status'), width: '104px', sortable: true },
                { key: 'health', label: t('fleet.col.health'), width: '120px', sortable: true },
                { key: 'loss', label: t('fleet.col.loss'), width: '84px', sortable: true, num: true },
                { key: 'latency', label: t('fleet.col.latency'), width: '104px', sortable: true, num: true },
                { key: 'jitter', label: t('fleet.col.jitter'), width: '92px', sortable: true, num: true },
                { key: 'targets', label: t('fleet.col.targets'), width: '92px', num: true },
                { key: 'speed', label: t('fleet.col.speed'), width: '104px', num: true },
                { key: 'location', label: t('fleet.col.location'), width: '140px', sortable: true },
                { key: 'seen', label: t('fleet.col.seen'), width: '128px', sortable: true, time: true },
              ],
              rows: ordered(filtered).map(toRow),
              sort: state.sort.key ? state.sort : null,
              onSort: function (key) {
                state.sort = state.sort.key === key
                  ? { key: key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
                  : { key: key, dir: 'desc' };
                drawTable();
              },
              onOpen: function (row) { deps.openAgent(row.a.agentId); },
            }) : ui.emptyState({
              title: t('fleet.noMatch'),
              body: t('fleet.noMatchHint'),
              action: ui.button('secondary', t('fleet.clearFilters'), {
                onclick: function () { deps.setFilter(F.emptyState()); draw(); },
              }),
            }),
          ],
        }));
      }

      function draw() {
        deps.syncUrl();
        drawStrip();
        drawToolbar();
        drawTable();
      }

      // ---- refresh ----------------------------------------------------------
      function refresh() {
        return deps.fetchHealth(data)
          .then(function (d) {
            data = d;
            nocHost.replaceChildren(deps.noc(data));
            draw();
          })
          .catch(function (e) {
            tableHost.replaceChildren(ui.panel({
              title: t('fleet.panel'),
              children: [ui.errorState({
                title: t('fleet.err.title'),
                body: deps.errText(e),
                detail: 'GET /api/fleet/health',
                onRetry: refresh,
              })],
            }));
          });
      }

      tableHost.replaceChildren(ui.panel({ title: t('fleet.panel'), children: [ui.loadingState(6)] }));
      deps.maintenance().then(drawNotes, function () { drawNotes([]); });
      deps.issues().then(function (node) { issuesHost.replaceChildren.apply(issuesHost, node ? [node] : []); },
        function () { issuesHost.replaceChildren(); });

      return refresh().then(function () {
        deps.startPolling(refresh);
        return root2;
      });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.FleetView = apiObj;
})(typeof window !== 'undefined' ? window : null);
