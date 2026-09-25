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
    // Where a hop or a stop is, as precisely as the server could say: "Frankfurt,
    // DE" when the router's name or city GeoIP gave a city, else the country.
    function placeLabel(nodes) {
      for (var i = 0; i < nodes.length; i += 1) {
        var p = nodes[i].place;
        if (p && p.source === 'latency' && p.nearHop === 0) return t('pathmap.place.agentSite');
        if (p) return [p.city, p.country].filter(Boolean).join(', ');
      }
      return nodes.length ? (nodes[0].country || null) : null;
    }
    // How the place was found, and how well the reply time supports it. Every
    // hop that can be placed IS drawn; this is the label that keeps it honest.
    function placeSource(p) {
      if (!p) return null;
      var how = p.source === 'latency'
        ? (p.nearHop === 0 ? t('pathmap.place.latencyAgent', { ms: p.deltaMs }) : t('pathmap.place.latencyHop', { hop: p.nearHop, ms: p.deltaMs }))
        : p.source === 'rdns' ? t('pathmap.place.rdns', { code: p.code || '' })
          : p.source === 'geoip-city' ? t('pathmap.place.geoipCity')
            : t('pathmap.place.country');
      if (p.certainty === 'approximate') return how + ' \u00b7 ' + t('pathmap.place.approx');
      if (p.certainty === 'registration') return how + ' \u00b7 ' + t('pathmap.place.registration');
      return how;
    }
    // A short tag for the stop row: "approximate" or "registered here".
    function certaintyTag(nodes) {
      var worst = null;
      (nodes || []).forEach(function (n) {
        if (!n.place) return;
        if (n.place.certainty === 'registration') worst = 'registration';
        else if (n.place.certainty === 'approximate' && worst !== 'registration') worst = 'approximate';
      });
      return worst ? t(worst === 'registration' ? 'pathmap.tag.registration' : 'pathmap.tag.approx') : null;
    }
    // The agent's site is the point every distance is measured from. When the
    // first public hop is a cloud provider a few ms away, the agent most likely
    // runs there, and the map is being measured from the wrong place.
    function originHintNote(hint, agentId) {
      if (!hint) return null;
      var note = ui.inlineNote(t('pathmap.cloudOrigin', {
        hop: hint.hop, ip: hint.ip, provider: hint.provider, ms: hint.rttMs,
      }), 'warn');
      if (agentId == null || !deps.editAgentPosition || !deps.canWrite || !deps.canWrite()) return note;
      return el('div', {}, note, el('button', {
        type: 'button', class: 'small',
        onclick: function () { deps.editAgentPosition(agentId); },
      }, t('ag.act.position')));
    }
    // A hop the reply time says answers from much closer than its address is
    // registered: anycast, or a block registered a continent from the rack. It
    // IS on the map, where it is registered; this says what is really known.
    function rejectedNotes(nodes) {
      return (nodes || []).filter(function (n) {
        return n.place && n.place.certainty === 'registration' && Number.isFinite(n.withinKm);
      }).map(function (n) {
        return ui.inlineNote(t('pathmap.registeredFar', {
          hop: n.hop, ip: n.ip || '*',
          where: [n.place.city, n.place.country].filter(Boolean).join(', ') || '?',
          km: n.place.offByKm, within: n.withinKm,
        }), 'info');
      });
    }

    // The destination has no coordinates for a reason OTHER than the
    // speed-of-light check (a private address, or no GeoIP at all). Same
    // consequence — the drawn line stops short of the endpoint — but no
    // rejection to explain it, so it would otherwise pass in silence.
    function destShortNote(nodes) {
      var dest = (nodes || []).filter(function (n) { return n.kind === 'dest'; })[0];
      if (!dest || dest.lat != null) return null;
      if (dest.place) return null;
      return ui.inlineNote(t('pathmap.destUnplaced', { hop: dest.hop, ip: dest.ip || '*' }), 'info');
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

      // Every trace on the map, in the order it was added. One is "current":
      // its detail sits under the list. A trace is running (hops arrive live),
      // done, failed (with the agent's reason) or pending (outlived the wait).
      var traces = [];
      var currentKey = null;
      var MAX_SHOW_ALL = 12;

      function agentName(id) {
        var a = agents.filter(function (x) { return String(x.id) === String(id); })[0];
        return a ? (a.display_name || a.hostname) : t('dest.hostN', { id: id });
      }
      function traceOf(key) {
        return traces.filter(function (tr) { return tr.key === key; })[0] || null;
      }

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
        return ui.toolbar({
          filters: [
            ui.filter(t('dest.path'), pathAgentSel),
            ui.filter(t('dest.path.targetLabel'), pathTargetInput),
            pathTargetList,
          ],
          actions: [
            ui.button('secondary', t('dest.path.show'), { onclick: function () { runPath(false); } }),
            ui.button('secondary', t('dest.path.trace'), { onclick: function () { runPath(true); }, title: t('dest.path.traceHint') }),
            ui.button('ghost', t('dest.path.showAll'), { onclick: showAll, title: t('dest.path.showAllHint') }),
            ui.button('ghost', t('dest.path.clear'), { onclick: function () { clearPath(null); } }),
          ],
        });
      }

      function picked() {
        var agentId = pathAgentSel.value;
        var target = pathTargetInput.value.trim();
        if (!agentId) { ui.toast(t('dest.path.pickAgent'), null, { bad: true, focus: pathAgentSel }); return null; }
        if (!target) { ui.toast(t('dest.path.pickTarget'), null, { bad: true, focus: pathTargetInput }); return null; }
        return { agentId: agentId, target: target };
      }

      function runPath(fresh) {
        var p = picked();
        if (!p) return;
        startTrace(p.agentId, p.target, fresh, true);
      }

      // Adds (or re-runs) one trace. `fresh` asks the agent for a new run even
      // when a stored path exists; that run draws hop by hop as it happens.
      function startTrace(agentId, target, fresh, makeCurrent) {
        var key = deps.traceKey(agentId, target);
        var tr = traceOf(key);
        if (tr && tr.status === 'running') {
          // Already in flight: show it rather than start a second one.
          if (makeCurrent) { currentKey = key; drawTraces(); }
          return Promise.resolve();
        }
        if (!tr) {
          tr = { key: key, agentId: agentId, target: target };
          traces.push(tr);
        }
        tr.status = 'running';
        tr.nodes = [];
        tr.reason = null;
        tr.startedAt = Date.now();
        if (makeCurrent) currentKey = key;
        drawTraces();
        return deps.showPath(agentId, target, {
          fresh: fresh,
          onLive: function (nodes) {
            tr.nodes = nodes;
            drawTraces();
          },
        })
          .then(function (res) {
            if (!res) { tr.status = 'failed'; tr.reason = t('dest.path.noMap'); return; }
            if (res.empty) {
              tr.status = res.reason ? 'failed' : 'pending';
              tr.reason = res.reason || null;
              return;
            }
            tr.status = 'done';
            tr.graph = res;
          })
          .catch(function (e) {
            tr.status = 'failed';
            tr.reason = deps.errText(e);
          })
          .then(drawTraces);
      }

      // Every target this agent has traced before, on the map at once.
      function showAll() {
        var agentId = pathAgentSel.value;
        if (!agentId) { ui.toast(t('dest.path.pickAgent'), null, { bad: true, focus: pathAgentSel }); return; }
        deps.loadPathTargets(agentId, pathTargetList).then(function (targets) {
          if (!targets || !targets.length) { ui.toast(t('dest.path.noTargets'), null, { bad: true }); return; }
          if (targets.length > MAX_SHOW_ALL) ui.toast(t('dest.path.showAllCapped', { n: MAX_SHOW_ALL, total: targets.length }));
          targets.slice(0, MAX_SHOW_ALL).forEach(function (target, i) {
            startTrace(agentId, target, false, i === 0 && !currentKey);
          });
        });
      }

      function clearPath(key) {
        deps.clearPath(key || null);
        traces = key ? traces.filter(function (tr) { return tr.key !== key; }) : [];
        if (!key || currentKey === key) currentKey = traces.length ? traces[traces.length - 1].key : null;
        drawTraces();
      }

      // A click on a trace on the map makes it the current one.
      function focusFromMap(key) {
        if (!traceOf(key)) return;
        currentKey = key;
        drawTraces();
        if (pathHost.scrollIntoView) pathHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }

      // SAME ORDER AS THE SERVER (src/analysis/pathGraph.js sevRank), and it has
      // to be: this table used to rank `muted` ABOVE `ok`, so on a healthy path
      // whose only non-ok hop was a silent router — which is most paths, routers
      // commonly don't emit ICMP "TTL exceeded" — the router was picked as the
      // worst hop and drawn in the warning colour, under a sentence that ends
      // "(silent router — normal)". A verdict must not contradict the sentence
      // printed beside it, and the server's own graph agrees: it leaves
      // worstHopIndex null on exactly that path.
      //
      // `muted` is not a degree of badness at all. It means NOT MEASURED, and
      // below `ok` is the only place it can sit without inventing a fault.
      var RANK = { bad: 3, warn: 2, ok: 1, muted: 0 };
      // The floor for calling something the worst hop, matching the server's
      // `r >= sevRank.warn`. Below it there is no worst hop, not a quiet one.
      var WORST_MIN_RANK = RANK.warn;
      function worstOf(nodes) {
        return (nodes || []).filter(function (n) { return n.kind !== 'source'; }).reduce(function (w, n) {
          return (RANK[n.severity] || 0) > (RANK[w && w.severity] || 0) ? n : w;
        }, null);
      }

      function statusText(tr) {
        if (tr.status === 'running') {
          return tr.nodes && tr.nodes.length
            ? t('dest.path.status.live', { n: tr.nodes[tr.nodes.length - 1].hop })
            : t('dest.path.status.started');
        }
        if (tr.status === 'failed') return t('dest.path.status.failed');
        if (tr.status === 'pending') return t('dest.path.status.pending');
        var g = tr.graph || {};
        return t('dest.path.status.done', { runs: g.samples || 0, stops: (g.stops || []).length });
      }
      function statusTone(tr) {
        if (tr.status === 'running') return 'sev-muted';
        if (tr.status === 'failed') return 'sev-bad';
        if (tr.status === 'pending') return 'sev-warn';
        var w = worstOf(tr.graph && tr.graph.nodes);
        return 'sev-' + ((w && w.severity) || 'ok');
      }

      // The list of traces, then the current one's detail.
      function drawTraces() {
        if (!traces.length) { pathHost.replaceChildren(); return; }
        if (!traceOf(currentKey)) currentKey = traces[traces.length - 1].key;
        var list = el('ul', { class: 'path-stops' }, traces.map(function (tr) {
          var current = tr.key === currentKey;
          var li = el('li', {
            class: 'is-clickable' + (current ? ' is-current' : ''), tabindex: '0', role: 'button',
            'aria-pressed': current ? 'true' : 'false',
          },
          el('span', { class: 'ui-legend-dot ' + statusTone(tr) }),
          el('span', { class: 'mono' }, tr.target),
          ui.metaXs(agentName(tr.agentId)),
          el('span', { class: 'path-grow' }, ui.metaXs(statusText(tr))),
          ui.button('ghost', t('dest.path.remove'), {
            size: 'xs', ariaLabel: t('dest.path.removeOne', { target: tr.target }),
            onclick: function (e) { e.stopPropagation(); clearPath(tr.key); },
          }));
          var pick = function () { currentKey = tr.key; deps.focusPath(tr.key); drawTraces(); };
          li.addEventListener('click', pick);
          li.addEventListener('keydown', function (e) {
            if (e.target !== li) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
          });
          return li;
        }));

        var cur = traceOf(currentKey);
        pathHost.replaceChildren(ui.panel({
          title: t('dest.path.traces'),
          note: t('dest.path.tracesNote', { n: traces.length }),
          actions: [ui.button('ghost', t('dest.path.clear'), { onclick: function () { clearPath(null); } })],
          children: [ui.inlineNote(t('dest.path.what')), list],
        }), ui.panel({
          title: t('dest.path.panel'),
          note: cur ? traceNote(cur) : null,
          actions: cur && cur.status !== 'running'
            ? [ui.button('secondary', t('dest.path.trace'), {
              onclick: function () { startTrace(cur.agentId, cur.target, true, true); },
            })]
            : [],
          children: cur ? traceDetail(cur) : [],
        }));
      }

      function traceNote(tr) {
        // A run opened from the history is ONE run, not a median over several:
        // the note has to say so, or the reader takes it for the usual graph.
        if (tr.status === 'done' && tr.viewingRunId) {
          return t('dest.hist.viewing', { target: tr.target, when: ui.fmt.short(tr.viewingTs) });
        }
        if (tr.status === 'done' && tr.graph) {
          return t('dest.path.note', { target: tr.target, runs: tr.graph.samples || 0, stops: (tr.graph.stops || []).length });
        }
        return tr.target + ' · ' + agentName(tr.agentId);
      }

      // ---- history of one traced path -----------------------------------
      //
      // The graph above is a median over the newest runs, which is the right
      // answer to "is this path healthy now" and the wrong one to "why was it
      // slow on Tuesday": a median is precisely what hides a single bad run,
      // and a route that changed and changed back leaves no mark in it.
      //
      // So the runs are listed as themselves. Opening one draws THAT run;
      // comparing two says which hops came, went or got slower.
      var historyState = { open: false, runs: null, total: 0, error: null, openRunId: null, compare: null, busy: false };

      function historySection(tr) {
        var host = el('div', { class: 'path-history' });
        var sec = el('details', { class: 'sec' },
          el('summary', {}, t('dest.hist.title'),
            el('span', { class: 'muted' }, historyState.total ? ' \u00b7 ' + t('dest.hist.count', { n: historyState.total }) : '')),
          host);
        if (historyState.open) sec.open = true;
        sec.addEventListener('toggle', function () {
          historyState.open = sec.open;
          if (sec.open && historyState.runs === null) loadRuns(tr, host);
          else if (sec.open) drawHistory(tr, host);
        });
        if (historyState.open) drawHistory(tr, host);
        return sec;
      }

      function loadRuns(tr, host) {
        host.replaceChildren(ui.loadingState(3));
        deps.fetchPathRuns(tr.agentId, tr.target).then(function (data) {
          historyState.runs = (data && data.runs) || [];
          historyState.total = (data && data.total) || 0;
          historyState.error = null;
          drawHistory(tr, host);
        }, function (e) {
          historyState.error = deps.errText(e);
          drawHistory(tr, host);
        });
      }

      // Opens one stored run: it replaces the drawn path on the map and the
      // hop list, so the reader is looking at that run and nothing else.
      function openRun(tr, host, run) {
        if (historyState.busy) return;
        historyState.busy = true;
        Promise.all([
          deps.fetchPathRun(tr.agentId, run.id),
          deps.fetchPathCompare(tr.agentId, run.id).catch(function () { return null; }),
        ]).then(function (out) {
          historyState.busy = false;
          historyState.openRunId = run.id;
          historyState.compare = out[1] && out[1].diff ? out[1] : null;
          tr.graph = deps.drawStoredRun(tr.agentId, tr.target, out[0]) || out[0];
          tr.viewingRunId = run.id;
          tr.viewingTs = run.ts;
          drawTraces();
        }, function (e) {
          historyState.busy = false;
          ui.toast(t("dest.hist.title"), deps.errText(e), { bad: true });
        });
      }

      function runRow(tr, host, run) {
        var when = ui.fmt.short(run.ts);
        var bits = [];
        bits.push(t('dest.hist.hops', { n: run.respondingCount }));
        if (run.silentCount) bits.push(t('dest.hist.silent', { n: run.silentCount }));
        if (typeof run.rttMs === 'number') bits.push(Math.round(run.rttMs) + ' ms');
        if (run.lossPct) bits.push(t('dest.path.lossN', { pct: Math.round(run.lossPct) }));
        var li = el('li', {
          class: 'is-clickable' + (historyState.openRunId === run.id ? ' is-open' : ''),
          tabindex: '0', role: 'button',
        },
        el('span', { class: 'ui-legend-dot sev-' + (run.ok ? 'ok' : 'bad') }),
        el('span', {}, when),
        // The one thing a trace history is scanned for.
        run.routeChanged ? ui.metaXs(t('dest.hist.rerouted')) : null,
        !run.ok && run.detail ? ui.metaXs(run.detail) : null,
        ui.metaXs(bits.join(' \u00b7 ')));
        var open = function () { openRun(tr, host, run); };
        li.addEventListener('click', open);
        li.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
        return li;
      }

      // What changed between the open run and the one before it.
      function compareBlock(cmp) {
        if (!cmp || !cmp.diff) return null;
        var d = cmp.diff;
        var head = [];
        if (d.routeChanged) head.push(t('dest.hist.cmp.rerouted', { added: d.addedCount, removed: d.removedCount }));
        else head.push(t('dest.hist.cmp.sameRoute'));
        if (typeof d.rttDeltaMs === 'number' && Math.abs(d.rttDeltaMs) >= 1) {
          head.push(t(d.rttDeltaMs > 0 ? 'dest.hist.cmp.slower' : 'dest.hist.cmp.faster', { ms: Math.abs(Math.round(d.rttDeltaMs)) }));
        }
        var rows = d.rows.filter(function (r) {
          // Only the rows that say something: what moved, and where the time
          // went. An unchanged hop in an unchanged route is not news.
          return r.kind !== 'same' || (typeof r.deltaMs === 'number' && Math.abs(r.deltaMs) >= 5);
        });
        return el('div', { class: 'path-compare' },
          ui.inlineNote(head.join(' \u00b7 '), d.routeChanged ? 'warn' : 'info'),
          ui.metaXs(t('dest.hist.cmp.against', { when: ui.fmt.short(cmp.before.ts) })),
          rows.length
            ? el('ul', { class: 'path-stops' }, rows.map(function (r) {
              var label = r.kind === 'added' ? t('dest.hist.cmp.added')
                : r.kind === 'removed' ? t('dest.hist.cmp.removed')
                  : t(r.deltaMs > 0 ? 'dest.hist.cmp.hopSlower' : 'dest.hist.cmp.hopFaster', { ms: Math.abs(Math.round(r.deltaMs)) });
              return el('li', {},
                ui.metaXs(t('dest.path.hop', { n: r.afterHop != null ? r.afterHop : r.beforeHop })),
                el('span', { class: 'mono' }, r.ip),
                r.hostname ? el('span', { class: 'mono muted' }, ' ' + r.hostname) : null,
                ui.metaXs(label));
            }))
            : ui.metaXs(t('dest.hist.cmp.nothing')));
      }

      function drawHistory(tr, host) {
        if (historyState.error) {
          host.replaceChildren(ui.inlineNote(historyState.error, 'crit'));
          return;
        }
        var runs = historyState.runs || [];
        if (!runs.length) {
          host.replaceChildren(ui.emptyState({ kind: 'nodata', title: t('dest.hist.none'), body: t('dest.hist.noneHint') }));
          return;
        }
        host.replaceChildren(
          ui.metaXs(t('dest.hist.blurb')),
          historyState.openRunId ? compareBlock(historyState.compare) : null,
          el('ul', { class: 'path-stops path-runs' }, runs.map(function (r) { return runRow(tr, host, r); })),
          historyState.total > runs.length ? ui.metaXs(t('dest.hist.more', { shown: runs.length, total: historyState.total })) : null);
      }

      function traceDetail(tr) {
        if (tr.status === 'running') return liveDetail(tr);
        if (tr.status === 'done' && tr.graph) return pathDetail(tr.graph).concat([historySection(tr)]);
        // No path came back. Say which of the two things happened — the probe
        // failed (with the agent's own reason), or it has not reported yet.
        return [
          tr.reason
            ? ui.inlineNote(t('dest.path.failed', { why: tr.reason }), 'crit')
            : ui.inlineNote(t('dest.path.pending', { target: tr.target }), 'warn'),
          ui.emptyState({
            kind: 'nodata',
            title: t('dest.path.noStops'),
            body: tr.reason ? t('dest.path.noStopsFailed') : t('dest.path.noStopsPending'),
          }),
        ];
      }

      // The trace while it runs: every hop as the agent reaches it. Agents
      // older than 0.38 do not stream hops, so the list stays empty and the
      // path appears whole when the run lands.
      function liveDetail(tr) {
        var nodes = tr.nodes || [];
        var secs = Math.round((Date.now() - (tr.startedAt || Date.now())) / 1000);
        if (!nodes.length) {
          return [ui.inlineNote(t('dest.path.liveWaiting', { target: tr.target }), 'info'), ui.loadingState(3)];
        }
        var liveHint = nodes.filter(function (n) { return n.originHint; })[0];
        return [
          liveHint ? originHintNote(liveHint.originHint, tr.agentId) : null,
          ui.inlineNote(t('dest.path.liveNote', { n: nodes.length, s: secs }), 'info'),
          el('ul', { class: 'path-stops' }, nodes.map(function (n) {
            var where = [n.asnName || (n.asn ? 'AS' + n.asn : null), placeLabel([n]),
              n.private ? t('dest.path.privateAddr') : null].filter(Boolean).join(' · ');
            return el('li', {},
              el('span', { class: 'ui-legend-dot sev-' + (n.severity || 'ok') }),
              ui.metaXs(t('dest.path.hop', { n: n.hop })),
              el('span', { class: 'mono' }, n.ip || t('dest.path.silent')),
              where ? ui.metaXs(where) : null,
              typeof n.rttMs === 'number' ? ui.metaXs(Math.round(n.rttMs) + ' ms') : null);
          })),
        ].filter(Boolean);
      }

      // A finished path: its stops, each opening the hops it covers.
      function pathDetail(graph) {
        var stops = graph.stops || [];
        var hops = (graph.nodes || []).filter(function (n) { return n.kind !== 'source'; });
        var worst = worstOf(graph.nodes);
        // A STOP IS A PLACE ON THE ROUTE, not a flag. "DE" tells a reader the
        // packet passed through Germany and nothing they can act on; the hop
        // addresses, whose network they belong to and what the latency did are
        // what turns a list of country codes into a route. The row carries as
        // much of that as is known, and the rest is one click away rather than
        // crammed in — a stop can cover five hops across two networks.
        function networkOf(nodes) {
          var names = [];
          nodes.forEach(function (n) {
            var name = n.asnName || (n.asn ? 'AS' + n.asn : null);
            if (name && names.indexOf(name) < 0) names.push(name);
          });
          return names;
        }

        function stopRow(s) {
          var isSrc = s.nodes.some(function (n) { return n.kind === 'source'; });
          var place = isSrc ? (s.nodes[0].label || t('dest.path.origin')) : (placeLabel(s.nodes) || '—');
          var hopLabel = isSrc ? t('dest.path.origin')
            : s.nodes.length > 1
              ? t('dest.path.hops', { from: s.nodes[0].hop, to: s.nodes[s.nodes.length - 1].hop })
              : t('dest.path.hop', { n: s.nodes[0].hop });
          var nets = isSrc ? [] : networkOf(s.nodes);
          // The slowest hop in the stop is the one worth showing: a stop that
          // adds 80 ms says something the country code cannot.
          var rtt = s.nodes.reduce(function (m, n) {
            return typeof n.rttMs === 'number' && (m === null || n.rttMs > m) ? n.rttMs : m;
          }, null);
          var bits = [];
          if (nets.length) bits.push(nets.slice(0, 2).join(', ') + (nets.length > 2 ? ' +' + (nets.length - 2) : ''));
          if (rtt !== null) bits.push(Math.round(rtt) + ' ms');

          var li = el('li', { class: isSrc ? null : 'is-clickable', tabindex: isSrc ? null : '0',
            role: isSrc ? null : 'button' },
          el('span', { class: 'ui-legend-dot sev-' + (s.severity || 'ok') }),
          el('span', {}, String(place)),
          // Drawn either way; the tag says how well the reply time backs it.
          isSrc ? null : (function () { var c = certaintyTag(s.nodes); return c ? ui.metaXs(c) : null; }()),
          bits.length ? ui.metaXs(bits.join(' · ')) : null,
          ui.metaXs(hopLabel));
          if (!isSrc) {
            li.addEventListener('click', function () { openStop(s, li); });
            li.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStop(s, li); }
            });
          }
          return li;
        }

        // Every hop in this stop, with what was actually measured. This is the
        // answer to "why is this row red" and to "which router is that" —
        // questions a two-letter country code cannot be asked.
        function openStop(s, row) {
          var pairs = s.nodes.map(function (n) {
            var where = [
              n.asnName || (n.asn ? 'AS' + n.asn : null),
              n.asnName && n.asn ? 'AS' + n.asn : null,
              placeLabel([n]),
              n.private ? t('dest.path.privateAddr') : null,
            ].filter(Boolean).join(' · ');
            var measured = [
              typeof n.rttMs === 'number' ? Math.round(n.rttMs) + ' ms' : null,
              typeof n.lossPct === 'number' && n.lossPct > 0 ? t('dest.path.lossN', { pct: Math.round(n.lossPct) }) : null,
              typeof n.jitterMs === 'number' ? t('dest.path.jitterN', { ms: Math.round(n.jitterMs) }) : null,
            ].filter(Boolean).join(' · ');
            return [
              t('dest.path.hop', { n: n.hop }),
              el('div', {},
                el('div', { class: 'mono' }, n.ip || t('dest.path.silent')),
                n.hostname ? el('div', { class: 'mono' }, n.hostname) : null,
                where ? ui.metaXs(where) : null,
                n.place ? ui.metaXs(placeSource(n.place)) : null,
                measured ? ui.metaXs(measured) : null,
                n.explain ? ui.metaXs(n.explain) : null),
            ];
          });
          ui.openDrawer({
            title: placeLabel(s.nodes) || t('dest.path.stop'),
            meta: t('dest.path.stopMeta', { hops: s.nodes.length }),
            row: row,
            sections: [ui.drawerSection(t('dest.path.stopHops'), ui.keyValues(pairs))],
          });
        }

        var body = stops.length
          ? el('ul', { class: 'path-stops' }, stops.map(stopRow))
          : ui.emptyState({ icon: '↯', title: t('dest.path.noStops'), body: t('dest.path.noStopsHint') });

        var out = [
          worst && (RANK[worst.severity] || 0) >= WORST_MIN_RANK
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
        ].concat(rejectedNotes(graph.nodes)).concat([destShortNote(graph.nodes)]).filter(Boolean);
        var hint = originHintNote(graph.originHint, graph.agentId);
        return hint ? [hint].concat(out) : out;
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
          onPath: focusFromMap,
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
