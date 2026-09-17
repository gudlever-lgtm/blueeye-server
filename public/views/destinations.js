// public/views/destinations.js — Destinations, as a ListPage (template A).
//
// Where your traffic actually goes: your sites and the external destinations
// they talk to, on one map, with the volume and the deviation from normal.
// Built from the contract's components (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * the always-on side panel becomes the Drawer. A destination, a site pin
//     and a region all opened it with different content and no way to tell
//     which one you were looking at; the Drawer has a title, a close, Escape
//     and a focus return, and it gives the map the full width when it is shut;
//   * "Top destinations" becomes a DataTable, sortable, with the deviation as
//     a badge rather than a coloured dot and a percentage;
//   * both colour scales — health for sites, deviation for destinations — come
//     from the palette through ui.token() instead of six hex literals;
//   * the GeoIP warning becomes an inline note rather than a banner.
//
// The Leaflet instance, the region rectangle and the traceroute path layer stay
// in app.js: they are live objects carrying the reader's pan, zoom and
// selection. The view asks for a canvas and app.js mounts the map into it.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    // A destination's colour is its deviation from what is normal for it.
    // Three steps, the same three the badge uses.
    function devTone(dev) {
      var d = Number(dev) || 0;
      if (d >= 0.75) return 'crit';
      if (d >= 0.2) return 'warn';
      return 'info';
    }
    var TONE_TOKEN = { crit: '--sev-crit', warn: '--sev-warn', info: '--sev-info', ok: '--sev-ok' };
    function toneColor(tone) { return ui.token(TONE_TOKEN[tone] || '--text-muted'); }
    function devLabel(dev) {
      var d = Number(dev) || 0;
      return (d > 0 ? '+' : '') + Math.round(d * 100) + '%';
    }
    function destTitle(d) {
      return (d.country || '??')
        + (d.asn ? ' · AS' + d.asn : '')
        + (d.asnName ? ' ' + d.asnName : '');
    }

    function view() {
      var state = deps.state;
      if (!state.sort) state.sort = { key: 'bytes', dir: 'desc' };
      if (!state.period) state.period = '24h';

      var page = ui.page();
      var noteHost = el('div', {});
      var toolbarHost = el('div', {});
      var mapHost = el('div', {});
      var pathHost = el('div', {});
      var tableHost = el('div', {});

      var dests = [];
      var agents = [];
      var config = {};

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('dest.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
        actions: [ui.button('secondary', t('dest.openProbes'), {
          onclick: function () { deps.gotoView('probes'); },
        })],
      }), noteHost, toolbarHost, mapHost, pathHost, tableHost);

      // ---- Toolbar -----------------------------------------------------------
      function drawToolbar() {
        toolbarHost.replaceChildren(ui.toolbar({
          filters: [ui.filter(t('dest.period'), ui.select({
            label: t('dest.period'), value: state.period,
            options: [['24h', t('dest.period.24h')], ['7d', t('dest.period.7d')], ['30d', t('dest.period.30d')]],
            onchange: function (e) {
              state.period = e.target.value;
              deps.setPeriod(state.period);
              reload();
            },
          }))],
          actions: [
            ui.button('secondary', t('dest.selectRegion'), {
              title: t('dest.selectRegionHint'),
              onclick: function () { deps.beginRegionSelect(); },
            }),
            ui.button('ghost', t('dest.exportCsv'), { onclick: function () { deps.exportAs('csv'); } }),
            ui.button('ghost', t('dest.exportJson'), { onclick: function () { deps.exportAs('json'); } }),
          ],
        }));
      }

      // ---- the map panel -----------------------------------------------------
      // Sites take the health scale, destinations the deviation scale. Two
      // scales on one map needs saying, which is what the legend is for.
      function legend() {
        var item = function (cls, label) {
          return el('span', { class: 'ui-legend-item' },
            el('span', { class: 'ui-legend-dot ' + cls }), label);
        };
        return el('div', { class: 'ui-chart-legend site-legend' },
          ui.metaXs(t('dest.legend.sites')),
          item('health-ok', t('sites.health.ok')),
          item('health-warn', t('sites.health.warn')),
          item('health-bad', t('sites.health.bad')),
          ui.metaXs(t('dest.legend.dests')),
          item('dev-info', t('dest.dev.normal')),
          item('dev-warn', t('dest.dev.elevated')),
          item('dev-crit', t('dest.dev.strong')),
          ui.metaXs(t('dest.legend.size')));
      }

      var pathAgentSel = null;
      var pathTargetInput = null;
      var pathTargetList = null;
      var showPathBtn = null;

      // The traceroute overlay belongs to the map, so its controls sit in the
      // map panel rather than in the page toolbar.
      function pathToolbar() {
        pathTargetList = el('datalist', { id: 'geo-path-targets' });
        pathAgentSel = ui.select({
          label: t('dest.path.agent'), value: '',
          options: [['', t('dest.path.agent')]].concat(agents.map(function (a) {
            return [String(a.id), a.display_name || a.hostname];
          })),
          onchange: function () {
            // Only the SUGGESTIONS are per-agent. Clearing the box threw away a
            // target the operator had already typed, every time they picked the
            // agent second — so the typed value stays and the list refreshes
            // under it.
            deps.loadPathTargets(pathAgentSel.value, pathTargetList);
          },
        });
        pathTargetInput = el('input', {
          type: 'text', list: 'geo-path-targets',
          'aria-label': t('dest.path.target'), placeholder: t('dest.path.target'),
        });
        showPathBtn = ui.button('secondary', t('dest.path.show'), { onclick: runPath });
        return ui.toolbar({
          filters: [
            ui.filter(t('dest.path'), pathAgentSel),
            ui.filter(t('dest.path.targetLabel'), pathTargetInput),
            pathTargetList,
          ],
          actions: [showPathBtn, ui.button('ghost', t('dest.path.clear'), { onclick: clearPath })],
        });
      }

      function runPath() {
        var agentId = pathAgentSel.value;
        var target = pathTargetInput.value.trim();
        if (!agentId) { ui.toast(t('dest.path.pickAgent'), null, { bad: true, focus: pathAgentSel }); return; }
        if (!target) { ui.toast(t('dest.path.pickTarget'), null, { bad: true, focus: pathTargetInput }); return; }
        showPathBtn.disabled = true;
        showPathBtn.textContent = t('dest.path.running');
        deps.showPath(agentId, target)
          .then(function (graph) {
            // A run that produced no path still gets a PANEL. It used to get a
            // toast and nothing else, so "Show path" looked like it had done
            // nothing at all — and the reason, which the agent had reported all
            // along, was never shown anywhere.
            if (graph && graph.empty) drawNoPath(graph);
            else if (graph) drawPath(graph);
            else ui.toast(t('dest.path.none'), null, { bad: true });
          })
          .catch(function (e) { ui.toast(t('dest.err.path'), deps.errText(e), { bad: true }); })
          .then(function () {
            showPathBtn.disabled = false;
            showPathBtn.textContent = t('dest.path.show');
          });
      }
      // No path came back. Say which of the two things happened — the probe
      // failed (with the agent's own reason), or it has not reported yet.
      function drawNoPath(res) {
        pathHost.replaceChildren(ui.panel({
          title: t('dest.path.panel'),
          note: t('dest.path.note', { target: res.target || '—', runs: 0, stops: 0 }),
          actions: [ui.button('ghost', t('dest.path.clear'), { onclick: clearPath })],
          children: [
            ui.inlineNote(t('dest.path.what')),
            res.reason
              ? ui.inlineNote(t('dest.path.failed', { why: res.reason }), 'crit')
              : ui.inlineNote(t('dest.path.pending', { target: res.target || '—' }), 'warn'),
            ui.emptyState({
              kind: 'nodata',
              title: t('dest.path.noStops'),
              body: res.reason ? t('dest.path.noStopsFailed') : t('dest.path.noStopsPending'),
            }),
          ],
        }));
      }

      function clearPath() {
        deps.clearPath();
        pathHost.replaceChildren();
      }

      // A drawn path gets its own panel under the map — it is about the map,
      // and it goes away with "Clear path".
      function drawPath(graph) {
        var stops = graph.stops || [];
        var hops = (graph.nodes || []).filter(function (n) { return n.kind !== 'source'; });
        var RANK = { bad: 3, warn: 2, muted: 1, ok: 0 };
        var worst = hops.reduce(function (w, n) {
          return (RANK[n.severity] || 0) > (RANK[w && w.severity] || 0) ? n : w;
        }, null);
        var body = stops.length
          ? el('ul', { class: 'path-stops' }, stops.map(function (s) {
            var isSrc = s.nodes.some(function (n) { return n.kind === 'source'; });
            var place = isSrc ? (s.nodes[0].label || t('dest.path.origin')) : (s.nodes[0].country || '—');
            var hopLabel = isSrc ? t('dest.path.origin')
              : s.nodes.length > 1
                ? t('dest.path.hops', { from: s.nodes[0].hop, to: s.nodes[s.nodes.length - 1].hop })
                : t('dest.path.hop', { n: s.nodes[0].hop });
            return el('li', {},
              el('span', { class: 'ui-legend-dot sev-' + (s.severity || 'ok') }),
              el('span', {}, String(place)),
              ui.metaXs(hopLabel));
          }))
          : ui.emptyState({ icon: '↯', title: t('dest.path.noStops'), body: t('dest.path.noStopsHint') });

        pathHost.replaceChildren(ui.panel({
          title: t('dest.path.panel'),
          note: t('dest.path.note', { target: graph.target || '—', runs: graph.samples || 0, stops: stops.length }),
          actions: [ui.button('ghost', t('dest.path.clear'), { onclick: clearPath })],
          children: [
            ui.inlineNote(t('dest.path.what')),
            worst && (RANK[worst.severity] || 0) > 0
              ? ui.inlineNote(t('dest.path.worst', { hop: worst.hop, why: worst.explain || '' }),
                worst.severity === 'bad' ? 'crit' : 'warn')
              : null,
            // A run that produced nothing placeable is a different thing from
            // no run at all, and the reason is actionable.
            graph.samples > 0 && stops.length < 2
              ? ui.inlineNote(hops.length
                ? t('dest.path.unplaceable', { n: hops.length })
                : (graph.detail
                  ? t('dest.path.failed', { why: graph.detail })
                  : t('dest.path.noHops')), 'warn')
              : null,
            body,
          ].filter(Boolean),
        }));
      }

      // Mounted ONCE. A period change redraws the markers and retitles the
      // panel; rebuilding the map would throw away the reader's pan and zoom,
      // which is the one thing a map is for.
      function mapNote() {
        return t('dest.mapNote', { n: dests.length, bytes: deps.fmtBytes(totalBytes()) });
      }
      function drawMap() {
        if (!deps.hasMapLibrary()) {
          mapHost.replaceChildren(ui.panel({
            title: t('dest.map'),
            children: [ui.emptyState({
              icon: '◎', title: t('sites.noLibrary'), body: t('dest.noLibraryHint'),
            })],
          }));
          return;
        }
        var canvas = el('div', { class: 'site-map' });
        mapHost.replaceChildren(ui.panel({
          title: t('dest.map'),
          note: mapNote(),
          // "72 destinations, but the path has 9 hops?" — the two counts share a
          // map and count different things, so each says what it counts.
          children: [ui.inlineNote(t('dest.mapNote.what')), pathToolbar(),
            el('div', { class: 'panel-body' }, canvas, legend())],
        }));
        deps.mountMap(canvas, {
          healthColor: function (status) { return ui.healthColor(status); },
          devColor: function (dev) { return toneColor(devTone(dev)); },
          ringColor: ui.token('--surface'),
          selectColor: ui.token('--sev-info'),
          onDestination: openDestination,
          onHost: openHost,
          onRegion: openRegion,
        });
      }

      function totalBytes() {
        return dests.reduce(function (s, d) { return s + (Number(d.bytes) || 0); }, 0);
      }

      // ---- the table ---------------------------------------------------------
      function drawTable() {
        if (!dests.length) {
          tableHost.replaceChildren(ui.panel({
            title: t('dest.panel'),
            children: [ui.emptyState({
              title: t('dest.none'),
              body: config.geoip && config.geoip.configured === false
                ? t('dest.noneNoGeoip') : t('dest.noneHint'),
            })],
          }));
          return;
        }
        var list = dests.slice();
        var dir = state.sort.dir === 'asc' ? 1 : -1;
        var key = state.sort.key;
        list.sort(function (x, y) {
          var a; var b;
          if (key === 'bytes') { a = Number(x.bytes) || 0; b = Number(y.bytes) || 0; }
          else if (key === 'dev') { a = Number(x.deviation) || 0; b = Number(y.deviation) || 0; }
          else if (key === 'flows') { a = Number(x.flowCount) || 0; b = Number(y.flowCount) || 0; }
          else { a = destTitle(x).toLowerCase(); b = destTitle(y).toLowerCase(); }
          if (a < b) return -1 * dir;
          if (a > b) return 1 * dir;
          return 0;
        });
        tableHost.replaceChildren(ui.panel({
          title: t('dest.panel'),
          note: t('dest.count', { n: dests.length }),
          children: [ui.dataTable({
            columns: [
              { key: 'dest', label: t('dest.col.dest'), width: '300px', sortable: true },
              { key: 'bytes', label: t('dest.col.volume'), width: '150px', sortable: true, num: true },
              { key: 'flows', label: t('dest.col.flows'), width: '130px', sortable: true, num: true },
              { key: 'dev', label: t('dest.col.dev'), width: '150px', sortable: true },
            ],
            rows: list.slice(0, 200).map(function (d) {
              var tone = devTone(d.deviation);
              return {
                d: d,
                cells: {
                  dest: ui.hostLink(destTitle(d), function () { openDestination(d); }),
                  bytes: deps.fmtBytes(d.bytes),
                  flows: d.flowCount == null ? '–' : String(d.flowCount),
                  dev: ui.badge(tone, devLabel(d.deviation)),
                },
              };
            }),
            sort: state.sort,
            onSort: function (k) {
              state.sort = state.sort.key === k
                ? { key: k, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
                : { key: k, dir: 'desc' };
              drawTable();
            },
            onOpen: function (row, tr) { openDestination(row.d, tr); },
          })],
        }));
      }

      // ---- the Drawer --------------------------------------------------------
      // One place for detail, whatever was clicked: a circle, a site pin, a row
      // or a dragged region.
      function loadingDrawer(title, row) {
        return ui.openDrawer({
          title: title, row: row || null,
          sections: [ui.loadingState(3)],
        });
      }
      function fillDrawer(panelEl, sections) {
        var body = panelEl.querySelector('.drawer-body');
        if (body) body.replaceChildren.apply(body, sections.filter(Boolean));
      }
      function failDrawer(panelEl, e, detail) {
        fillDrawer(panelEl, [ui.errorState({
          title: t('dest.err.detail'), body: deps.errText(e), detail: detail,
        })]);
      }
      function findingList(list) {
        if (!list.length) return ui.metaXs(t('dest.noFindings'));
        return el('ul', { class: 'hist' }, list.slice(0, 50).map(function (f) {
          return el('li', {},
            ui.badge(f.severity === 'CRIT' ? 'crit' : f.severity === 'WARN' ? 'warn' : 'info',
              f.severity || 'INFO'),
            el('span', {}, ' ' + (f.metric || '') + ' '),
            ui.metaXs(f.explanation || ''));
        }));
      }

      function openDestination(d, row) {
        var panelEl = loadingDrawer(destTitle(d), row);
        deps.fetchDestination(d)
          .then(function (res) {
            if (!res) { fillDrawer(panelEl, [ui.emptyState({ kind: 'nodata', title: t('dest.noData'), body: t('dest.noDataHint') })]); return; }
            var flows = res.flows;
            var findings = res.findings || [];
            fillDrawer(panelEl, [
              ui.drawerSection(t('dest.drawer.totals'), ui.keyValues([
                [t('dest.col.volume'), deps.fmtBytes(flows.totals.bytes)],
                [t('dest.col.flows'), String(flows.totals.flowCount)],
                [t('dest.col.dev'), ui.badge(devTone(d.deviation), devLabel(d.deviation))],
              ])),
              ui.drawerSection(t('dest.drawer.direction'), ui.keyValues((flows.byDirection || []).map(function (x) {
                return [x.direction === 'in' ? t('dest.inbound') : t('dest.outbound'), deps.fmtBytes(x.bytes)];
              }))),
              ui.drawerSection(t('dest.drawer.proto'), ui.keyValues((flows.byProto || []).map(function (x) {
                return [x.proto || '–', deps.fmtBytes(x.bytes)];
              }))),
              ui.drawerSection(t('dest.drawer.asn'), ui.keyValues((flows.byAsn || []).map(function (x) {
                return [x.asnName || (x.asn ? 'AS' + x.asn : '–'), deps.fmtBytes(x.bytes)];
              }))),
              ui.drawerSection(t('dest.drawer.findings', { n: findings.length }), findingList(findings)),
            ]);
          })
          .catch(function (e) { failDrawer(panelEl, e, 'GET /api/geo/select/flows'); });
      }

      function openHost(h) {
        var name = h.siteName || t('dest.hostN', { id: h.hostId });
        var panelEl = loadingDrawer(name);
        deps.fetchHost(h)
          .then(function (findings) {
            fillDrawer(panelEl, [
              ui.drawerSection(t('dest.drawer.site'), ui.keyValues([
                [t('dest.col.status'), ui.badge(h.status === 'online' ? 'ok' : 'neutral', h.status || '?')],
                [t('dest.host'), String(h.hostId)],
              ])),
              ui.drawerSection(t('dest.drawer.findings', { n: findings.length }), findingList(findings)),
            ]);
          })
          .catch(function (e) { failDrawer(panelEl, e, 'GET /api/findings'); });
      }

      function openRegion(inBox) {
        var panelEl = loadingDrawer(t('dest.drawer.region'));
        if (!inBox.length) {
          fillDrawer(panelEl, [ui.emptyState({ kind: 'nodata', title: t('dest.regionEmpty'), body: t('dest.regionEmptyHint') })]);
          return;
        }
        var bytes = inBox.reduce(function (s, d) { return s + (Number(d.bytes) || 0); }, 0);
        var flows = inBox.reduce(function (s, d) { return s + (Number(d.flowCount) || 0); }, 0);
        var head = [
          ui.drawerSection(t('dest.drawer.totals'), ui.keyValues([
            [t('dest.col.dest'), String(inBox.length)],
            [t('dest.col.volume'), deps.fmtBytes(bytes)],
            [t('dest.col.flows'), String(flows)],
          ])),
          ui.drawerSection(t('dest.drawer.top'), ui.keyValues(inBox.slice()
            .sort(function (a, b) { return (b.bytes || 0) - (a.bytes || 0); })
            .slice(0, 20)
            .map(function (d) { return [destTitle(d), deps.fmtBytes(d.bytes)]; }))),
        ];
        fillDrawer(panelEl, head.concat([ui.loadingState(2)]));
        deps.fetchRegionFindings(inBox)
          .then(function (findings) {
            fillDrawer(panelEl, head.concat([
              ui.drawerSection(t('dest.drawer.findings', { n: findings.length }), findingList(findings)),
            ]));
          })
          .catch(function () {
            fillDrawer(panelEl, head.concat([ui.metaXs(t('dest.regionFindingsFailed'))]));
          });
      }

      // ---- load --------------------------------------------------------------
      function drawNote() {
        if (config.geoip && config.geoip.configured === false) {
          noteHost.replaceChildren(ui.inlineNote(
            deps.isAdmin() ? t('dest.noGeoip.admin') : t('dest.noGeoip'), 'warn'));
        } else {
          noteHost.replaceChildren();
        }
      }

      function reload() {
        return deps.fetchOverview()
          .then(function (d) {
            dests = d.destinations || [];
            deps.redraw(d);
            drawTable();
            var note = mapHost.querySelector('.panel-head .meta-xs');
            if (note) note.textContent = mapNote();
          })
          .catch(function (e) {
            tableHost.replaceChildren(ui.panel({
              title: t('dest.panel'),
              children: [ui.errorState({
                title: t('dest.err.title'), body: deps.errText(e),
                detail: 'GET /api/geo/overview', onRetry: reload,
              })],
            }));
          });
      }

      tableHost.replaceChildren(ui.panel({ title: t('dest.panel'), children: [ui.loadingState(5)] }));
      drawToolbar();
      return deps.fetchFirst()
        .then(function (d) {
          config = d.config || {};
          agents = d.agents || [];
          dests = d.destinations || [];
          drawNote();
          drawMap();
          drawTable();
          return page;
        })
        .catch(function (e) {
          tableHost.replaceChildren(ui.panel({
            title: t('dest.panel'),
            children: [ui.errorState({
              title: t('dest.err.title'), body: deps.errText(e),
              detail: 'GET /api/geo/overview', onRetry: reload,
            })],
          }));
          return page;
        });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.DestinationsView = apiObj;
})(typeof window !== 'undefined' ? window : null);
