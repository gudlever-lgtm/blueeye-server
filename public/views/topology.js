// public/views/topology.js — Topology, as a DashboardPage (template B).
//
// Who talks to whom: the flow-derived diagram, the unified resilience graph
// (LLDP links + service dependencies), and the public peers on a map. Built
// from the contract's components (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * Diagram / Layers / Map were three buttons pretending to be tabs. They are
//     a SubTabs strip, with the mode in the URL — the contract's one tab
//     pattern, carrying the keyboard and the ARIA;
//   * every row carried three buttons — Ping, Show route, Path — which stacked
//     into a three-line column on a narrow screen. Ping is the row's one
//     action, the other two are behind the ⋯ menu;
//   * the two tables become DataTables, sortable, so "the busiest host" is a
//     click rather than a scroll;
//   * the scope line ("Service/host dependencies · 60 min · Oslo") moves from a
//     grey span beside the heading into the Panel that shows the data.
//
// The three drawing primitives (`topoGraphSvg`, `topoLayersSvg`, the Leaflet
// map) and the probe modals stay in app.js: they are their own components, and
// the path visualisation is shared with Probes & Tests. The view asks for them.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;
    var TG = deps.TopologyGraph;

    var GRAPH_MAX_NODES = 40;
    var MODES = ['diagram', 'layers', 'map'];

    function view() {
      var state = deps.state;
      var params = deps.params();
      // A ?layer or ?focus deep link is about the resilience graph, so it opens
      // there rather than on the flow diagram. parseParams always returns a
      // layer (it defaults to 'both'), so the RAW query is what says whether
      // one was actually asked for.
      if (!state.mode) {
        var asked = deps.modeParam();
        state.mode = MODES.indexOf(asked) !== -1 ? asked
          : (deps.wantsLayers() ? 'layers' : 'diagram');
      }
      if (!state.sort) state.sort = { deps: { key: 'bytes', dir: 'desc' }, hosts: { key: 'in', dir: 'desc' } };
      // The deep link seeds the layer ONCE; after that the operator's choice is
      // the only source. `params` is a snapshot taken at render, and parseParams
      // always fills `layer` (defaulting to 'both'), so a `params.layer ||
      // state.layer` read could never see a change: picking L2 or Dependencies
      // set state, synced the URL, redrew — and read 'both' back out of the
      // stale snapshot. The dropdown looked broken because it was.
      if (state.layer == null) state.layer = params.layer || 'both';
      if (state.focus === undefined) state.focus = params.focus == null ? null : params.focus;

      var page = ui.page();
      var toolbarHost = el('div', {});
      var tabsHost = el('div', {});
      var viewHost = el('div', {});
      var tableHost = el('div', { class: 'panel-stack' });

      var agents = [];
      var onlineAgents = [];
      var locations = [];
      var data = null;
      var byId = {};

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('topo.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
        actions: [ui.button('secondary', t('topo.openDelta'), {
          onclick: function () { deps.gotoView('delta'); },
        })],
      }), toolbarHost, tabsHost, viewHost, tableHost);

      function label(id) {
        var n = byId[id];
        if (n && n.kind === 'external') {
          return id + (n.asnName ? ' · ' + n.asnName : '') + (n.country ? ' (' + n.country + ')' : '');
        }
        return String(id);
      }
      function kindBadge(kind) {
        return ui.badge(kind === 'external' ? 'warn' : 'ok', kind || '?');
      }

      // ---- Toolbar -----------------------------------------------------------
      var siteSel = null;
      function drawToolbar() {
        // Server-side, agent scope takes precedence over the Site filter, so the
        // Site control is disabled while one agent is selected rather than
        // silently ignored.
        var scoped = !!state.agentId;
        siteSel = ui.select({
          label: t('topo.site'), value: state.siteId || '',
          options: [['', t('fleet.filter.allSites')]].concat(locations.map(function (l) {
            return [String(l.id), l.name];
          })),
          onchange: function (e) { state.siteId = e.target.value || null; load(); },
        });
        if (scoped) {
          siteSel.disabled = true;
          siteSel.title = t('topo.siteIgnored');
        }
        var filters = [
          ui.filter(t('topo.site'), siteSel),
          ui.filter(t('topo.window'), ui.select({
            label: t('topo.window'), value: state.window || '60',
            options: [
              ['30', t('topo.window.30m')], ['60', t('topo.window.60m')],
              ['240', t('topo.window.4h')], ['1440', t('topo.window.24h')],
            ],
            onchange: function (e) { state.window = e.target.value; load(); },
          })),
        ];
        // The agent picker is both a scope and a vantage point: the per-row
        // probes run FROM it, so without an online agent there is nothing to
        // pick and no probe to offer.
        if (onlineAgents.length) {
          filters.push(ui.filter(t('topo.agent'), ui.select({
            label: t('topo.agent'), value: state.agentId || '',
            options: [['', t('topo.allAgents')]].concat(onlineAgents.map(function (a) {
              return [String(a.id), a.display_name || a.hostname];
            })),
            onchange: function (e) { state.agentId = e.target.value || null; load(); },
          })));
        }
        toolbarHost.replaceChildren(ui.toolbar({
          filters: filters,
          actions: [ui.button('secondary', t('topo.refresh'), { onclick: function () { load(); } })],
        }));
      }

      function drawTabs() {
        tabsHost.replaceChildren(ui.tabs([
          ['diagram', t('topo.mode.diagram')],
          ['layers', t('topo.mode.layers')],
          ['map', t('topo.mode.map')],
        ], {
          active: state.mode,
          ariaLabel: t('topo.modeLabel'),
          onPick: function (key) {
            if (state.mode === key) return;
            state.mode = key;
            deps.syncParams({ mode: key });
            drawMode();
          },
        }));
      }

      // ---- the three modes ---------------------------------------------------
      function scopeText() {
        var win = { 30: t('topo.window.30m'), 60: t('topo.window.60m'), 240: t('topo.window.4h'), 1440: t('topo.window.24h') }[state.window || '60'];
        var scope = null;
        if (state.agentId) {
          var a = onlineAgents.filter(function (x) { return String(x.id) === String(state.agentId); })[0];
          scope = a ? (a.display_name || a.hostname) : null;
        } else if (state.siteId) {
          var l = locations.filter(function (x) { return String(x.id) === String(state.siteId); })[0];
          scope = l ? l.name : null;
        }
        var totals = (data && data.totals) || { nodes: 0, internal: 0, external: 0, edges: 0 };
        return t('topo.scope', {
          window: win, scope: scope || t('topo.wholeFleet'),
          nodes: totals.nodes, internal: totals.internal, external: totals.external, edges: totals.edges,
        });
      }

      function drawMode() {
        deps.stopMap();
        if (state.mode === 'map') { drawMapMode(); return; }
        if (state.mode === 'layers') { drawLayersMode(); return; }
        drawDiagram();
      }

      function drawDiagram() {
        if (!data || !(data.edges || []).length) {
          viewHost.replaceChildren(ui.panel({
            title: t('topo.mode.diagram'),
            note: scopeText(),
            children: [ui.emptyState({ kind: 'nodata', title: t('topo.noFlows'), body: t('topo.noFlowsHint') })],
          }));
          return;
        }
        // Capped for legibility; the tables below carry the full list, drawn
        // from the same response so the two always agree.
        var nodes = (data.nodes || []).slice(0, GRAPH_MAX_NODES);
        var ids = {};
        nodes.forEach(function (n) { ids[n.id] = 1; });
        var edges = (data.edges || []).filter(function (e) { return ids[e.from] && ids[e.to]; }).slice(0, 90);
        viewHost.replaceChildren(ui.panel({
          title: t('topo.mode.diagram'),
          note: scopeText(),
          children: [el('div', { class: 'panel-body' },
            deps.graphSvg(nodes, edges, {
              label: label,
              kindBadge: kindBadge,
              actionBtns: onlineAgents.length ? rowProbeActions : null,
            }),
            nodes.length < (data.nodes || []).length
              ? ui.inlineNote(t('topo.capped', { shown: nodes.length, total: data.nodes.length }))
              : null)],
        }));
      }

      function drawLayersMode() {
        var host = el('div', { class: 'panel-body' });
        viewHost.replaceChildren(ui.panel({
          title: t('topo.mode.layers'),
          note: t('topo.layers.note'),
          actions: layerActions(),
          children: [host],
        }));
        deps.drawLayers(host, {
          layer: state.layer || 'both',
          focus: state.focus,
          whatIf: !!state.whatIf && deps.canWrite(),
          onFocus: function (id) { state.focus = id; deps.syncParams({ focus: id }); },
        });
      }

      function layerActions() {
        var acts = [ui.select({
          label: t('topo.layer'), value: state.layer || 'both',
          options: [
            ['both', t('topo.layer.both')], ['l2', t('topo.layer.l2')], ['dep', t('topo.layer.dep')],
          ],
          onchange: function (e) {
            state.layer = e.target.value;
            deps.syncParams({ layer: state.layer });
            drawLayersMode();
          },
        })];
        if (deps.canWrite()) {
          // "What if" is a blast-radius preview, and the endpoint is operator+,
          // so a viewer is not offered the toggle at all.
          acts.push(ui.button(state.whatIf ? 'primary' : 'secondary', t('topo.whatIf'), {
            title: t('topo.whatIfHint'),
            onclick: function () {
              state.whatIf = !state.whatIf;
              if (!state.whatIf) { state.focus = null; deps.syncParams({ focus: null }); }
              drawLayersMode();
            },
          }));
          acts.push(ui.button('ghost', t('topo.recompute'), {
            title: t('topo.recomputeHint'),
            onclick: function (e) {
              var btn = e.currentTarget;
              btn.disabled = true;
              deps.recompute()
                .then(function () { ui.toast(t('topo.recomputed')); drawLayersMode(); })
                .catch(function (err) { ui.toast(t('topo.recomputeFailed'), deps.errText(err), { bad: true }); })
                .then(function () { btn.disabled = false; });
            },
          }));
        }
        return acts;
      }

      function drawMapMode() {
        var host = el('div', { class: 'panel-body' });
        viewHost.replaceChildren(ui.panel({
          title: t('topo.mode.map'),
          note: t('topo.map.note'),
          children: [host],
        }));
        deps.drawMap(host, { data: data, locations: locations, siteId: state.siteId });
      }

      // ---- per-row probes ----------------------------------------------------
      // One action on the row, the other two behind the ⋯ menu. All three need
      // an agent to run from, which is why they only exist when one is picked.
      function rowProbeActions(host) {
        return ui.rowActions(
          { label: t('topo.ping'), onclick: function () { probe('ping', host); } },
          [
            { label: t('topo.route'), onclick: function () { probe('route', host); } },
            { label: t('topo.path'), onclick: function () { probe('path', host); } },
          ]);
      }
      function probe(kind, host) {
        if (!state.agentId) { ui.toast(t('topo.pickAgent'), null, { bad: true }); return; }
        deps.probe(kind, host, state.agentId);
      }

      // ---- the two tables ----------------------------------------------------
      function sortRows(list, which, keys) {
        var sort = state.sort[which];
        var dir = sort.dir === 'asc' ? 1 : -1;
        var read = keys[sort.key];
        if (!read) return list;
        return list.slice().sort(function (x, y) {
          var a = read(x);
          var b = read(y);
          if (a < b) return -1 * dir;
          if (a > b) return 1 * dir;
          return 0;
        });
      }
      function onSort(which, redraw) {
        return function (k) {
          var s = state.sort[which];
          state.sort[which] = s.key === k
            ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' }
            : { key: k, dir: 'desc' };
          redraw();
        };
      }

      function drawTables() {
        if (!data || !(data.edges || []).length) { tableHost.replaceChildren(); return; }
        var withActions = onlineAgents.length > 0;

        var depRows = sortRows((data.edges || []).slice(0, 100), 'deps', {
          from: function (e) { return label(e.from).toLowerCase(); },
          to: function (e) { return label(e.to).toLowerCase(); },
          bytes: function (e) { return Number(e.bytes) || 0; },
          flows: function (e) { return Number(e.flows) || 0; },
        });
        var hostRows = sortRows((data.nodes || []).slice(0, 50), 'hosts', {
          host: function (n) { return label(n.id).toLowerCase(); },
          peers: function (n) { return Number(n.degree) || 0; },
          in: function (n) { return Number(n.bytesIn) || 0; },
          out: function (n) { return Number(n.bytesOut) || 0; },
        });

        tableHost.replaceChildren(
          ui.panel({
            title: t('topo.deps'),
            note: t('topo.deps.note', { n: depRows.length }),
            children: [ui.dataTable({
              dense: true,
              columns: [
                { key: 'from', label: t('topo.col.from'), width: '190px', sortable: true },
                { key: 'to', label: t('topo.col.to'), width: '240px', sortable: true },
                { key: 'peer', label: t('topo.col.peer'), width: '110px' },
                { key: 'bytes', label: t('topo.col.bytes'), width: '120px', sortable: true, num: true },
                { key: 'flows', label: t('topo.col.flows'), width: '100px', sortable: true, num: true },
                withActions ? { key: 'act', label: '', width: '150px' } : null,
              ].filter(Boolean),
              rows: depRows.map(function (e) {
                return {
                  cells: {
                    from: ui.meta(label(e.from)),
                    to: ui.meta(label(e.to)),
                    peer: kindBadge(byId[e.to] && byId[e.to].kind),
                    bytes: deps.fmtBytes(e.bytes),
                    flows: String(e.flows),
                    act: withActions ? rowProbeActions(e.to) : '',
                  },
                };
              }),
              sort: state.sort.deps,
              onSort: onSort('deps', drawTables),
            })],
          }),
          ui.panel({
            title: t('topo.hosts'),
            note: t('topo.hosts.note', { n: hostRows.length }),
            children: [ui.dataTable({
              dense: true,
              columns: [
                { key: 'host', label: t('topo.col.host'), width: '300px', sortable: true },
                { key: 'kind', label: t('topo.col.kind'), width: '120px' },
                { key: 'peers', label: t('topo.col.peers'), width: '110px', sortable: true, num: true },
                { key: 'in', label: t('topo.col.in'), width: '130px', sortable: true, num: true },
                { key: 'out', label: t('topo.col.out'), width: '130px', sortable: true, num: true },
                withActions ? { key: 'act', label: '', width: '150px' } : null,
              ].filter(Boolean),
              rows: hostRows.map(function (n) {
                return {
                  cells: {
                    host: ui.meta(label(n.id)),
                    kind: kindBadge(n.kind),
                    peers: String(n.degree),
                    in: deps.fmtBytes(n.bytesIn),
                    out: deps.fmtBytes(n.bytesOut),
                    act: withActions ? rowProbeActions(n.id) : '',
                  },
                };
              }),
              sort: state.sort.hosts,
              onSort: onSort('hosts', drawTables),
            })],
          }));
      }

      // ---- load --------------------------------------------------------------
      function load() {
        drawToolbar();
        return deps.fetchTopology({
          minutes: state.window || '60',
          agentId: state.agentId,
          siteId: state.siteId,
        })
          .then(function (d) {
            data = d;
            byId = {};
            (d.nodes || []).forEach(function (n) { byId[n.id] = n; });
            drawMode();
            drawTables();
          })
          .catch(function (e) {
            data = null;
            tableHost.replaceChildren();
            viewHost.replaceChildren(ui.panel({
              title: t('topo.title'),
              children: [ui.errorState({
                title: t('topo.err.title'), body: deps.errText(e),
                detail: 'GET /api/topology', onRetry: load,
              })],
            }));
          });
      }

      viewHost.replaceChildren(ui.panel({ title: t('topo.title'), children: [ui.loadingState(5)] }));
      return deps.fetchScope()
        .then(function (d) {
          agents = d.agents || [];
          onlineAgents = agents.filter(function (a) { return a.status === 'online'; });
          locations = d.locations || [];
          drawToolbar();
          drawTabs();
          return load();
        })
        .then(function () { return page; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.TopologyPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
