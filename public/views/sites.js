// public/views/sites.js — Sites, as a ListPage (template A).
//
// Where the agents are, and how the estate looks from above: a marker per site
// coloured by the worst agent health at it, and the same rollup as a table for
// when the map cannot be drawn. Built from the contract's components
// (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * the legend dots and the map markers stop carrying hex colours. Both now
//     resolve the semantic tokens at runtime through ui.token(), so a site
//     marker follows the palette instead of staying green on a theme where
//     green means something else;
//   * the location rollup becomes a DataTable, so it is the same table with or
//     without a map — it used to be a fallback list nobody had looked at since
//     it was written;
//   * "no coordinates yet" and "the map library did not load" stop being the
//     same grey sentence: one is a thing to fix, the other is a thing to know.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var HEALTH_TONE = {
      ok: 'ok', warn: 'warn', bad: 'crit', down: 'crit',
      stale: 'neutral', unknown: 'neutral',
    };
    function healthLabel(status) {
      var k = 'sites.health.' + (status || 'unknown');
      var v = t(k);
      return v === k ? String(status || 'unknown') : v;
    }

    function view() {
      var state = deps.state;
      if (!state.sort) state.sort = { key: 'health', dir: 'desc' };

      var root2 = ui.page();
      var stripHost = el('div', {});
      var mapHost = el('div', {});
      var tableHost = el('div', {});
      var locations = [];
      var agents = [];
      var healthByAgent = {};

      var info = deps.help();
      root2.append(ui.pageHeader({
        title: t('sites.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
        actions: [ui.button('secondary', t('sites.manage'), { onclick: function () { deps.gotoView('locations'); } })],
      }), stripHost, mapHost, tableHost);

      // ---- rollup -----------------------------------------------------------
      // One entry per site: how many agents, how many online, and the worst
      // health among them — which is what the marker colour means.
      function rollup() {
        var byLoc = {};
        agents.forEach(function (a) {
          if (a.location_id == null) return;
          var e = byLoc[a.location_id] || { total: 0, online: 0, agents: [] };
          e.total += 1;
          if (a.status === 'online') e.online += 1;
          e.agents.push({
            id: a.id,
            name: a.display_name || a.hostname,
            status: healthByAgent[a.id] || (a.status === 'online' ? 'unknown' : 'down'),
          });
          byLoc[a.location_id] = e;
        });
        Object.keys(byLoc).forEach(function (k) {
          byLoc[k].worst = deps.worstHealthStatus(byLoc[k].agents.map(function (x) { return x.status; }));
        });
        return byLoc;
      }

      function located() {
        return locations.filter(function (l) { return l.latitude != null && l.longitude != null; });
      }

      // ---- StatStrip --------------------------------------------------------
      function drawStrip() {
        var byLoc = rollup();
        var sites = locations.length;
        var withCoords = located().length;
        var critical = 0;
        var offline = 0;
        Object.keys(byLoc).forEach(function (k) {
          var e = byLoc[k];
          if (e.worst === 'bad' || e.worst === 'down') critical += 1;
          offline += e.total - e.online;
        });
        stripHost.replaceChildren(ui.statStrip([
          { value: sites, label: t('sites.stat.sites') },
          {
            value: withCoords, label: t('sites.stat.mapped'),
            title: t('sites.stat.mappedHint'),
            tone: withCoords < sites ? 'warn' : undefined,
          },
          { value: critical, label: t('sites.stat.critical'), tone: 'crit' },
          { value: offline, label: t('sites.stat.offlineAgents') },
        ]));
      }

      // ---- map --------------------------------------------------------------
      function legend() {
        // The dot takes its colour from a class, not from a style attribute —
        // the whole point of the exercise.
        return el('div', { class: 'ui-chart-legend site-legend' },
          ['ok', 'warn', 'bad', 'unknown'].map(function (k) {
            return el('span', { class: 'ui-legend-item' },
              el('span', { class: 'ui-legend-dot health-' + k }),
              healthLabel(k));
          }),
          ui.metaXs(t('sites.legendNote')));
      }

      function drawMap() {
        var pts = located();
        if (!locations.length) {
          // No estate at all: the table's EmptyState says it once. A second
          // panel saying the same thing in other words is noise.
          mapHost.replaceChildren();
          return;
        }
        if (!deps.hasMapLibrary()) {
          // Not an error and not an empty estate: the library did not load, and
          // the table below is the whole content either way.
          mapHost.replaceChildren(ui.panel({
            title: t('sites.map'),
            children: [ui.emptyState({
              icon: '◎',
              title: t('sites.noLibrary'),
              body: t('sites.noLibraryHint'),
            })],
          }));
          return;
        }
        if (!pts.length) {
          mapHost.replaceChildren(ui.panel({
            title: t('sites.map'),
            children: [ui.emptyState({
              title: t('sites.noCoords'),
              body: t('sites.noCoordsHint'),
              action: ui.button('secondary', t('sites.manage'), { onclick: function () { deps.gotoView('locations'); } }),
            })],
          }));
          return;
        }
        var canvas = el('div', { class: 'site-map' });
        mapHost.replaceChildren(ui.panel({
          title: t('sites.map'),
          note: t('sites.mapNote', { mapped: pts.length, total: locations.length }),
          children: [el('div', { class: 'panel-body' }, canvas, legend())],
        }));
        deps.mountMap(canvas, pts, rollup(), {
          // Resolved here rather than written into the view: a marker follows
          // the palette the reader chose.
          colorFor: function (status) { return ui.healthColor(status); },
          ringColor: ui.token('--surface'),
          openAgent: deps.openAgent,
        });
      }

      // ---- DataTable --------------------------------------------------------
      function toRow(l, byLoc) {
        var c = byLoc[l.id] || { total: 0, online: 0, agents: [], worst: null };
        var tone = HEALTH_TONE[c.worst || 'unknown'] || 'neutral';
        return {
          l: l, c: c,
          cells: {
            site: ui.hostLink(l.name, function () { deps.openLocation(l.id); }),
            health: c.total ? ui.badge(tone, healthLabel(c.worst || 'unknown')) : ui.meta('–'),
            agents: c.total ? c.online + '/' + c.total : '–',
            coords: l.latitude != null && l.longitude != null
              ? ui.meta(Number(l.latitude).toFixed(2) + ', ' + Number(l.longitude).toFixed(2))
              : ui.inlineNote(t('sites.noCoordShort'), 'warn'),
            address: ui.meta(l.address || '–'),
          },
        };
      }

      var RANK = { bad: 0, down: 0, warn: 1, stale: 2, unknown: 3, ok: 4 };
      function drawTable() {
        var byLoc = rollup();
        if (!locations.length) {
          tableHost.replaceChildren(ui.panel({
            title: t('sites.panel'),
            children: [ui.emptyState({
              title: t('sites.none'),
              body: t('sites.noneHint'),
              action: ui.button('secondary', t('sites.manage'), { onclick: function () { deps.gotoView('locations'); } }),
            })],
          }));
          return;
        }
        var list = locations.slice();
        var dir = state.sort.dir === 'asc' ? 1 : -1;
        var key = state.sort.key;
        list.sort(function (x, y) {
          var a, b;
          var cx = byLoc[x.id] || {};
          var cy = byLoc[y.id] || {};
          if (key === 'health') { a = RANK[cx.worst || 'unknown']; b = RANK[cy.worst || 'unknown']; }
          else if (key === 'agents') { a = cx.total || 0; b = cy.total || 0; }
          else { a = String(x.name || '').toLowerCase(); b = String(y.name || '').toLowerCase(); }
          if (a < b) return -1 * dir;
          if (a > b) return 1 * dir;
          return 0;
        });
        // Worst-first is the useful default here, so "descending" on health
        // means the sites that need somebody, not the ones that are fine.
        if (key === 'health' && state.sort.dir === 'desc') list.reverse();

        tableHost.replaceChildren(ui.panel({
          title: t('sites.panel'),
          note: t('sites.count', { n: locations.length }),
          children: [ui.dataTable({
            columns: [
              { key: 'site', label: t('sites.col.site'), width: '220px', sortable: true },
              { key: 'health', label: t('sites.col.health'), width: '128px', sortable: true },
              { key: 'agents', label: t('sites.col.agents'), width: '152px', sortable: true, num: true },
              { key: 'coords', label: t('sites.col.coords'), width: '176px' },
              { key: 'address', label: t('sites.col.address') },
            ],
            rows: list.map(function (l) { return toRow(l, byLoc); }),
            sort: state.sort,
            onSort: function (k) {
              state.sort = state.sort.key === k
                ? { key: k, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
                : { key: k, dir: 'desc' };
              drawTable();
            },
            onOpen: function (row) { deps.openLocation(row.l.id); },
          })],
        }));
      }

      function draw() { drawStrip(); drawMap(); drawTable(); }

      function load(first) {
        return deps.fetchAll()
          .then(function (d) {
            locations = d.locations || [];
            agents = d.agents || [];
            healthByAgent = d.healthByAgent || {};
            if (first) draw();
            else { drawStrip(); drawTable(); deps.redrawMarkers(rollup()); }
          })
          .catch(function (e) {
            if (!first) return; // a failed poll keeps the last good render
            // Nothing loaded, so there is nothing to put a number on: the strip
            // and the map go rather than show zeros the server never said.
            stripHost.replaceChildren();
            mapHost.replaceChildren();
            tableHost.replaceChildren(ui.panel({
              title: t('sites.panel'),
              children: [ui.errorState({
                title: t('sites.err.title'),
                body: deps.errText(e),
                detail: 'GET /locations',
                onRetry: function () { return load(true); },
              })],
            }));
          });
      }

      tableHost.replaceChildren(ui.panel({ title: t('sites.panel'), children: [ui.loadingState(5)] }));
      return load(true).then(function () {
        deps.startPolling(function () { return load(false); });
        return root2;
      });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.SitesView = apiObj;
})(typeof window !== 'undefined' ? window : null);
