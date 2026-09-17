// public/views/traffic.js — Traffic, as a DashboardPage (template B).
//
// What is moving right now: four figures, one live chart, and the agents
// carrying the most of it. Built from the contract's components (public/ui.js,
// docs/ui-contract.md).
//
// What this migration changes:
//   * the four KPI tiles become the StatStrip they always were, so the numbers
//     sit where they sit on every other screen;
//   * the alert banner becomes an inline note above the data it is about,
//     rather than a coloured bar across the top of the page;
//   * "Total RX", "Total TX" and the "Pr. agent" fold were three different
//     controls for one question — which series to plot. They are one picker
//     now, and the legend under the chart is where a series is removed;
//   * the series colours come from the palette (--series-0..5) instead of two
//     hardcoded hues plus a fixed ramp.
//
// NOT migrated, and passed in whole by app.js: the storage fold, the history
// explorer with its traffic-types card, and the traffic-type breakdown. Each
// carries its own machinery and migrates in its own commit.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    // Six is what the legend can carry; a seventh series wraps onto the first
    // colour rather than inventing one.
    function seriesToken(i) { return '--series-' + (i % 6); }

    function view() {
      var state = deps.state;
      var selection = state.selection;

      var page = ui.page();
      var alertHost = el('div', {});
      var stripHost = el('div', {});
      var chartHost = el('div', {});
      var legendHost = el('div', { class: 'ui-chart-legend' });
      var toolbarHost = el('div', {});
      var topHost = el('div', {});

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('traffic.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
        actions: [ui.button('secondary', t('traffic.openFleet'), { onclick: function () { deps.gotoView('fleet'); } })],
      }), alertHost, stripHost, ui.panel({
        title: t('traffic.live'),
        note: t('traffic.liveNote'),
        children: [toolbarHost, chartHost, legendHost],
      }), topHost);

      // history[seriesId] = { label, points: [{ t, y }] } — the rolling buffer
      // the chart is drawn from. MAX points at one tick each is the window.
      var history = {};
      var MAX = 60;
      var agentsMeta = [];
      var zoom = null; // frozen snapshot of a dragged window, or null while live
      var tickN = 0;

      function pushPoint(id, label, y) {
        if (!history[id]) history[id] = { label: label, points: [] };
        var h = history[id];
        h.label = label;
        h.points.push({ y: y, t: Date.now() });
        if (h.points.length > MAX) h.points.shift();
      }

      // ---- what is plotted ---------------------------------------------------
      function selected() {
        var out = [];
        selection.forEach(function (id) { if (history[id]) out.push(id); });
        return out;
      }
      function liveSeries() {
        return selected().map(function (id, i) {
          return {
            id: id, label: history[id].label, color: ui.token(seriesToken(i)),
            points: history[id].points,
          };
        });
      }
      function labelFor(id) {
        if (id === 'total:rx') return t('traffic.series.totalRx');
        if (id === 'total:tx') return t('traffic.series.totalTx');
        var parts = id.split(':');
        var a = agentsMeta.filter(function (x) { return String(x.id) === parts[1]; })[0];
        var name = a ? (a.display_name || a.hostname) : parts[1];
        return name + ' · ' + (parts[0] === 'rx' ? t('traffic.rx') : t('traffic.tx'));
      }

      // ---- Toolbar -----------------------------------------------------------
      // One picker for every series, so adding a total and adding one agent's
      // RX are the same gesture. The legend below is where one comes off again.
      function drawToolbar() {
        var options = [['', t('traffic.addSeries')]];
        ['total:rx', 'total:tx'].forEach(function (id) {
          if (!selection.has(id)) options.push([id, labelFor(id)]);
        });
        agentsMeta.forEach(function (a) {
          ['rx', 'tx'].forEach(function (dir) {
            var id = dir + ':' + a.id;
            if (!selection.has(id)) options.push([id, labelFor(id)]);
          });
        });
        toolbarHost.replaceChildren(ui.toolbar({
          filters: [ui.filter(t('traffic.series'), ui.select({
            label: t('traffic.series'), value: '', options: options,
            onchange: function (e) {
              var id = e.target.value;
              if (!id) return;
              selection.add(id);
              if (zoom) resetZoom(); else draw();
              drawToolbar();
            },
          }))],
          actions: [ui.button('secondary', t('traffic.resetZoom'), {
            disabled: !zoom,
            title: zoom ? t('traffic.resetZoomHint') : t('traffic.zoomHint'),
            onclick: resetZoom,
          })],
        }));
      }

      // ---- chart -------------------------------------------------------------
      function draw() {
        // While zoomed the chart is frozen to the snapshot taken at drag time,
        // so the 3-second tick does not fight the zoom.
        var list = zoom ? zoom.series : liveSeries();
        if (!list.length) {
          chartHost.replaceChildren(ui.emptyState({
            icon: '∿', title: t('traffic.noSeries'), body: t('traffic.noSeriesHint'),
          }));
          legendHost.replaceChildren();
          return;
        }
        // Clock ticks off the real point timestamps, so the axis shows the
        // window on screen rather than a fixed caption.
        var ref = list.filter(function (s) { return s.points.length >= 2; })[0];
        var xLabels = [t('traffic.axis.start'), '', t('traffic.axis.now')];
        if (ref) {
          var pts = ref.points;
          xLabels = [0, 1, 2, 3, 4].map(function (i) {
            return ui.fmt.clock(pts[Math.round((i / 4) * (pts.length - 1))].t);
          });
        }
        chartHost.replaceChildren(deps.plot(list, {
          height: 300, area: true, xLabels: xLabels,
          onBrush: function (f0, f1) { if (f0 === null) resetZoom(); else zoomTo(f0, f1); },
        }));
        drawLegend(list);
      }

      // The legend is the series list: it names what is plotted and is where a
      // series comes off again.
      function drawLegend(list) {
        // replaceChildren takes varargs, not an array — an array would land as
        // one text node reading "[object HTMLSpanElement]".
        legendHost.replaceChildren.apply(legendHost, list.map(function (s, i) {
          return el('span', { class: 'ui-legend-item' },
            el('span', { class: 'ui-legend-dot ui-series-' + (i % 6) }),
            s.label,
            ui.button('ghost', '×', {
              size: 'xs', icon: true,
              ariaLabel: t('traffic.removeSeries', { name: s.label }),
              title: t('traffic.removeSeries', { name: s.label }),
              onclick: function () {
                selection.delete(s.id);
                if (zoom) resetZoom(); else draw();
                drawToolbar();
              },
            }));
        }));
      }

      // Drag-to-zoom: freeze the chart to the dragged slice of whatever is
      // shown now, so a second drag zooms in further.
      function zoomTo(f0, f1) {
        var base = zoom ? zoom.series : liveSeries();
        if (!base.length) return;
        var lo = Math.min(f0, f1);
        var hi = Math.max(f0, f1);
        // Each series is stretched across the full width using its OWN point
        // count, so the dragged fraction maps onto each one's own index range.
        // A single shared length would slice a shorter series past its end.
        var series = base.map(function (s) {
          var n = s.points.length;
          var i0 = Math.round(lo * (n - 1));
          var i1 = Math.round(hi * (n - 1));
          return {
            id: s.id, label: s.label, color: s.color,
            points: s.points.slice(i0, i1 + 1).map(function (p) { return { t: p.t, y: p.y }; }),
          };
        }).filter(function (s) { return s.points.length >= 2; });
        if (!series.length) return;
        zoom = { series: series };
        drawToolbar();
        draw();
      }
      function resetZoom() {
        if (!zoom) return;
        zoom = null;
        drawToolbar();
        draw();
      }

      // ---- StatStrip ---------------------------------------------------------
      function drawStrip(totalRx, totalTx, online, total) {
        stripHost.replaceChildren(ui.statStrip([
          { value: deps.fmtBytes(totalRx) + '/s', label: t('traffic.stat.rx') },
          { value: deps.fmtBytes(totalTx) + '/s', label: t('traffic.stat.tx') },
          {
            value: online + ' / ' + total, label: t('traffic.stat.agents'),
            tone: total && online < total ? 'warn' : undefined,
            onclick: function () { deps.gotoView('fleet'); },
          },
          {
            value: state.siteCount == null ? '–' : state.siteCount,
            label: t('traffic.stat.sites'),
            title: state.siteHint || null,
            onclick: function () { deps.gotoView('map'); },
          },
        ]));
      }

      // ---- Top agents --------------------------------------------------------
      function drawTop(latest) {
        var top = latest.slice().sort(function (a, b) {
          return (b.rx + b.tx) - (a.rx + a.tx);
        }).slice(0, 5);
        if (!top.length) {
          topHost.replaceChildren(ui.panel({
            title: t('traffic.top'),
            children: [ui.emptyState({ title: t('traffic.noAgents'), body: t('traffic.noAgentsHint') })],
          }));
          return;
        }
        topHost.replaceChildren(ui.panel({
          title: t('traffic.top'),
          note: t('traffic.topNote'),
          children: [ui.dataTable({
            dense: true,
            columns: [
              { key: 'agent', label: t('traffic.col.agent'), width: '260px' },
              { key: 'status', label: t('traffic.col.status'), width: '120px' },
              { key: 'rx', label: t('traffic.col.rx'), width: '160px', num: true },
              { key: 'tx', label: t('traffic.col.tx'), width: '160px', num: true },
            ],
            rows: top.map(function (r) {
              return {
                a: r.a,
                cells: {
                  agent: ui.hostLink(r.a.display_name || r.a.hostname, function () { deps.openAgent(r.a.id); }),
                  status: ui.badge(r.a.status === 'online' ? 'ok' : 'neutral',
                    r.a.status === 'online' ? t('traffic.online') : t('traffic.offline')),
                  rx: deps.fmtBytes(r.rx) + '/s',
                  tx: deps.fmtBytes(r.tx) + '/s',
                },
              };
            }),
            onOpen: function (row) { deps.openAgent(row.a.id); },
          })],
        }));
      }

      // ---- alert -------------------------------------------------------------
      function drawAlert(hit) {
        if (!hit) { alertHost.replaceChildren(); return; }
        alertHost.replaceChildren(ui.inlineNote([
          hit.severity + ': ' + (hit.metric || '') + ' — ' + (hit.explanation || ''),
          ' ',
          ui.metaXs(ui.fmt.abs(hit.createdAt)),
          ui.button('ghost', t('traffic.alertDetails'), {
            size: 'xs', onclick: function () { deps.gotoView('findings'); },
          }),
        ], hit.severity === 'CRIT' ? 'crit' : 'warn'));
      }

      // ---- the tick ----------------------------------------------------------
      function tick() {
        return deps.fetchTick()
          .then(function (d) {
            agentsMeta = d.agents;
            var totalRx = 0;
            var totalTx = 0;
            d.latest.forEach(function (r) {
              var name = r.a.display_name || r.a.hostname;
              pushPoint('rx:' + r.a.id, name + ' · ' + t('traffic.rx'), r.rx);
              pushPoint('tx:' + r.a.id, name + ' · ' + t('traffic.tx'), r.tx);
              totalRx += r.rx; totalTx += r.tx;
            });
            pushPoint('total:rx', t('traffic.series.totalRx'), totalRx);
            pushPoint('total:tx', t('traffic.series.totalTx'), totalTx);
            // First load plots the two totals; after that the reader's choice
            // stands, including an empty one.
            if (!state.picked) {
              state.picked = true;
              if (!selection.size) { selection.add('total:rx'); selection.add('total:tx'); }
            }
            var online = d.agents.filter(function (a) { return a.status === 'online'; }).length;
            drawStrip(totalRx, totalTx, online, d.agents.length);
            drawTop(d.latest);
            draw();
            drawToolbar();
            tickN += 1;
            if (tickN === 1 || tickN % 10 === 0) {
              deps.fetchAlert().then(drawAlert).catch(function () { drawAlert(null); });
              deps.refreshExtras();
            }
          })
          .catch(function (e) {
            if (tickN) return; // a failed tick keeps the last good render
            chartHost.replaceChildren(ui.errorState({
              title: t('traffic.err.title'),
              body: deps.errText(e),
              detail: 'GET /agents',
              onRetry: function () { return tick(); },
            }));
            legendHost.replaceChildren();
          });
      }

      chartHost.replaceChildren(ui.loadingState(4));
      drawToolbar();
      deps.fetchSites().then(function (s) {
        state.siteCount = s.count;
        state.siteHint = s.hint;
      }).catch(function () { /* the card reads "–" */ });

      return tick().then(function () {
        // Mounted after the first tick (the page is built by then), and asked
        // to fill itself straight away — otherwise the storage line sits on its
        // placeholder until the tenth tick, half a minute in.
        deps.mountExtras(page);
        deps.refreshExtras();
        deps.startPolling(tick);
        return page;
      });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.TrafficView = apiObj;
})(typeof window !== 'undefined' ? window : null);
