// public/views/situations.js — Situations, as a ListPage (template A).
//
// Findings that fired on SEVERAL agents at once, grouped into one cross-agent
// event with a suspected common cause. Built from the contract's components
// (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * the heading, a bare `<select>` in a `.toolbar` div and a hand-built
//     `<table class="data">` become a PageHeader, a Toolbar and a sortable
//     DataTable;
//   * a StatStrip counts the situations by status and filters on a click;
//   * "Loading…", "No situations match." and the error were all one `<td
//     colspan=6>` — three different answers wearing the same clothes. They are
//     a skeleton, an EmptyState and an ErrorState;
//   * the confidence and status badges come off the contract's Badge.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var STATUSES = ['open', 'acknowledged', 'resolved', 'closed'];
    // Still live, so still resolvable — the same pair the server calls
    // LIVE_STATUSES in src/routes/eventClusters.js.
    var LIVE = ['open', 'acknowledged'];
    // The same tones as the situation page (views/situation.js). High
    // confidence was red here and green there — the same value, two answers.
    var STATUS_TONE = { open: 'crit', acknowledged: 'warn', resolved: 'ok', closed: 'neutral' };
    var CONF_TONE = { high: 'ok', medium: 'warn', low: 'neutral' };
    var CONF_RANK = { high: 3, medium: 2, low: 1 };
    var SEV_TONE = { CRIT: 'crit', WARN: 'warn', INFO: 'info' };
    var SEV_RANK = { CRIT: 3, WARN: 2, INFO: 1 };

    function view() {
      var state = deps.state;
      if (!state.sort) state.sort = { key: 'last', dir: 'desc' };
      if (!state.status) state.status = '';

      var page = ui.page();
      var stripHost = el('div', {});
      var toolbarHost = el('div', {});
      var bulkHost = el('div', {});
      var tableHost = el('div', {});
      if (!Array.isArray(state.picked)) state.picked = [];
      var loaded = [];

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('sit.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
        actions: [ui.button('secondary', t('sit.openEvents'), {
          onclick: function () { deps.gotoView('events'); },
        })],
      }), stripHost, toolbarHost, bulkHost, tableHost);

      // Resolving several situations at once. The NOTE is required and shared:
      // one conclusion about the lot of them is the honest reading of the
      // action, and making bulk the one path that skips the note would leave
      // most of the history resolved for no recorded reason.
      function drawBulk() {
        var picked = state.picked || [];
        if (!picked.length || !deps.canWrite()) { bulkHost.replaceChildren(); return; }

        var note = deps.el('input', { type: 'text', placeholder: t('sit.bulkNotePlaceholder') });
        var msg = el('span', { class: 'meta' });
        var go = ui.button('primary', t('sit.bulkResolve', { n: picked.length }), {
          onclick: function () { run(); },
        });

        function run() {
          var text = (note.value || '').trim();
          if (!text) {
            msg.className = 'inline-note is-warn';
            msg.textContent = t('sit.bulkNoteRequired');
            return;
          }
          go.disabled = true;
          msg.className = 'meta';
          msg.textContent = t('sit.bulkWorking');
          deps.bulkResolve(picked.map(Number), text)
            .then(function (r) {
              var stuck = (r.results || []).filter(function (x) { return x.outcome !== 'resolved'; });
              if (stuck.length) {
                msg.className = 'inline-note is-warn';
                msg.textContent = t('sit.bulkPartial', {
                  resolved: r.resolved, requested: r.requested,
                  ids: stuck.map(function (x) { return '#' + x.id; }).join(', '),
                });
              } else {
                msg.textContent = t('sit.bulkDone', { n: r.resolved });
              }
              state.picked = [];
              load();
            })
            .catch(function (e) {
              msg.className = 'inline-note is-crit';
              msg.textContent = deps.errText(e);
              go.disabled = false;
            });
        }

        bulkHost.replaceChildren(ui.panel({
          children: [el('div', { class: 'panel-body' },
            ui.toolbar({
              filters: [
                ui.filter('', ui.meta(t('sit.bulkSelected', { n: picked.length }))),
                ui.filter(t('sit.bulkNote'), note),
              ],
              actions: [go, ui.button('secondary', t('sit.bulkClear'), {
                onclick: function () { state.picked = []; draw(); },
              })],
            }),
            msg)],
        }));
      }

      function drawStrip() {
        var counts = {};
        STATUSES.forEach(function (k) { counts[k] = 0; });
        loaded.forEach(function (c) { if (counts[c.status] !== undefined) counts[c.status] += 1; });
        stripHost.replaceChildren(ui.statStrip(STATUSES.map(function (k) {
          return {
            value: counts[k],
            label: t('sit.status.' + k),
            active: state.status === k,
            tone: k === 'open' ? 'crit' : k === 'acknowledged' ? 'warn' : undefined,
            title: t('sit.statusHint'),
            onclick: function () {
              state.status = state.status === k ? '' : k;
              drawToolbar();
              load();
            },
          };
        })));
      }

      function drawToolbar() {
        toolbarHost.replaceChildren(ui.toolbar({
          filters: [ui.filter(t('sit.col.status'), ui.select({
            label: t('sit.col.status'), value: state.status,
            options: [['', t('sit.allStatuses')]].concat(STATUSES.map(function (k) {
              return [k, t('sit.status.' + k)];
            })),
            onchange: function (e) { state.status = e.target.value; drawStrip(); load(); },
          }))],
          actions: [ui.button('ghost', t('fleet.clearFilters'), {
            disabled: !state.status,
            onclick: function () { state.status = ''; drawToolbar(); drawStrip(); load(); },
          })],
        }));
      }

      function draw() {
        // Anything filtering or a refresh removed cannot stay selected.
        var visibleIds = {};
        (loaded || []).forEach(function (c) { visibleIds[String(c.id)] = true; });
        state.picked = (state.picked || []).filter(function (id) { return visibleIds[String(id)]; });
        drawBulk();
        if (!loaded.length) {
          tableHost.replaceChildren(ui.panel({
            title: t('sit.panel'),
            children: [ui.emptyState({
              title: state.status ? t('sit.noMatch') : t('sit.none'),
              body: state.status ? t('sit.noMatchHint') : t('sit.noneHint'),
              action: state.status
                ? ui.button('secondary', t('fleet.clearFilters'), {
                  onclick: function () { state.status = ''; drawToolbar(); drawStrip(); load(); },
                })
                : null,
            })],
          }));
          return;
        }
        var dir = state.sort.dir === 'asc' ? 1 : -1;
        var read = {
          severity: function (c) { return SEV_RANK[c.alertLastSeverity] || 0; },
          confidence: function (c) { return CONF_RANK[c.confidence] || 0; },
          status: function (c) { return String(c.status || ''); },
          members: function (c) { return (c.memberFindingIds || []).length; },
          cause: function (c) { return String(c.suspectedCommonCause || '').toLowerCase(); },
          first: function (c) { return new Date(c.createdAt || 0).getTime(); },
          last: function (c) { return new Date(c.detectedAt || 0).getTime(); },
        }[state.sort.key];
        var rows = read ? loaded.slice().sort(function (x, y) {
          var a = read(x);
          var b = read(y);
          if (a < b) return -1 * dir;
          if (a > b) return 1 * dir;
          return 0;
        }) : loaded;

        tableHost.replaceChildren(ui.panel({
          title: t('sit.panel'),
          note: t('sit.count', { n: loaded.length }),
          children: [ui.dataTable({
            columns: [
              // How bad it is, first: the severity the situation last alerted
              // at. Confidence says how sure the grouping is — not how urgent.
              { key: 'severity', label: t('sit.col.severity'), width: '100px', sortable: true },
              { key: 'confidence', label: t('sit.col.confidence'), width: '130px', sortable: true },
              { key: 'status', label: t('sit.col.status'), width: '140px', sortable: true },
              { key: 'members', label: t('sit.col.members'), width: '110px', sortable: true, num: true },
              { key: 'cause', label: t('sit.col.cause'), sortable: true },
              { key: 'first', label: t('sit.col.first'), sortable: true, time: true },
              { key: 'last', label: t('sit.col.last'), sortable: true, time: true },
            ],
            select: deps.canWrite() ? {
              selected: state.picked,
              // Only a LIVE situation can be resolved. A resolved or closed one
              // gets no checkbox rather than a checkbox and then a conflict.
              isSelectable: function (row) { return LIVE.indexOf(row.cluster.status) !== -1; },
              onChange: function (keys) { state.picked = keys; drawBulk(); },
            } : null,
            rows: rows.map(function (c) {
              return {
                cluster: c,
                key: c.id,
                cells: {
                  severity: c.alertLastSeverity
                    ? ui.badge(SEV_TONE[c.alertLastSeverity] || 'neutral', c.alertLastSeverity)
                    : ui.meta('–'),
                  confidence: ui.badge(CONF_TONE[c.confidence] || 'neutral', t('sit.conf.' + c.confidence)),
                  status: ui.badge(STATUS_TONE[c.status] || 'neutral', t('sit.status.' + c.status)),
                  members: String((c.memberFindingIds || []).length),
                  cause: ui.hostLink(c.suspectedCommonCause || t('sit.noCause'), function () { deps.openCluster(c.id); }),
                  first: el('span', { title: ui.fmt.abs(c.createdAt) }, ui.fmt.rel(c.createdAt)),
                  last: el('span', { title: ui.fmt.abs(c.detectedAt) }, ui.fmt.rel(c.detectedAt)),
                },
              };
            }),
            sort: state.sort,
            onSort: function (k) {
              state.sort = state.sort.key === k
                ? { key: k, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
                : { key: k, dir: 'desc' };
              draw();
            },
            onOpen: function (row) { deps.openCluster(row.cluster.id); },
          })],
        }));
      }

      function load() {
        tableHost.replaceChildren(ui.panel({ title: t('sit.panel'), children: [ui.loadingState(5)] }));
        return deps.fetchClusters(state.status)
          .then(function (list) {
            loaded = list;
            drawStrip();
            draw();
          })
          .catch(function (e) {
            tableHost.replaceChildren(ui.panel({
              title: t('sit.panel'),
              children: [ui.errorState({
                title: t('sit.err.title'), body: deps.errText(e),
                detail: 'GET /api/event-clusters', onRetry: load,
              })],
            }));
          });
      }

      drawToolbar();
      return load().then(function () { return page; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.SituationsPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
