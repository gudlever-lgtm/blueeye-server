// public/slaReports.js — Reporting → Availability & outages, built from the UI
// contract's components (docs/ui-contract.md). A SECTION of the Reporting page,
// not a screen of its own (scripts/ui-check.js sweeps it under SECTIONS).
//
// The two probe reports — availability (uptime % per agent from probe
// reachability) and probe outages (the events the outage thresholds open) —
// had seven endpoints under /api/reports and no screen: the only way a person
// ever saw them was a scheduled e-mail. This runs them for any period, shows
// the rows, and downloads the same CSV / print-ready HTML the schedules send
// (both built from src/reports/definitions.js, so the screen and the mail
// cannot disagree about what a report contains).
//
// An outage row carries the two follow-ups that already had an API and no
// caller:
//   * NIS2 draft (GET /api/reports/nis2-draft/:id, operator+) — the CFCS
//     notification draft for that outage, to copy into the authority's form;
//   * Investigate (POST /api/investigation/from-event, operator+) — runs the
//     location-driven investigation for the outage's site or agent, which is
//     then also in Troubleshooting's history.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  var DAY = 24 * 60 * 60 * 1000;

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }

    function metricLabel(m) {
      return m === 'latency' ? t('thr.metric.latency')
        : m === 'packet_loss' ? t('thr.metric.packet_loss')
          : m === 'reachability' ? t('thr.metric.reachability') : String(m || '–');
    }
    function sevBadge(s) {
      return ui.badge(s === 'critical' ? 'crit' : (s === 'warning' ? 'warn' : 'neutral'),
        s === 'critical' ? t('sla.sev.critical') : (s === 'warning' ? t('sla.sev.warning') : String(s || '–')));
    }

    function view() {
      var state = deps.state;
      if (!state.report) state.report = 'availability';
      if (!state.from) state.from = isoDay(Date.now() - 7 * DAY);
      if (!state.to) state.to = isoDay(Date.now());
      if (state.location == null) state.location = '';
      if (state.severity == null) state.severity = '';
      var canWrite = !!deps.canWrite();

      var root = el('div', {});
      var formHost = el('div', {});
      var bodyHost = el('div', {});
      root.append(formHost, bodyHost);
      var locations = [];

      // The period is whole days: `to` is the END of the day picked, so
      // "today" includes today rather than stopping at midnight.
      function query() {
        var qs = new URLSearchParams();
        qs.set('from', new Date(state.from + 'T00:00:00Z').toISOString());
        qs.set('to', new Date(new Date(state.to + 'T00:00:00Z').getTime() + DAY - 1).toISOString());
        if (state.location) qs.set('location_id', state.location);
        if (state.report === 'probe_outages' && state.severity) qs.set('severity', state.severity);
        return qs.toString();
      }
      function base() { return state.report === 'probe_outages' ? '/api/reports/probe-outages' : '/api/reports/availability'; }
      function fileBase() { return state.report === 'probe_outages' ? 'blueeye-probe-outages' : 'blueeye-availability'; }

      function drawForm() {
        var reportSel = ui.select({
          id: 'sla-report', label: t('sla.report'), value: state.report,
          options: [['availability', t('rs.report.availability')], ['probe_outages', t('rs.report.probe_outages')]],
          onchange: function (e) { state.report = e.target.value; drawForm(); run(); },
        });
        var fromIn = el('input', { type: 'date', id: 'sla-from', value: state.from, onchange: function (e) { state.from = e.target.value; } });
        var toIn = el('input', { type: 'date', id: 'sla-to', value: state.to, onchange: function (e) { state.to = e.target.value; } });
        var locSel = ui.select({
          id: 'sla-location', label: t('sla.location'), value: state.location,
          options: [['', t('rs.location.all')]].concat(locations.map(function (l) { return [String(l.id), l.name]; })),
          onchange: function (e) { state.location = e.target.value; },
        });
        var sevSel = state.report === 'probe_outages' ? ui.select({
          id: 'sla-severity', label: t('sla.severity'), value: state.severity,
          options: [['', t('rs.severity.all')], ['warning', t('sla.sev.warning')], ['critical', t('sla.sev.critical')]],
          onchange: function (e) { state.severity = e.target.value; },
        }) : null;
        formHost.replaceChildren(ui.panel({
          children: [
            ui.toolbar({
              filters: [
                ui.filter(t('sla.report'), reportSel),
                ui.filter(t('sla.from'), fromIn),
                ui.filter(t('sla.to'), toIn),
                ui.filter(t('sla.location'), locSel),
                sevSel ? ui.filter(t('sla.severity'), sevSel) : null,
              ],
              actions: [
                ui.button('primary', t('sla.run'), { onclick: run }),
                ui.button('secondary', t('sla.csv'), { onclick: function () { deps.download(base() + '.csv?' + query(), fileBase() + '.csv'); } }),
                ui.button('secondary', t('sla.print'), { onclick: function () { deps.print(base() + '.html?' + query()); } }),
              ],
            }),
            ui.inlineNote(t('sla.note')),
            deps.openSchedules ? el('p', {}, ui.hostLink(t('sla.toSchedules'), deps.openSchedules)) : null,
          ],
        }));
      }

      function availabilityTable(rows) {
        if (!rows.length) {
          return ui.emptyState({ kind: 'nodata', title: t('sla.noAvailability'), body: t('sla.noAvailabilityHint') });
        }
        return ui.dataTable({
          columns: [
            { key: 'location', label: t('sla.col.location') },
            { key: 'agent', label: t('sla.col.agent') },
            { key: 'uptime', label: t('sla.col.uptime'), width: '110px', num: true },
            { key: 'down', label: t('sla.col.down'), width: '110px', num: true },
            { key: 'total', label: t('sla.col.samples'), width: '110px', num: true },
          ],
          rows: rows.map(function (r) {
            return {
              key: r.agentId,
              cells: {
                location: r.locationName || ui.meta(t('sla.unassigned')),
                agent: deps.openAgent ? ui.hostLink(r.agentName || '#' + r.agentId, function () { deps.openAgent(r.agentId); }) : (r.agentName || '#' + r.agentId),
                uptime: r.uptimePct == null ? ui.meta('—') : r.uptimePct + ' %',
                down: String(r.down),
                total: String(r.total),
              },
            };
          }),
        });
      }

      function openDraft(o) {
        var body = el('div', {}, ui.loadingState(4));
        ui.openDrawer({
          title: t('sla.draftTitle', { id: o.id }),
          meta: o.affectedTarget || '',
          sections: [ui.inlineNote(t('sla.draftNote')), body],
        });
        return deps.fetchDraft(o.id).then(function (d) {
          var text = (d && d.draft) || '';
          body.replaceChildren(
            el('pre', {}, text),
            ui.button('secondary', t('sla.copy'), { onclick: function () { deps.copy(text); } }));
        }).catch(function (e) {
          body.replaceChildren(ui.errorState({
            title: t('sla.draftErr'), body: deps.errText(e),
            detail: 'GET /api/reports/nis2-draft/' + o.id,
          }));
        });
      }

      function investigate(o) {
        var body = el('div', {}, ui.loadingState(5));
        ui.openDrawer({
          title: t('sla.invTitle', { id: o.id }),
          meta: (o.locationName || o.agentName || '') + ' · ' + metricLabel(o.metric),
          sections: [body],
        });
        return deps.investigate(o.id).then(function (res) {
          var inv = res && res.investigation;
          body.replaceChildren(
            inv ? deps.card(inv) : ui.emptyState({ title: t('sla.invNone') }),
            deps.openTroubleshooting ? el('p', {}, ui.hostLink(t('sla.invHistory'), deps.openTroubleshooting)) : null);
        }).catch(function (e) {
          // 422: the outage has neither a site nor an agent to investigate.
          body.replaceChildren(ui.errorState({
            title: e && e.status === 422 ? t('sla.invNoLocation') : t('sla.invErr'),
            body: deps.errText(e),
            detail: 'POST /api/investigation/from-event',
          }));
        });
      }

      function outagesTable(rows) {
        if (!rows.length) {
          return ui.emptyState({ kind: 'nodata', title: t('sla.noOutages'), body: t('sla.noOutagesHint') });
        }
        return ui.dataTable({
          columns: [
            { key: 'id', label: '#', width: '64px', num: true },
            { key: 'started', label: t('sla.col.started'), width: '130px', time: true },
            { key: 'severity', label: t('sla.col.severity'), width: '110px' },
            { key: 'metric', label: t('sla.col.metric'), width: '120px' },
            { key: 'target', label: t('sla.col.target') },
            { key: 'where', label: t('sla.col.where') },
            { key: 'duration', label: t('sla.col.duration'), width: '120px' },
            canWrite ? { key: 'act', label: '', width: '150px' } : null,
          ].filter(Boolean),
          rows: rows.map(function (o) {
            return {
              key: o.id,
              cells: {
                id: String(o.id),
                started: ui.fmt.short(o.startedAt),
                severity: sevBadge(o.severity),
                metric: metricLabel(o.metric),
                target: o.affectedTarget || '—',
                where: [o.locationName, o.agentName].filter(Boolean).join(' · ') || ui.meta(t('sla.unassigned')),
                duration: o.status === 'active' ? ui.badge('crit', t('sla.ongoing'))
                  : (o.durationSeconds == null ? ui.meta('—') : ui.fmt.duration(o.durationSeconds * 1000)),
                act: canWrite ? ui.rowActions(
                  { label: t('sla.investigate'), onclick: function () { investigate(o); } },
                  [{ label: t('sla.draft'), onclick: function () { openDraft(o); } }]) : null,
              },
            };
          }),
        });
      }

      function run() {
        bodyHost.replaceChildren(ui.panel({ children: [ui.loadingState(5)] }));
        var want = state.report;
        var path = base() + '?' + query();
        return deps.fetch(path).then(function (res) {
          if (want !== state.report) return;
          var outages = want === 'probe_outages';
          var rows = outages ? ((res && res.probeOutages) || []) : ((res && res.agents) || []);
          bodyHost.replaceChildren(ui.panel({
            title: outages ? t('rs.report.probe_outages') : t('rs.report.availability'),
            note: t('sla.period', { from: state.from, to: state.to, n: rows.length }),
            children: [outages ? outagesTable(rows) : availabilityTable(rows)],
          }));
        }).catch(function (e) {
          if (want !== state.report) return;
          bodyHost.replaceChildren(ui.panel({
            children: [ui.errorState({
              title: t('sla.err'), body: deps.errText(e), detail: 'GET ' + base(), onRetry: run,
            })],
          }));
        });
      }

      drawForm();
      deps.fetchLocations().then(function (list) {
        locations = Array.isArray(list) ? list : [];
        drawForm();
      }).catch(function () { /* "All locations" still works */ });
      run();
      return root;
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.SlaReports = apiObj;
})(typeof window !== 'undefined' ? window : null);
