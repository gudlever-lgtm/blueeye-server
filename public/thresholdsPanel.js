// public/thresholdsPanel.js — Settings → Outage thresholds, built from the UI
// contract's components (docs/ui-contract.md). A SECTION, not a screen: it is
// the body of one Settings tab, so it has no PageHeader of its own
// (scripts/ui-check.js sweeps it under SECTIONS).
//
// A probe outage (the `probe_outages` events Reporting and the event flow read)
// opens only for a metric that HAS a threshold: reachability, latency and
// packet loss are evaluated against the effective threshold for the agent's
// location — its override if it has one, else the global default. Remove the
// global default and, where no location overrides it, that metric is simply
// not evaluated and no outage ever opens for it. The API for this existed
// (GET/PUT /api/thresholds[/:location_id]) with nothing calling it, so the only
// way to see why an outage did or did not open was the database.
//
// What the panel shows, per scope (Global defaults, or one location):
//   * one row per metric, with warning / critical / debounce and WHERE the
//     value comes from — a location row that merely inherits the global is
//     labelled so, because editing it creates an override rather than changing
//     the default everyone else uses;
//   * a metric with no threshold at all is a row too, saying it is not
//     evaluated. An absent row would read as "fine";
//   * edit in a Drawer, with the server's validation errors under the field
//     they are about (critical below warning, debounce out of range).
//
// Admin writes; everyone else reads. Repo convention: createX(deps).

