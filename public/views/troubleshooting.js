// public/views/troubleshooting.js — Troubleshooting, as a DashboardPage
// (template B).
//
// What is failing, what it affects, and when it started: four zones — the key
// figures, the topology, the correlated root causes, and the timeline the
// faults sit on. Built from the contract's components (public/ui.js,
// docs/ui-contract.md).
//
// What this migration changes:
//   * the four KPI cards become a StatStrip, and "Active faults" becomes the
//     doorway to the raw list rather than carrying a link inside a card;
//   * a root cause carried three buttons — Show path, What changed?, Open
//     situation — which stacked into a three-line block on any screen narrower
//     than a desk. Show path is the row's one action, the other two are behind
//     the ⋯ menu, the same fix Analysis got;
//   * the raw fault list and the baseline deviations become DataTables;
//   * "Partial data — unavailable: …" was grey text in a control bar. It is an
//     inline note, in warn, above the data it is about.
//
// What it keeps, deliberately: the fault list stays opt-in and paged — a fleet
// can carry tens of thousands of raw alarms behind its root causes, and paying
// for them to paint the screen is what made this tab slow — and the timeline
// keeps its drag-to-brush.
//
// The topology SVG (`tshootTopologySvg`), the timeline rows
// (`TimelineView.renderRow`) and the brush geometry stay in app.js: they are
// their own components. The view asks for them and app.js hands them over.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;
    var TV = deps.TV;

    var FAULT_PAGE = 100;
    var SEV_TONE = { CRIT: 'crit', WARN: 'warn', INFO: 'info', crit: 'crit', warn: 'warn', info: 'info' };
    function sevTone(sev) { return SEV_TONE[sev] || 'neutral'; }

    function view() {
      var state = deps.state;
      if (!state.window) state.window = '1440';

      var page = ui.page();
      var toolbarHost = el('div', {});
      var noteHost = el('div', {});
      var stripHost = el('div', {});
      var topoHost = el('div', {});
      var causeHost = el('div', { class: 'panel-stack' });
      var faultsHost = el('div', {});
      var timelineHost = el('div', {});

      var data = null;
      var graphEl = null;
      var brush = null; // { fromMs, toMs } or null
      // A fleet can carry tens of thousands of raw alarms behind its root
      // causes, so this list is opt-in and paged; the overview read never
      // touches it.
      var faults = { open: false, rows: [], total: 0, loading: false, error: null, loaded: false };

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('tshoot.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
        actions: [ui.button('secondary', t('tshoot.openTopology'), {
          onclick: function () { deps.gotoView('topology'); },
        })],
      }), toolbarHost, noteHost, stripHost, topoHost, causeHost, faultsHost, timelineHost);

      // ---- Toolbar -----------------------------------------------------------
      var refreshBtn = null;
      function drawToolbar() {
        refreshBtn = ui.button('secondary', t('tshoot.refresh'), { onclick: function () { load(); } });
        toolbarHost.replaceChildren(ui.toolbar({
          filters: [ui.filter(t('tshoot.window'), ui.select({
            label: t('tshoot.window'), value: state.window,
            options: [
              ['60', t('tshoot.window.1h')], ['360', t('tshoot.window.6h')],
              ['1440', t('tshoot.window.24h')], ['10080', t('tshoot.window.7d')],
            ],
            onchange: function (e) { state.window = e.target.value; load(); },
          }))],
          actions: [refreshBtn],
        }));
      }

      // ---- StatStrip ---------------------------------------------------------
      // The figure is free (it comes off the cluster rows); the rows behind it
      // are not. So the card is the doorway, and opening it is a decision.
      function drawStrip() {
        var cards = TV.kpiCards(data.summary);
        stripHost.replaceChildren(ui.statStrip(cards.map(function (c) {
          var tone = !c.value ? undefined
            : (c.key === 'rootCauses' || c.key === 'activeFaults') ? 'crit' : 'warn';
          var card = { value: c.value, label: c.label, title: c.hint, tone: tone };
          if (c.key === 'activeFaults' && c.value) {
            card.active = faults.open;
            card.title = faults.open ? t('tshoot.faults.hide') : t('tshoot.faults.link', { count: c.value });
            card.onclick = function () { if (faults.open) closeFaults(); else openFaults(); };
          }
          return card;
        })));
      }

      // ---- topology ----------------------------------------------------------
      function drawTopology() {
        var topo = data.topology || { nodes: [], links: [], counts: {}, layers: {} };
        var counts = topo.counts || {};
        var layers = topo.layers || {};
        var detail = el('div', { class: 'ts-node-detail' }, ui.metaXs(t('tshoot.pickNode')));
        var graphSlot = el('div', {});
        var layerSel = ui.select({
          label: t('tshoot.layer'), value: state.layer || 'all',
          options: [
            ['all', t('tshoot.layer.all', { l2: layers.l2 || 0, l3: layers.l3 || 0 })],
            ['l2', t('tshoot.layer.l2', { n: layers.l2 || 0 })],
            ['l3', t('tshoot.layer.l3', { n: layers.l3 || 0 })],
          ],
          onchange: function (e) { state.layer = e.target.value; draw(); },
        });

        function draw() {
          graphEl = deps.topologySvg(topo, {
            layerFilter: state.layer || 'all',
            onSelect: function (n) {
              detail.replaceChildren(
                el('div', { class: 'ts-node-head' },
                  el('strong', {}, n.label),
                  ui.badge(n.state === 'down' ? 'crit' : n.state === 'ok' ? 'ok' : 'neutral', TV.stateLabel(n.state))),
                ui.metaXs(n.lastSeen ? t('tshoot.lastSeen', { when: ui.fmt.abs(n.lastSeen) }) : t('tshoot.neverSeen')),
                ui.button('secondary', t('tshoot.openAgent'), {
                  size: 'xs', onclick: function () { deps.openAgent(n.id); },
                }));
            },
          });
          graphSlot.replaceChildren(graphEl);
        }
        draw();

        var legend = el('div', { class: 'ui-chart-legend site-legend' },
          el('span', { class: 'ui-legend-item' }, el('span', { class: 'ui-legend-dot health-ok' }),
            t('tshoot.state.ok', { n: counts.ok || 0 })),
          el('span', { class: 'ui-legend-item' }, el('span', { class: 'ui-legend-dot health-bad' }),
            t('tshoot.state.down', { n: counts.down || 0 })),
          el('span', { class: 'ui-legend-item' }, el('span', { class: 'ui-legend-dot health-warn' }),
            t('tshoot.state.unreachable', { n: counts.unreachable_downstream || 0 })));

        var discovered = (topo.discovered || []).length;
        topoHost.replaceChildren(ui.panel({
          title: t('tshoot.topology'),
          actions: [layerSel],
          children: [
            el('div', { class: 'panel-body' }, graphSlot, legend, detail,
              // Something the active scan found that nobody has promoted is a
              // hole in this graph, so it is said here rather than nowhere.
              discovered ? ui.inlineNote(t('tshoot.discovered', { n: discovered }), 'info') : null),
          ].filter(Boolean),
        }));
      }

      // ---- root causes -------------------------------------------------------
      function showPath(model, host) {
        if (model.pathAnchorId == null) return;
        host.replaceChildren(ui.metaXs(t('tshoot.path.loading')));
        deps.blastRadius(model.pathAnchorId)
          .then(function (ids) {
            if (graphEl && graphEl.highlightPath) {
              graphEl.highlightPath([Number(model.pathAnchorId)].concat(ids));
            }
            // replaceChildren stringifies null, so the optional control is
            // filtered rather than passed through as a kid.
            host.replaceChildren.apply(host, [
              ui.metaXs(ids.length ? t('tshoot.path.found', { n: ids.length }) : t('tshoot.path.none')),
              ids.length ? ui.button('ghost', t('tshoot.path.clear'), {
                size: 'xs',
                onclick: function () {
                  if (graphEl && graphEl.clearPath) graphEl.clearPath();
                  host.replaceChildren();
                },
              }) : null,
            ].filter(Boolean));
          })
          .catch(function (e) {
            host.replaceChildren(ui.inlineNote(t('tshoot.path.failed', { message: deps.errText(e) }), 'crit'));
          });
      }

      function showChanges(model, host) {
        var changes = TV.changesBefore(data.timeline, model.firstSeen, 30 * 60 * 1000);
        if (!changes.length) {
          host.replaceChildren(ui.metaXs(t('tshoot.changes.none')));
          return;
        }
        var ul = el('ul', { class: 'timeline' });
        changes.forEach(function (e) { ul.append(deps.timelineRow(e)); });
        host.replaceChildren(ui.metaXs(t('tshoot.changes.some', { n: changes.length })), ul);
      }

      function drawRootCauses() {
        var causes = (data.rootCauses || []).map(TV.rootCauseModel);
        var children = [];
        if (!causes.length) {
          children.push(ui.emptyState({ kind: 'ok', title: t('tshoot.causes.none'), body: t('tshoot.causes.noneHint') }));
        } else {
          children.push(el('div', { class: 'panel-body' }, causes.map(function (m) {
            var slot = el('div', { class: 'ts-cause-slot' });
            // One action on the row, everything else behind the ⋯ menu — the
            // same fix Analysis got, for the same three stacked buttons.
            var actions = ui.rowActions(
              m.pathAnchorId == null ? null : {
                label: t('tshoot.showPath'), onclick: function () { showPath(m, slot); },
              },
              [
                { label: t('tshoot.whatChanged'), onclick: function () { showChanges(m, slot); } },
                { label: t('tshoot.openSituation'), onclick: function () { deps.openCluster(m.id); } },
              ]);
            return el('div', { class: 'ts-cause' },
              el('div', { class: 'ts-cause-head' },
                ui.badge(sevTone(m.severity), m.severity),
                el('strong', {}, m.cause),
                m.confidence ? ui.meta(t('tshoot.confidence', { level: m.confidence })) : null,
                actions),
              el('div', { class: 'ts-cause-meta' },
                ui.metaXs(m.affectedText),
                m.blastText ? ui.metaXs(m.blastText) : null,
                m.firstSeen ? ui.metaXs(t('tshoot.since', { when: ui.fmt.abs(m.firstSeen) })) : null),
              slot);
          })));
        }
        var panels = [ui.panel({
          title: t('tshoot.causes'),
          note: causes.length
            ? t('tshoot.causes.note', { alarms: data.summary.activeFaults, causes: causes.length })
            : null,
          children: children,
        })];

        // Baseline deviations ride under the causes: they are the same
        // question asked of the flows rather than of the alarms.
        var anoms = data.anomalies || [];
        if (anoms.length) {
          panels.push(ui.panel({
            title: t('tshoot.anoms'),
            note: t('tshoot.anoms.note'),
            children: [ui.dataTable({
              dense: true,
              columns: [
                { key: 'pair', label: t('tshoot.anoms.pair') },
                { key: 'dev', label: t('tshoot.anoms.dev'), width: '170px', num: true },
                { key: 'since', label: t('tshoot.anoms.since'), width: '190px', time: true },
              ],
              rows: anoms.slice(0, 25).map(function (a) {
                return {
                  cells: {
                    pair: el('code', {}, a.linkId),
                    dev: a.currentVsBaselinePct == null ? '—'
                      : (a.currentVsBaselinePct > 0 ? '+' : '') + a.currentVsBaselinePct + '%',
                    since: a.since ? ui.fmt.abs(a.since) : '—',
                  },
                };
              }),
            })],
          }));
        }
        causeHost.replaceChildren.apply(causeHost, panels);
      }

      // ---- the raw fault list (opt-in) ---------------------------------------
      function deviceLabels() {
        var byId = {};
        ((data && data.topology && data.topology.nodes) || []).forEach(function (n) {
          byId[String(n.id)] = n.label;
        });
        return byId;
      }

      function drawFaults() {
        if (!faults.open) { faultsHost.replaceChildren(); return; }
        if (faults.error) {
          faultsHost.replaceChildren(ui.panel({
            title: t('tshoot.faults.title'),
            children: [ui.errorState({
              title: t('tshoot.faults.errTitle'), body: faults.error,
              detail: 'GET /api/troubleshooting/faults', onRetry: loadFaultPage,
            })],
          }));
          return;
        }
        // The counter is the whole point of the opt-in: a long read has to say
        // how far it has got, not spin.
        var progress = TV.faultProgress({
          loaded: faults.rows.length, total: faults.total, loading: faults.loading,
        });
        var next = TV.faultsRemaining({ loaded: faults.rows.length, total: faults.total }, FAULT_PAGE);
        var labels = deviceLabels();
        var children = [];
        if (!faults.rows.length) {
          children.push(faults.loading
            ? ui.loadingState(5)
            : ui.emptyState({ kind: 'ok', title: t('tshoot.faults.empty'), body: t('tshoot.faults.emptyHint') }));
        } else {
          children.push(ui.dataTable({
            dense: true,
            columns: [
              { key: 'sev', label: t('tshoot.faults.colSeverity'), width: '110px' },
              { key: 'host', label: t('tshoot.faults.colHost'), width: '220px' },
              { key: 'metric', label: t('tshoot.faults.colMetric'), width: '200px' },
              { key: 'when', label: t('tshoot.faults.colWhen'), width: '190px', time: true },
              { key: 'cause', label: t('tshoot.faults.colCause') },
            ],
            rows: faults.rows.map(function (f) {
              var m = TV.faultRowModel(f, labels);
              return {
                // A fault whose finding retention has already purged still gets
                // a row — the cluster counts it, so hiding it would make the
                // "x of y" counter unreachable — dimmed, with nothing invented.
                dimmed: !!m.missing,
                cells: {
                  sev: m.missing ? ui.meta('—') : ui.badge(sevTone(m.severity), m.severity),
                  host: ui.meta(m.deviceLabel),
                  metric: el('code', {}, m.metric),
                  when: m.createdAt ? ui.fmt.abs(m.createdAt)
                    : (m.missing ? t('tshoot.faults.purged') : '—'),
                  cause: el('span', {}, m.cause || '—',
                    m.acked ? ui.badge('neutral', t('tshoot.faults.acked')) : null),
                },
              };
            }),
          }));
        }
        faultsHost.replaceChildren(ui.panel({
          title: t('tshoot.faults.title'),
          note: t(progress.key, progress.params),
          actions: [ui.button('ghost', t('tshoot.faults.hide'), { onclick: closeFaults })],
          children: children,
          foot: next > 0
            ? ui.button('secondary', t('tshoot.faults.loadMore', { count: next }), {
              disabled: faults.loading, onclick: loadFaultPage,
            })
            : null,
        }));
      }

      // One page at a time, appended. `offset` is the number of rows already
      // held and the backend keeps a stable order, so paging never re-reads or
      // skips.
      function loadFaultPage() {
        if (faults.loading) return Promise.resolve();
        faults.loading = true;
        faults.error = null;
        drawFaults();
        drawStrip();
        return deps.fetchFaults(FAULT_PAGE, faults.rows.length)
          .then(function (page) {
            faults.total = Number(page.total) || 0;
            faults.rows = faults.rows.concat(page.faults || []);
            faults.loaded = true;
          })
          .catch(function (err) { faults.error = deps.errText(err); })
          .then(function () {
            faults.loading = false;
            drawFaults();
            drawStrip();
          });
      }
      function openFaults() {
        faults.open = true;
        drawStrip();
        drawFaults();
        if (!faults.loaded) loadFaultPage();
      }
      function closeFaults() {
        faults.open = false;
        drawFaults();
        drawStrip();
      }

      // ---- timeline ----------------------------------------------------------
      function drawTimeline() {
        var all = data.timeline || [];
        var bounds = TV.timelineBounds(all);
        if (!bounds) {
          timelineHost.replaceChildren(ui.panel({
            title: t('tshoot.timeline'),
            children: [ui.emptyState({ kind: 'nodata', title: t('tshoot.timeline.none'), body: t('tshoot.timeline.noneHint') })],
          }));
          return;
        }
        var listHost = el('div', { class: 'ts-events' });
        var b = deps.brushSvg(all, bounds, {
          onBrush: function (next) { brush = next; paint(); },
        });

        function paint() {
          var shown = brush ? TV.eventsInWindow(all, brush.fromMs, brush.toMs) : all;
          b.setSelection(brush);
          var ul = el('ul', { class: 'timeline' });
          shown.forEach(function (e) { ul.append(deps.timelineRow(e)); });
          listHost.replaceChildren(
            el('div', { class: 'ts-events-head' },
              ui.metaXs(brush
                ? t('tshoot.timeline.selected', { shown: shown.length, total: all.length })
                : t('tshoot.timeline.count', { n: all.length })),
              brush ? ui.button('ghost', t('tshoot.timeline.clear'), {
                size: 'xs', onclick: function () { brush = null; paint(); },
              }) : null),
            shown.length ? ul : ui.emptyState({ kind: 'nodata', title: t('tshoot.timeline.noneInWindow') }));
        }

        timelineHost.replaceChildren(ui.panel({
          title: t('tshoot.timeline'),
          note: t('tshoot.timeline.note'),
          children: [el('div', { class: 'panel-body' }, b.svg, listHost)],
        }));
        paint();
      }

      // ---- load --------------------------------------------------------------
      function load() {
        if (refreshBtn) refreshBtn.disabled = true;
        noteHost.replaceChildren();
        return deps.fetchOverview(state.window)
          .then(function (d) {
            data = d;
            brush = null;
            // The fault set belongs to the rollup we just replaced, so the held
            // pages are stale. Drop them; if the list was open, page 1 of the
            // NEW set is fetched rather than silently showing the old one.
            faults.rows = [];
            faults.total = 0;
            faults.loaded = false;
            faults.error = null;
            drawStrip();
            drawTopology();
            drawRootCauses();
            drawFaults();
            drawTimeline();
            if (faults.open) loadFaultPage();
            // A domain that is down costs its own panel, not the screen — say
            // which one, where the data is, not in a control bar.
            if (d.partial) {
              noteHost.replaceChildren(ui.inlineNote(
                t('tshoot.partial', { sources: (d.failedSources || []).join(', ') }), 'warn'));
            }
          })
          .catch(function (e) {
            stripHost.replaceChildren();
            causeHost.replaceChildren();
            timelineHost.replaceChildren();
            faults.open = false;
            drawFaults();
            topoHost.replaceChildren(ui.panel({
              title: t('tshoot.topology'),
              children: [ui.errorState({
                title: t('tshoot.err.title'), body: deps.errText(e),
                detail: 'GET /api/troubleshooting/overview', onRetry: load,
              })],
            }));
          })
          .then(function () { if (refreshBtn) refreshBtn.disabled = false; });
      }

      drawToolbar();
      topoHost.replaceChildren(ui.panel({ title: t('tshoot.topology'), children: [ui.loadingState(5)] }));
      return load().then(function () { return page; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.TroubleshootingPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
