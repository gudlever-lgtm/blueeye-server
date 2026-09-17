// public/views/analysis.js — Analysis, as a ListPage (template A).
//
// Errors and anomalies, computed locally: every finding carries the rule that
// raised it and the numbers it rests on. Built from the contract's components
// (public/ui.js, docs/ui-contract.md).
//
// The change this screen exists to make: a finding used to carry three buttons
// in its last cell — Acknowledge, "What changed?", and (for an admin) a severity
// rule — which stacked into a three-line column on any screen narrower than a
// desk. Acknowledge is now the one action on the row, shown on hover; the other
// two moved into the row's ⋯ menu, and the explanation they lead to moved into
// the Drawer, where there is room to read it.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var api = deps.api;
    var t = deps.t;
    var errText = deps.errText;
    var ui = deps.ui;

    var SEV_TONE = { CRIT: 'crit', WARN: 'warn', INFO: 'info' };
    var SEV_ORDER = { CRIT: 3, WARN: 2, INFO: 1 };
    var SEVERITIES = ['CRIT', 'WARN', 'INFO'];

    function sigma(v) { return typeof v === 'number' ? v.toFixed(1) + 'σ' : '—'; }

    function view() {
      var state = deps.state;
      // The sort lives with the filters in app.js, but the view does not depend
      // on that state having been shaped for it.
      if (!state.sort) state.sort = { key: 'time', dir: 'desc' };
      var root2 = ui.page();
      var stripHost = el('div', {});
      var toolbarHost = el('div', {});
      var listHost = el('div', {});
      var breakdownHost = el('div', {});
      var agents = [];
      var summary = null;
      var rows = [];

      function agentName(id) {
        var a = agents.filter(function (x) { return String(x.id) === String(id); })[0];
        return a ? (a.display_name || a.hostname) : t('analysis.hostN', { id: id });
      }

      var info = deps.help();
      root2.append(ui.pageHeader({
        title: t('analysis.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
        actions: deps.headerActions(),
      }), stripHost, toolbarHost, listHost, breakdownHost);

      // ---- filters ----------------------------------------------------------
      function filterQs(omit) {
        var skip = omit || [];
        var qs = new URLSearchParams();
        if (state.hostId && skip.indexOf('hostId') < 0) qs.set('hostId', state.hostId);
        if (state.severity && skip.indexOf('severity') < 0) qs.set('severity', state.severity);
        if (state.metric && skip.indexOf('metric') < 0) qs.set('metric', state.metric);
        var s = qs.toString();
        return s ? '?' + s : '';
      }

      function metricOptions() {
        var metrics = ((summary && summary.byMetric) || []).map(function (m) { return m.metric; }).filter(Boolean);
        // Keep the active selection reachable even when it currently has no rows.
        if (state.metric && metrics.indexOf(state.metric) < 0) metrics.push(state.metric);
        metrics.sort(function (a, b) { return String(a).localeCompare(String(b)); });
        return [['', t('analysis.filter.allMetrics')]].concat(metrics.map(function (m) { return [m, m]; }));
      }

      function drawToolbar() {
        toolbarHost.replaceChildren(ui.toolbar({
          filters: [
            ui.filter(t('analysis.filter.host'), ui.select({
              label: t('analysis.filter.host'), value: state.hostId,
              options: [['', t('analysis.filter.allHosts')]].concat(agents.map(function (a) {
                return [String(a.id), a.display_name || a.hostname];
              })),
              onchange: function (e) { state.hostId = e.target.value; reload(); },
            })),
            ui.filter(t('analysis.filter.severity'), ui.select({
              label: t('analysis.filter.severity'), value: state.severity,
              options: [['', t('analysis.filter.allSeverities')]].concat(SEVERITIES.map(function (s) { return [s, s]; })),
              onchange: function (e) { state.severity = e.target.value; reload(); },
            })),
            ui.filter(t('analysis.filter.metric'), ui.select({
              label: t('analysis.filter.metric'), value: state.metric,
              options: metricOptions(),
              onchange: function (e) { state.metric = e.target.value; loadList(); },
            })),
          ],
          actions: deps.toolbarActions(),
        }));
      }

      // ---- StatStrip --------------------------------------------------------
      function drawStrip() {
        if (!summary) { stripHost.replaceChildren(); return; }
        var pick = function (sev) {
          return function () {
            state.severity = state.severity === sev ? '' : sev;
            reload();
          };
        };
        stripHost.replaceChildren(ui.statStrip([
          { value: summary.total || 0, label: t('analysis.stat.total'), active: !state.severity, onclick: function () { state.severity = ''; reload(); } },
          { value: summary.unacked || 0, label: t('analysis.stat.unacked') },
          { value: (summary.bySeverity || {}).CRIT || 0, label: t('changes.group.CRIT'), tone: 'crit', active: state.severity === 'CRIT', onclick: pick('CRIT') },
          { value: (summary.bySeverity || {}).WARN || 0, label: t('changes.group.WARN'), tone: 'warn', active: state.severity === 'WARN', onclick: pick('WARN') },
          { value: (summary.bySeverity || {}).INFO || 0, label: t('changes.group.INFO'), tone: 'info', active: state.severity === 'INFO', onclick: pick('INFO') },
        ]));
      }

      // ---- Drawer -----------------------------------------------------------
      // Everything that used to be a button on the row: the explanation, the
      // numbers the verdict rests on, and what changed on the device just before.
      function openFinding(f, tr) {
        var sections = [
          ui.drawerSection(t('analysis.drawer.explanation'), el('p', {}, f.explanation || '—')),
          ui.drawerSection(t('analysis.drawer.numbers'), ui.keyValues([
            [t('analysis.col.metric'), f.metric || '—'],
            [t('analysis.col.deviation'), sigma(f.deviation)],
            [t('analysis.drawer.kind'), f.kind || '—'],
            [t('analysis.col.host'), agentName(f.hostId)],
            [t('analysis.drawer.detected'), ui.fmt.abs(f.createdAt)],
            f.originalSeverity
              ? [t('analysis.drawer.ruled'), t('sev.was', { severity: f.originalSeverity })]
              : null,
            Array.isArray(f.correlatedWith) && f.correlatedWith.length
              ? [t('analysis.drawer.correlated'), String(f.correlatedWith.length)]
              : null,
          ])),
        ];

        // Loaded on demand: this is a second request, and most rows are opened
        // to read the explanation rather than the timeline under it.
        var contextBody = el('div', {}, ui.loadingState(3, ['skel-a', 'skel-d']));
        sections.push(ui.drawerSection(t('analysis.drawer.whatChanged'), contextBody));

        var footer = ui.drawerFooter(
          deps.isAdmin() ? [ui.button('ghost', t('sev.fromEvent'), {
            title: t('sev.fromEventHelp'),
            onclick: function () { ui.closeDrawer(); deps.newSeverityRule(f); },
          })] : [],
          [
            ui.button('secondary', t('analysis.drawer.openHost'), {
              onclick: function () { ui.closeDrawer(); deps.openAgent(Number(f.hostId)); },
            }),
            f.acked ? null : ui.button('primary', t('analysis.act.ack'), {
              onclick: function (e) { acknowledge(f, tr, e.currentTarget); },
            }),
          ]);

        ui.openDrawer({
          title: f.metric + ' · ' + agentName(f.hostId),
          status: ui.badge(SEV_TONE[f.severity] || 'info', f.severity || 'INFO'),
          meta: ui.fmt.abs(f.createdAt) + (f.acked ? ' · ' + t('analysis.acked') : ''),
          row: tr,
          sections: sections,
          footer: footer,
        });

        api('/api/findings/' + encodeURIComponent(f.id) + '/context')
          .then(function (data) {
            var changes = (data && data.changes) || [];
            if (!changes.length) {
              contextBody.replaceChildren(ui.meta(t('analysis.drawer.noChanges')));
              return;
            }
            contextBody.replaceChildren(ui.history(changes.slice(0, 12).map(function (c) {
              return [ui.fmt.short(c.timestamp), c.summary || c.type || ''];
            })));
            if (data.partial && (data.failedSources || []).length) {
              contextBody.append(ui.inlineNote('⚠ ' + t('changes.partial', { sources: data.failedSources.join(', ') }), 'warn'));
            }
          })
          .catch(function (e) {
            contextBody.replaceChildren(ui.errorState({
              body: errText(e),
              detail: 'GET /api/findings/' + f.id + '/context',
              onRetry: function () { ui.closeDrawer(); openFinding(f, tr); },
            }));
          });
      }

      function acknowledge(f, tr, btn) {
        if (btn) btn.disabled = true;
        api('/api/findings/' + encodeURIComponent(f.id) + '/ack', { method: 'POST' })
          .then(function () {
            f.acked = true;
            ui.toast(t('analysis.act.acked'), f.metric + ' · ' + agentName(f.hostId));
            if (tr) tr.classList.add('is-acked');
            ui.closeDrawer();
            reload();
          })
          .catch(function (e) {
            if (btn) btn.disabled = false;
            ui.toast(t('analysis.act.ackFailed'), errText(e), { bad: true });
          });
      }

      // ---- DataTable --------------------------------------------------------
      function toRow(f) {
        return {
          f: f,
          cells: {
            time: ui.fmt.short(f.createdAt),
            host: ui.hostLink(agentName(f.hostId), function () { deps.openAgent(Number(f.hostId)); }),
            metric: f.metric || '—',
            severity: el('span', {},
              ui.badge(SEV_TONE[f.severity] || 'info', f.severity || 'INFO'),
              // A severity a rule changed says so. A downgraded critical that
              // looks exactly like a detected warning is how an estate goes
              // quiet without anybody deciding it should.
              f.originalSeverity
                ? el('span', {
                  class: 'meta-xs', title: t('sev.ruledHelp', { detected: f.originalSeverity, stored: f.severity }),
                }, ' ' + t('sev.was', { severity: f.originalSeverity }))
                : null),
            deviation: sigma(f.deviation),
            explanation: f.explanation || '—',
            // One action on the row, the rest behind ⋯ — this is the three
            // stacked buttons gone.
            actions: ui.rowActions(
              f.acked ? null : { label: t('analysis.act.ack'), onclick: function () { acknowledge(f, null, null); } },
              [
                { label: t('analysis.act.open'), onclick: function () { openFinding(f, null); } },
                { label: t('analysis.act.host'), onclick: function () { deps.openAgent(Number(f.hostId)); } },
                deps.isAdmin() ? '-' : null,
                deps.isAdmin() ? { label: t('sev.fromEvent'), onclick: function () { deps.newSeverityRule(f); } } : null,
              ].filter(Boolean)),
          },
        };
      }

      function sortRows(list) {
        var dir = state.sort.dir === 'asc' ? 1 : -1;
        var key = state.sort.key;
        return list.slice().sort(function (a, b) {
          var av, bv;
          if (key === 'severity') { av = SEV_ORDER[a.severity] || 0; bv = SEV_ORDER[b.severity] || 0; }
          else if (key === 'deviation') { av = typeof a.deviation === 'number' ? a.deviation : -1; bv = typeof b.deviation === 'number' ? b.deviation : -1; }
          else if (key === 'host') { av = agentName(a.hostId).toLowerCase(); bv = agentName(b.hostId).toLowerCase(); }
          else if (key === 'metric') { av = a.metric || ''; bv = b.metric || ''; }
          else { av = new Date(a.createdAt || 0).getTime(); bv = new Date(b.createdAt || 0).getTime(); }
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        });
      }

      function table() {
        return ui.dataTable({
          columns: [
            { key: 'time', label: t('analysis.col.time'), width: '136px', sortable: true, time: true },
            { key: 'host', label: t('analysis.col.host'), width: '150px', sortable: true },
            { key: 'metric', label: t('analysis.col.metric'), width: '144px', sortable: true },
            { key: 'severity', label: t('analysis.col.severity'), width: '176px', sortable: true },
            { key: 'deviation', label: t('analysis.col.deviation'), width: '104px', sortable: true, num: true },
            { key: 'explanation', label: t('analysis.col.explanation') },
            { key: 'actions', label: '', width: '104px' },
          ],
          rows: sortRows(rows).map(toRow),
          sort: state.sort,
          onSort: function (key) {
            state.sort = state.sort.key === key
              ? { key: key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
              : { key: key, dir: 'desc' };
            drawList();
          },
          onOpen: function (row, tr) { openFinding(row.f, tr); },
        });
      }

      function drawList() {
        drawToolbar();
        listHost.replaceChildren(ui.panel({
          title: t('analysis.panel'),
          note: t('analysis.rowCount', { n: rows.length }),
          children: [
            rows.length ? table() : ui.emptyState({
              title: t('analysis.empty'),
              body: t('analysis.emptyHint'),
              action: (state.hostId || state.severity || state.metric)
                ? ui.button('secondary', t('changes.clearFilters'), {
                  onclick: function () { state.hostId = ''; state.severity = ''; state.metric = ''; reload(); },
                })
                : null,
            }),
          ],
        }));
      }

      // ---- breakdowns (template B's panel grid, inside a ListPage) ----------
      function miniTable(titleKey, cols, list) {
        return ui.panel({
          title: t(titleKey),
          children: [ui.dataTable({
            columns: cols,
            rows: list,
            sort: null,
          })],
        });
      }

      function drawBreakdown() {
        if (!summary || !summary.total) { breakdownHost.replaceChildren(); return; }
        var byMetric = (summary.byMetric || []).slice(0, 8).map(function (m) {
          return {
            cells: {
              metric: ui.hostLink(m.metric, function () {
                state.metric = state.metric === m.metric ? '' : m.metric;
                loadList();
              }),
              count: String(m.count),
              avg: sigma(m.avgDeviation),
              max: sigma(m.maxDeviation),
            },
          };
        });
        var byHost = (summary.byHost || []).slice(0, 8).map(function (h) {
          return {
            cells: {
              host: ui.hostLink(agentName(h.hostId), function () { deps.openAgent(Number(h.hostId)); }),
              count: String(h.count),
              crit: String(h.crit),
              warn: String(h.warn),
              avg: sigma(h.avgDeviation),
            },
          };
        });
        breakdownHost.replaceChildren(ui.panelGrid(
          miniTable('analysis.byMetric', [
            { key: 'metric', label: t('analysis.col.metric') },
            { key: 'count', label: t('analysis.col.count'), width: '80px', num: true },
            { key: 'avg', label: t('analysis.col.avgSigma'), width: '92px', num: true },
            { key: 'max', label: t('analysis.col.maxSigma'), width: '92px', num: true },
          ], byMetric),
          miniTable('analysis.byHost', [
            { key: 'host', label: t('analysis.col.host') },
            { key: 'count', label: t('analysis.col.count'), width: '72px', num: true },
            { key: 'crit', label: 'CRIT', width: '72px', num: true },
            { key: 'warn', label: 'WARN', width: '72px', num: true },
            { key: 'avg', label: t('analysis.col.avgSigma'), width: '88px', num: true },
          ], byHost)));
      }

      // ---- loading ----------------------------------------------------------
      function loadList() {
        drawToolbar();
        listHost.replaceChildren(ui.panel({ title: t('analysis.panel'), children: [ui.loadingState(6)] }));
        return api('/api/findings' + filterQs())
          .then(function (list) { rows = list || []; drawList(); })
          .catch(function (e) {
            rows = [];
            listHost.replaceChildren(ui.panel({
              title: t('analysis.panel'),
              children: [ui.errorState({
                title: t('analysis.err.title'),
                body: errText(e),
                detail: 'GET /api/findings' + filterQs(),
                onRetry: loadList,
              })],
            }));
          });
      }

      function loadSummary() {
        // The overview reflects host + severity but NOT the metric filter, so it
        // stays a full breakdown across metrics and can populate the dropdown.
        return api('/api/findings/summary' + filterQs(['metric']))
          .then(function (s) { summary = s; drawStrip(); drawBreakdown(); drawToolbar(); })
          .catch(function () { summary = null; drawStrip(); drawBreakdown(); });
      }

      function reload() {
        ui.closeDrawer();
        return Promise.all([loadSummary(), loadList()]);
      }

      // A finding that arrives over the socket while this screen is open.
      deps.onLive(function (f) {
        var hostOk = !state.hostId || String(f.hostId) === String(state.hostId);
        var sevOk = !state.severity || f.severity === state.severity;
        var metricOk = !state.metric || f.metric === state.metric;
        if (hostOk && sevOk && metricOk) rows.unshift(f);
        // The totals move whether or not the row is on screen, so they are
        // re-read either way.
        loadSummary();
        if (hostOk && sevOk && metricOk) drawList();
      });

      return api('/agents')
        .catch(function () { return []; })
        .then(function (list) {
          agents = list || [];
          return reload();
        })
        .then(function () { return root2; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.AnalysisView = apiObj;
})(typeof window !== 'undefined' ? window : null);