(function (root) {
  'use strict';

  var METRICS = ['reachability', 'latency', 'packet_loss'];

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    function metricLabel(m) {
      return m === 'latency' ? t('thr.metric.latency')
        : m === 'packet_loss' ? t('thr.metric.packet_loss')
          : t('thr.metric.reachability');
    }
    function unitOf(m) { return m === 'latency' ? ' ms' : (m === 'packet_loss' ? ' %' : ''); }
    function valueText(m, v) {
      if (m === 'reachability') return ui.meta(t('thr.anyFailure'));
      return v == null ? ui.meta('—') : String(v) + unitOf(m);
    }

    function view() {
      var state = deps.state;
      if (state.scope == null) state.scope = 'global';
      var canEdit = !!deps.canEdit();

      var root = el('div', {});
      var toolbarHost = el('div', {});
      var bodyHost = el('div', {});
      root.append(
        ui.inlineNote(t('thr.note')),
        toolbarHost, bodyHost);

      var locations = [];

      function scopeName() {
        if (state.scope === 'global') return t('thr.scope.global');
        var loc = locations.filter(function (l) { return String(l.id) === String(state.scope); })[0];
        return loc ? loc.name : '#' + state.scope;
      }

      function drawToolbar() {
        var sel = ui.select({
          label: t('thr.scope'),
          value: state.scope,
          options: [['global', t('thr.scope.global')]].concat(locations.map(function (l) { return [String(l.id), l.name]; })),
          onchange: function (e) { state.scope = e.target.value; load(); },
        });
        toolbarHost.replaceChildren(ui.toolbar({ filters: [ui.filter(t('thr.scope'), sel)] }));
      }

      // One row per metric, whether or not a threshold exists for it.
      function rowsFrom(list) {
        var byMetric = {};
        (list || []).forEach(function (r) { byMetric[r.metric] = r; });
        return METRICS.map(function (m) {
          var r = byMetric[m] || null;
          var source = !r ? 'none'
            : (state.scope === 'global' ? 'global' : (r.source || (r.location_id == null ? 'global' : 'location')));
          return { metric: m, row: r, source: source };
        });
      }

      function sourceBadge(source) {
        if (source === 'none') return ui.badge('warn', t('thr.source.none'));
        if (source === 'location') return ui.badge('info', t('thr.source.location'));
        return state.scope === 'global'
          ? ui.badge('neutral', t('thr.source.default'))
          : ui.badge('neutral', t('thr.source.inherited'));
      }

      function draw(list) {
        var items = rowsFrom(list);
        var anyMissing = items.some(function (it) { return it.source === 'none'; });
        bodyHost.replaceChildren(ui.panel({
          title: t('thr.title', { scope: scopeName() }),
          children: [
            anyMissing ? ui.inlineNote(t('thr.missing'), 'warn') : null,
            ui.dataTable({
              columns: [
                { key: 'metric', label: t('thr.col.metric') },
                { key: 'warning', label: t('thr.col.warning'), width: '120px', num: true },
                { key: 'critical', label: t('thr.col.critical'), width: '120px', num: true },
                { key: 'debounce', label: t('thr.col.debounce'), width: '150px' },
                { key: 'source', label: t('thr.col.source'), width: '170px' },
                canEdit ? { key: 'act', label: '', width: '120px' } : null,
              ].filter(Boolean),
              rows: items.map(function (it) {
                var r = it.row;
                var menu = [];
                // Only what THIS scope owns can be removed from it: a location
                // row that inherits the global has nothing of its own to remove.
                if (r && (state.scope === 'global' || it.source === 'location')) {
                  menu.push({ label: t('thr.remove'), danger: true, onclick: function () { remove(it); } });
                }
                return {
                  key: it.metric,
                  data: it,
                  cells: {
                    metric: metricLabel(it.metric),
                    warning: r ? valueText(it.metric, r.warning_value) : ui.meta('—'),
                    critical: r ? valueText(it.metric, r.critical_value) : ui.meta('—'),
                    debounce: r ? t('thr.debounceN', { n: r.debounce_count }) : ui.meta('—'),
                    source: sourceBadge(it.source),
                    act: canEdit ? ui.rowActions(
                      { label: r ? t('thr.edit') : t('thr.set'), onclick: function () { edit(it); } }, menu) : null,
                  },
                };
              }),
              onOpen: canEdit ? function (row) { edit(row.data); } : null,
            }),
          ],
        }));
      }

      function load() {
        bodyHost.replaceChildren(ui.panel({ children: [ui.loadingState(3)] }));
        var req = state.scope === 'global' ? deps.fetchGlobal() : deps.fetchLocation(state.scope);
        return req.then(function (res) { draw((res && res.thresholds) || []); }).catch(function (e) {
          bodyHost.replaceChildren(ui.panel({
            children: [ui.errorState({
              title: t('thr.err.title'), body: deps.errText(e),
              detail: 'GET /api/thresholds' + (state.scope === 'global' ? '' : '/' + state.scope),
              onRetry: load,
            })],
          }));
        });
      }

      function edit(it) {
        var r = it.row || {};
        var inheriting = state.scope !== 'global' && it.source !== 'location';
        var reach = it.metric === 'reachability';
        var inputs = {
          warning_value: el('input', { type: 'number', min: '0', step: 'any', id: 'thr-warn', value: r.warning_value == null ? '' : String(r.warning_value) }),
          critical_value: el('input', { type: 'number', min: '0', step: 'any', id: 'thr-crit', value: r.critical_value == null ? '' : String(r.critical_value) }),
          debounce_count: el('input', { type: 'number', min: '1', max: '100', step: '1', id: 'thr-debounce', value: String(r.debounce_count || 3) }),
        };
        var errs = {
          warning_value: el('span', { class: 'field-error' }),
          critical_value: el('span', { class: 'field-error' }),
          debounce_count: el('span', { class: 'field-error' }),
        };
        var formErr = el('p', { class: 'field-error' });
        var unit = it.metric === 'latency' ? t('thr.unit.ms') : t('thr.unit.pct');
        var fields = [
          reach ? null : ui.field({ label: t('thr.col.warning') + ' (' + unit + ')', id: 'thr-warn', control: inputs.warning_value, hint: t('thr.hint.warning'), errorNode: errs.warning_value }),
          reach ? null : ui.field({ label: t('thr.col.critical') + ' (' + unit + ')', id: 'thr-crit', control: inputs.critical_value, hint: t('thr.hint.critical'), errorNode: errs.critical_value }),
          ui.field({ label: t('thr.col.debounce'), id: 'thr-debounce', control: inputs.debounce_count, hint: t('thr.hint.debounce'), errorNode: errs.debounce_count }),
        ];
        var saveBtn = ui.button('primary', t('thr.save'), { onclick: save });

        function save() {
          Object.keys(errs).forEach(function (k) { errs[k].textContent = ''; inputs[k].removeAttribute('aria-invalid'); });
          formErr.textContent = '';
          var body = { metric: it.metric, debounce_count: inputs.debounce_count.value };
          if (!reach) {
            body.warning_value = inputs.warning_value.value === '' ? null : inputs.warning_value.value;
            body.critical_value = inputs.critical_value.value === '' ? null : inputs.critical_value.value;
          }
          saveBtn.disabled = true;
          return deps.save(state.scope, body).then(function () {
            ui.closeDrawer();
            deps.toast(t('thr.saved', { metric: metricLabel(it.metric), scope: scopeName() }));
            load();
          }).catch(function (e) {
            saveBtn.disabled = false;
            // The server's own field messages, under the field they are about.
            var details = e && e.data && e.data.details;
            var placed = false;
            if (details && typeof details === 'object') {
              Object.keys(details).forEach(function (k) {
                if (errs[k]) {
                  errs[k].textContent = String(details[k]);
                  inputs[k].setAttribute('aria-invalid', 'true');
                  placed = true;
                }
              });
            }
            if (!placed) formErr.textContent = deps.errText(e);
          });
        }

        ui.openDrawer({
          title: t('thr.editTitle', { metric: metricLabel(it.metric) }),
          meta: scopeName(),
          sections: [
            inheriting ? ui.inlineNote(t('thr.createsOverride')) : null,
            reach ? ui.inlineNote(t('thr.reachNote')) : null,
            ui.formSection({ fields: fields, single: true }),
            formErr,
          ],
          footer: ui.drawerFooter([], [ui.button('secondary', t('thr.cancel'), { onclick: ui.closeDrawer }), saveBtn]),
        });
      }

      function remove(it) {
        var global = state.scope === 'global';
        var msg = global ? t('thr.confirmRemoveGlobal', { metric: metricLabel(it.metric) })
          : t('thr.confirmRemoveOverride', { metric: metricLabel(it.metric), scope: scopeName() });
        if (!deps.confirm(msg)) return Promise.resolve();
        return deps.remove(state.scope, it.metric).then(function () {
          deps.toast(t('thr.removed', { metric: metricLabel(it.metric), scope: scopeName() }));
          load();
        }).catch(function (e) { deps.toast(deps.errText(e), true); });
      }

      drawToolbar();
      deps.fetchLocations().then(function (list) {
        locations = Array.isArray(list) ? list : [];
        drawToolbar();
        // A location scope restored from the last visit is titled by name.
        if (state.scope !== 'global') load();
      }).catch(function () { /* global scope still works */ });
      load();
      return root;
    }

    return { view: view, METRICS: METRICS };
  }

  var apiObj = { create: create, METRICS: METRICS };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.ThresholdsPanel = apiObj;
})(typeof window !== 'undefined' ? window : null);
