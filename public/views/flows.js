// public/views/flows.js — Flows, as a DashboardPage (template B).
//
// Who talked to whom, over what, and when: the unified explorer, the
// ingress/egress split, and the geographic traffic map. Built from the
// contract's components (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * Unified / Bidirectional / Map were three buttons in a `.flows-seg`
//     segmented control, and the time presets were four more. The modes are a
//     SubTabs strip with the mode in the URL; the presets are a select, because
//     a range is a value and not a place;
//   * the hand-built `.flows-field` control grid becomes one Toolbar, and the
//     controls a mode does not use are simply not built for it;
//   * every table becomes a DataTable, sortable, with the ports and the
//     protocols side by side in a panel grid;
//   * the status line — bytes, flows, records — moves from a grey span in the
//     control bar into the Panel note, beside the data it counts;
//   * "Invalid time range" was an error where the data goes. It is a field
//     error on the input that is wrong.
//
// What it keeps: drag-to-zoom on the chart (with the minimum-window padding —
// agents report at a coarse cadence, so a thin selection would be empty), the
// findings overlay, the deep link from global search and from a clicked
// dataflow, and clicking a talker to pivot the peer filter onto it.
//
// The traffic map, its legend chips and the traffic-type colour ramp stay in
// app.js: the ramp is a per-category palette that has not been migrated, and
// the map carries the reader's pan and zoom.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var MODES = ['unified', 'bidi', 'map'];
    var PRESET_MS = { '15m': 15 * 60000, '1h': 3600000, '6h': 6 * 3600000, '24h': 24 * 3600000 };
    var MIN_ZOOM_MS = 60 * 1000;

    function view() {
      var state = deps.state;
      if (!state.preset) state.preset = '1h';
      if (!state.mode) state.mode = 'unified';
      if (!state.sort) state.sort = { talkers: { key: 'bytes', dir: 'desc' } };

      var page = ui.page();
      var tabsHost = el('div', {});
      var toolbarHost = el('div', {});
      var host = el('div', { class: 'panel-stack' });

      var agents = [];
      var sites = [];
      var fromErr = el('span', {});
      var toErr = el('span', {});

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('flows.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
      }), tabsHost, toolbarHost, host);

      // A deep link (global search → "→ flows", or a clicked dataflow) lands
      // with the filters already set, and in Map mode when it is about a site.
      function takePrefill() {
        var p = deps.takePrefill();
        if (!p) return;
        if (p.agentId != null) state.agentId = String(p.agentId);
        if (p.peer) state.peer = p.peer;
        if (p.port) state.port = String(p.port);
        if (p.mode === 'map') {
          state.mode = 'map';
          state.mapScope = p.locationId != null ? 'l' + p.locationId : 'fleet';
        }
      }

      // ---- the window --------------------------------------------------------
      function windowMs() {
        if (state.zoom) return { fromMs: state.zoom.fromMs, toMs: state.zoom.toMs };
        if (state.from && state.to) {
          return { fromMs: new Date(state.from).getTime(), toMs: new Date(state.to).getTime() };
        }
        var now = Date.now();
        return { fromMs: now - (PRESET_MS[state.preset] || PRESET_MS['1h']), toMs: now };
      }
      function clearZoom() { state.zoom = null; }
      // Agents report at a coarse cadence, so a very thin drag is padded to a
      // window that can actually contain a sample.
      function applyZoom(fromMs, toMs) {
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return;
        var a = Math.min(fromMs, toMs);
        var b = Math.max(fromMs, toMs);
        if (b - a < MIN_ZOOM_MS) {
          var mid = (a + b) / 2;
          a = Math.round(mid - MIN_ZOOM_MS / 2);
          b = Math.round(mid + MIN_ZOOM_MS / 2);
        }
        state.zoom = { fromMs: a, toMs: b };
        drawToolbar();
        refresh();
      }

      // ---- tabs + toolbar ----------------------------------------------------
      function drawTabs() {
        tabsHost.replaceChildren(ui.tabs([
          ['unified', t('flows.mode.unified')],
          ['bidi', t('flows.mode.bidi')],
          ['map', t('flows.mode.map')],
        ], {
          active: state.mode,
          ariaLabel: t('flows.modeLabel'),
          onPick: function (key) {
            if (state.mode === key) return;
            state.mode = key;
            deps.syncMode(key);
            drawToolbar();
            refresh();
          },
        }));
      }

      function textField(key, label, attrs) {
        var input = el('input', Object.assign({
          type: 'text', 'aria-label': label,
          oninput: function (e) { state[key] = e.target.value; },
          onkeydown: function (e) { if (e.key === 'Enter') refresh(); },
        }, attrs || {}));
        input.value = state[key] || '';
        return ui.filter(label, input);
      }

      // WHY there are no flows, rather than where to go and look.
      //
      // The hint used to say "check the source under Fleet", which is right and
      // is still a second screen and a guess. The view already holds the agent
      // rows, so it can say what the source actually IS — and "proc" is the
      // answer every single time this screen is empty on a fleet that has
      // never been switched over. A sentence that names the agent and its
      // source ends the question; a sentence that names a screen starts one.
      function noFlowsHint() {
        var id = state.agentId;
        if (!id) return t('flows.noFlowsHint');
        var agent = null;
        for (var i = 0; i < agents.length; i += 1) {
          if (String(agents[i].id) === String(id)) { agent = agents[i]; break; }
        }
        if (!agent) return t('flows.noFlowsHint');
        var source = String((agent.monitor_config && agent.monitor_config.source) || 'proc');
        if (source === 'netflow' || source === 'sflow') return t('flows.noFlowsHint.configured', { source: source });
        return t('flows.noFlowsHint.source', {
          agent: agent.display_name || agent.hostname || ('#' + agent.id),
          source: source,
        });
      }

      function drawToolbar() {
        var filters = [ui.filter(t('flows.agent'), ui.select({
          label: t('flows.agent'), value: state.agentId || '',
          options: agents.map(function (a) { return [String(a.id), a.display_name || a.hostname]; }),
          onchange: function (e) { state.agentId = e.target.value; refresh(); },
        }))];

        if (state.mode === 'map') {
          // Map scope is the map's own question: this agent, one site, or the
          // whole fleet. The peer filter means nothing to it.
          filters.push(ui.filter(t('flows.mapScope'), ui.select({
            label: t('flows.mapScope'), value: state.mapScope || 'agent',
            options: [['agent', t('flows.scope.agent')], ['fleet', t('flows.scope.fleet')]]
              .concat(sites.map(function (s) { return ['l' + s.id, t('flows.scope.site', { name: s.name })]; })),
            onchange: function (e) { state.mapScope = e.target.value; refresh(); },
          })));
        } else {
          filters.push(textField('peer', t('flows.peer'), { placeholder: t('flows.peer.placeholder') }));
        }
        if (state.mode === 'unified') {
          filters.push(
            textField('port', t('flows.port'), { type: 'number', min: '1', max: '65535', placeholder: t('flows.port') }),
            textField('proto', t('flows.proto'), { placeholder: 'tcp/udp' }),
            ui.filter(t('flows.direction'), ui.select({
              label: t('flows.direction'), value: state.direction || '',
              options: [['', t('flows.dir.all')], ['out', t('flows.dir.out')], ['in', t('flows.dir.in')]],
              onchange: function (e) { state.direction = e.target.value; refresh(); },
            })),
            ui.filter(t('flows.scope'), ui.select({
              label: t('flows.scope'), value: state.internal || '',
              options: [['', t('flows.scope.both')], ['external', t('flows.scope.external')], ['internal', t('flows.scope.internal')]],
              onchange: function (e) { state.internal = e.target.value; refresh(); },
            })));
        }

        // A range is a value, not a place, so it is a select rather than four
        // buttons pretending to be a tab strip.
        filters.push(ui.filter(t('flows.range'), ui.select({
          label: t('flows.range'), value: state.from && state.to ? 'custom' : state.preset,
          options: [
            ['15m', t('flows.range.15m')], ['1h', t('flows.range.1h')],
            ['6h', t('flows.range.6h')], ['24h', t('flows.range.24h')],
            ['custom', t('flows.range.custom')],
          ],
          onchange: function (e) {
            clearZoom();
            if (e.target.value === 'custom') { state.custom = true; } else {
              state.custom = false;
              state.preset = e.target.value;
              state.from = null;
              state.to = null;
            }
            drawToolbar();
            refresh();
          },
        })));

        if (state.custom || (state.from && state.to)) {
          filters.push(dateField('from', t('flows.from'), fromErr), dateField('to', t('flows.to'), toErr));
        }

        var actions = [ui.button('primary', t('flows.inspect'), { onclick: function () { refresh(); } })];
        if (state.zoom) {
          actions.unshift(ui.button('ghost', t('flows.resetZoom'), {
            title: t('flows.resetZoomHint'),
            onclick: function () { clearZoom(); drawToolbar(); refresh(); },
          }));
        }
        toolbarHost.replaceChildren(ui.toolbar({ filters: filters, actions: actions }));
      }

      function dateField(key, label, errNode) {
        var input = el('input', {
          type: 'datetime-local', 'aria-label': label,
          // Typing a custom range is an explicit intent, so it drops the zoom.
          onchange: function (e) { state[key] = e.target.value; clearZoom(); errNode.replaceChildren(); },
        });
        input.value = state[key] || '';
        return el('label', { class: 'field-inline' }, label, input, errNode);
      }

      // ---- shared pieces -----------------------------------------------------
      function talkerRows(list, onPick) {
        var sort = state.sort.talkers;
        var dir = sort.dir === 'asc' ? 1 : -1;
        var read = {
          src: function (x) { return String(x.srcIp || ''); },
          dst: function (x) { return String(x.dstIp || x.extIp || ''); },
          bytes: function (x) { return Number(x.bytes) || 0; },
          packets: function (x) { return Number(x.packets) || 0; },
          flows: function (x) { return Number(x.flowCount) || 0; },
        }[sort.key];
        var rows = read ? list.slice().sort(function (x, y) {
          var a = read(x);
          var b = read(y);
          if (a < b) return -1 * dir;
          if (a > b) return 1 * dir;
          return 0;
        }) : list;
        return rows.map(function (x) {
          return {
            talker: x,
            cells: {
              src: ui.meta(x.srcIp || '–'),
              dst: onPick
                ? ui.hostLink(x.dstIp || x.extIp || '–', function () { onPick(x); })
                : ui.meta(x.dstIp || x.extIp || '–'),
              org: x.internal
                ? ui.badge('info', t('flows.internal'))
                : ui.meta([x.asnName, x.country].filter(Boolean).join(' · ') || '–'),
              bytes: deps.fmtBytes(x.bytes),
              packets: x.packets == null ? '–' : String(x.packets),
              flows: String(x.flowCount),
            },
          };
        });
      }

      function talkerTable(list, opts) {
        var o = opts || {};
        return ui.dataTable({
          dense: true,
          columns: [
            { key: 'src', label: t('flows.col.src'), width: '190px', sortable: true },
            { key: 'dst', label: t('flows.col.dst'), width: '190px', sortable: true },
            { key: 'org', label: t('flows.col.org'), width: '220px' },
            { key: 'bytes', label: t('flows.col.bytes'), width: '120px', sortable: true, num: true },
            o.packets ? { key: 'packets', label: t('flows.col.packets'), width: '110px', sortable: true, num: true } : null,
            { key: 'flows', label: t('flows.col.flows'), width: '100px', sortable: true, num: true },
          ].filter(Boolean),
          rows: talkerRows(list, o.onPick),
          sort: state.sort.talkers,
          onSort: function (k) {
            var s = state.sort.talkers;
            state.sort.talkers = s.key === k
              ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' }
              : { key: k, dir: 'desc' };
            refresh();
          },
        });
      }

      function chartPanel(series, markers, title, note) {
        if (!series || series.length < 2) return null;
        var pts = series.map(function (s) { return { t: new Date(s.at).getTime(), y: s.bytes }; });
        return ui.panel({
          title: title,
          note: note,
          children: [el('div', { class: 'panel-body' },
            deps.chart(pts, { markers: markers, onBrush: applyZoom }),
            ui.metaXs(t('flows.zoomHint')))],
        });
      }

      function protoTable(list) {
        return ui.dataTable({
          dense: true,
          columns: [
            { key: 'proto', label: t('flows.col.proto') },
            { key: 'bytes', label: t('flows.col.bytes'), num: true },
            { key: 'flows', label: t('flows.col.flows'), num: true },
          ],
          rows: (list || []).slice(0, 8).map(function (p) {
            return {
              cells: {
                proto: ui.meta(p.proto || '–'),
                bytes: deps.fmtBytes(p.bytes),
                flows: String(p.flowCount),
              },
            };
          }),
        });
      }

      // ---- the three modes ---------------------------------------------------
      function fail(e, detail) {
        host.replaceChildren(ui.panel({
          title: t('flows.title'),
          children: [ui.errorState({
            title: t('flows.err.title'), body: deps.errText(e), detail: detail, onRetry: refresh,
          })],
        }));
      }

      function drawUnified(data, markers) {
        var panels = [];
        // A scan is the one thing on this page you did not go looking for, so
        // it goes first and says what it is.
        if (data.scans && data.scans.length) {
          panels.push(ui.panel({
            title: t('flows.scans'),
            note: t('flows.scans.note'),
            children: [ui.dataTable({
              dense: true,
              columns: [
                { key: 'src', label: t('flows.col.src'), width: '200px' },
                { key: 'kind', label: t('flows.col.kind'), width: '150px' },
                { key: 'ports', label: t('flows.col.ports'), width: '110px', num: true },
                { key: 'hosts', label: t('flows.col.hosts'), width: '110px', num: true },
                { key: 'bytes', label: t('flows.col.bytes'), width: '120px', num: true },
                { key: 'flows', label: t('flows.col.flows'), width: '100px', num: true },
              ],
              rows: data.scans.map(function (s) {
                return {
                  cells: {
                    src: ui.meta(s.srcIp),
                    kind: ui.badge(s.kind === 'port-scan' ? 'crit' : 'warn',
                      s.kind === 'port-scan' ? t('flows.portScan') : t('flows.fanOut')),
                    ports: String(s.distinctPorts),
                    hosts: String(s.distinctHosts),
                    bytes: deps.fmtBytes(s.bytes),
                    flows: String(s.flowCount),
                  },
                };
              }),
            })],
          }));
        }
        var chart = chartPanel(data.series, markers, t('flows.overTime'), totalsNote(data.totals));
        if (chart) panels.push(chart);

        panels.push(ui.panel({
          title: t('flows.talkers'),
          note: t('flows.talkers.note'),
          children: [data.topTalkers.length
            ? talkerTable(data.topTalkers, {
              packets: true,
              onPick: function (x) {
                state.peer = x.internal ? x.dstIp : (x.extIp || x.dstIp);
                drawToolbar();
                refresh();
              },
            })
            : ui.emptyState({ kind: 'nodata', title: t('flows.noFlows'), body: noFlowsHint() })],
        }));

        panels.push(ui.panelGrid(
          ui.panel({
            title: t('flows.ports'),
            children: [(data.byPort || []).length
              ? ui.dataTable({
                dense: true,
                // No width hints: this table shares a two-column grid, so the
                // columns have to give way to the panel rather than the panel
                // to them.
                columns: [
                  { key: 'port', label: t('flows.col.port'), num: true },
                  { key: 'service', label: t('flows.col.service') },
                  { key: 'proto', label: t('flows.col.proto') },
                  { key: 'bytes', label: t('flows.col.bytes'), num: true },
                  { key: 'flows', label: t('flows.col.flows'), num: true },
                ],
                rows: data.byPort.map(function (p) {
                  return {
                    cells: {
                      port: String(p.port),
                      service: p.service ? ui.badge('info', p.service) : ui.meta('–'),
                      proto: ui.meta(p.proto || '–'),
                      bytes: deps.fmtBytes(p.bytes),
                      flows: String(p.flowCount),
                    },
                  };
                }),
              })
              : ui.emptyState({ kind: 'nodata', title: t('flows.noPorts') })],
          }),
          ui.panel({
            title: t('flows.protos'),
            children: [(data.byProto || []).length
              ? protoTable(data.byProto)
              : ui.emptyState({ kind: 'nodata', title: t('flows.noProtos') })],
          })));

        host.replaceChildren.apply(host, panels);
      }

      function drawBidi(data, markers) {
        var asym = data.asymmetry || {};
        var panels = [];
        if (asym.ratio !== null && asym.ratio !== undefined) {
          var inPct = Math.round(asym.ratio * 100);
          panels.push(ui.inlineNote(
            asym.asymmetric
              ? t('flows.asym', { in: inPct, out: 100 - inPct })
              : t('flows.sym', { in: inPct, out: 100 - inPct }),
            asym.asymmetric ? 'warn' : null));
        }
        panels.push(ui.panelGrid(
          dirPanel(t('flows.ingress'), data.ingress, markers),
          dirPanel(t('flows.egress'), data.egress, markers)));
        host.replaceChildren.apply(host, panels);
      }

      function dirPanel(title, data, markers) {
        var kids = [];
        if (data.series && data.series.length >= 2) {
          var pts = data.series.map(function (s) { return { t: new Date(s.at).getTime(), y: s.bytes }; });
          kids.push(el('div', { class: 'panel-body' },
            deps.chart(pts, { markers: markers, onBrush: applyZoom })));
        } else {
          kids.push(ui.emptyState({ kind: 'nodata', title: t('flows.noFlows'), body: noFlowsHint() }));
        }
        if (data.topTalkers && data.topTalkers.length) {
          kids.push(el('div', { class: 'panel-body' }, ui.metaXs(t('flows.talkers'))));
          kids.push(talkerTable(data.topTalkers.slice(0, 20), {}));
        }
        if (data.byProto && data.byProto.length) {
          kids.push(el('div', { class: 'panel-body' }, ui.metaXs(t('flows.protos'))));
          kids.push(protoTable(data.byProto));
        }
        return ui.panel({
          title: title,
          note: deps.fmtBytes(data.totals.bytes),
          children: kids,
        });
      }

      function drawMap(data, cfg) {
        if (!data.arcs.length) {
          host.replaceChildren(ui.panel({
            title: t('flows.mode.map'),
            children: [ui.emptyState({ kind: 'nodata', title: t('flows.map.none'), body: t('flows.map.noneHint') })],
          }));
          return;
        }
        var canvas = el('div', { class: 'map traffic-map' });
        var chipsHost = el('div', {});
        var siteByKey = {};
        (data.sites || []).forEach(function (s) { siteByKey[s.key] = s; });
        var mapApi = null;

        var rows = data.arcs.slice(0, 25).map(function (a) {
          var site = siteByKey[a.siteKey];
          var pan = function () {
            if (mapApi && a.lat != null) {
              mapApi.map.setView([a.lat, a.lng], Math.max(mapApi.map.getZoom(), 4));
            }
          };
          return {
            cells: {
              // The category dot is built by app.js: the traffic-type ramp is a
              // per-category palette that has not been migrated.
              type: deps.typeDot(a.category),
              route: ui.hostLink((site ? site.name : '?') + ' → ' + a.country, pan),
              label: ui.metaXs(a.label + (a.asnNames && a.asnNames.length ? ' · ' + a.asnNames[0] : '')),
              dir: ui.badge(a.direction === 'in' ? 'info' : a.direction === 'both' ? 'neutral' : 'ok',
                t('flows.dir.' + (a.direction === 'in' ? 'in' : a.direction === 'both' ? 'both' : 'out'))),
              bytes: deps.fmtBytes(a.bytes),
            },
          };
        });

        host.replaceChildren(
          ui.panel({
            title: t('flows.mode.map'),
            note: t('flows.map.note', {
              bytes: deps.fmtBytes(data.totals.bytes),
              flows: data.totals.flowCount,
              destinations: data.totals.destinations,
            }),
            children: [el('div', { class: 'panel-body' }, canvas, deps.mapKey())],
          }),
          ui.panelGrid(
            ui.panel({ title: t('flows.trafficType'), children: [el('div', { class: 'panel-body' }, chipsHost)] }),
            ui.panel({
              title: t('flows.topFlows'),
              children: [ui.dataTable({
                dense: true,
                columns: [
                  { key: 'type', label: '', width: '36px' },
                  { key: 'route', label: t('flows.col.route'), width: '260px' },
                  { key: 'label', label: t('flows.col.what') },
                  { key: 'dir', label: t('flows.col.dir'), width: '110px' },
                  { key: 'bytes', label: t('flows.col.bytes'), width: '120px', num: true },
                ],
                rows: rows,
              })],
            })));

        mapApi = deps.drawMap(canvas, cfg, data);
        chipsHost.replaceChildren(deps.legendChips(data.categories, function () { return mapApi; }));
      }

      // ---- refresh -----------------------------------------------------------
      function refresh() {
        var w = windowMs();
        if (!Number.isFinite(w.fromMs) || !Number.isFinite(w.toMs) || w.toMs <= w.fromMs) {
          // A bad range belongs to the field that is wrong, not to the panel
          // where the data would have gone.
          toErr.replaceChildren(el('span', { class: 'field-error' }, t('flows.badRange')));
          return;
        }
        toErr.replaceChildren();
        deps.stopMaps();
        host.replaceChildren(ui.panel({ title: t('flows.title'), children: [ui.loadingState(5)] }));

        if (state.mode === 'map') {
          if (!deps.hasMapLibrary()) {
            host.replaceChildren(ui.panel({
              title: t('flows.mode.map'),
              children: [ui.emptyState({ icon: '◎', title: t('sites.noLibrary'), body: t('flows.map.noLibrary') })],
            }));
            return Promise.resolve();
          }
          return deps.fetchMap({ window: w, agentId: state.agentId, scope: state.mapScope || 'agent' })
            .then(function (r) { drawMap(r.data, r.cfg); })
            .catch(function (e) { fail(e, 'GET /api/flows/map'); });
        }

        if (state.mode === 'bidi') {
          return deps.fetchBidi({ window: w, agentId: state.agentId, peer: state.peer })
            .then(function (r) { drawBidi(r.data, r.markers); })
            .catch(function (e) { fail(e, 'GET /api/flows/bidirectional'); });
        }

        return deps.fetchExplore({
          window: w,
          agentId: state.agentId,
          peer: state.peer,
          port: state.port,
          proto: state.proto,
          direction: state.direction,
          internal: state.internal,
        })
          .then(function (r) { drawUnified(r.data, r.markers); })
          .catch(function (e) { fail(e, 'GET /api/flows/explore'); });
      }

      function totalsNote(totals) {
        return t('flows.totals', {
          bytes: deps.fmtBytes(totals.bytes), flows: totals.flowCount, records: totals.records == null ? '–' : totals.records,
        });
      }

      return deps.fetchAgents()
        .then(function (list) {
          agents = list;
          if (!agents.length) {
            host.replaceChildren(ui.panel({
              title: t('flows.title'),
              children: [ui.emptyState({ kind: 'nodata', title: t('flows.noAgents'), body: t('flows.noAgentsHint') })],
            }));
            return page;
          }
          // The map's site options are the sites that actually report.
          var seen = {};
          agents.forEach(function (a) {
            if (a.location_id != null && !seen[a.location_id]) {
              seen[a.location_id] = { id: a.location_id, name: a.location_name || ('#' + a.location_id) };
            }
          });
          sites = Object.keys(seen).map(function (k) { return seen[k]; })
            .sort(function (x, y) { return String(x.name).localeCompare(String(y.name)); });
          if (!state.agentId || !agents.some(function (a) { return String(a.id) === String(state.agentId); })) {
            state.agentId = String(deps.selectedAgentId() || agents[0].id);
          }
          takePrefill();
          drawTabs();
          drawToolbar();
          return refresh().then(function () { return page; });
        });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.FlowsPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
