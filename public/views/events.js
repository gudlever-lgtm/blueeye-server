// public/views/events.js — Events, as a ListPage (template A).
//
// Related anomalies on one device, grouped into a case you can track from open
// to closed. Built from the contract's components (public/ui.js,
// docs/ui-contract.md).
//
// What this migration changes:
//   * the filters were a row of controls INSIDE the table header, one per
//     column — clever, and the only table in the app that did it. They are a
//     Toolbar, which is where the contract puts filters and where Analysis's
//     went when it migrated;
//   * a StatStrip counts the events by status, and a card filters on it: "how
//     many are still open" was a question this page could not answer without
//     reading the rows;
//   * the "🧭 Guide" button in every row becomes the row's action. It was a
//     pill — a chip carrying an action, which is neither a state nor metadata;
//   * severity and status badges come off the contract's Badge, so they follow
//     the palette like every other badge.
//
// What it keeps: status, severity and device filter server-side (the server
// keys events by device, so those narrow the query), location client-side
// (it does not), and clicking a row opens the event.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var SEV_TONE = { CRIT: 'crit', WARN: 'warn', INFO: 'info' };
    var STATUS_TONE = { open: 'info', investigating: 'warn', resolved: 'ok', closed: 'neutral' };
    var SEV_RANK = { CRIT: 3, WARN: 2, INFO: 1 };

    // The event state machine, mirrored for the UI. It lives in
    // src/eventCases/stateMachine.js and the server enforces it; this copy only
    // decides what to OFFER, so the page never proposes a move the API will
    // refuse. A reopen is deliberately absent — it needs a comment, which is a
    // per-event conversation rather than a bulk action.
    //
    // `open` has TWO next steps: most events are read and dismissed in one go,
    // and making those walk through `investigating` recorded a step nobody
    // performed.
    var LEGAL_NEXT = {
      open: ['investigating', 'resolved'],
      investigating: ['resolved'],
      resolved: ['closed'],
    };

    function view() {
      var state = deps.state;
      if (!state.sort) state.sort = { key: 'last', dir: 'desc' };
      if (!state.filters) state.filters = { status: '', severity: '', device: '', location: '' };

      var page = ui.page();
      var stripHost = el('div', {});
      var toolbarHost = el('div', {});
      var bulkHost = el('div', {});
      var tableHost = el('div', {});
      var loaded = [];
      if (!Array.isArray(state.picked)) state.picked = [];

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('events.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
        actions: [ui.button('secondary', t('events.openSituations'), {
          onclick: function () { deps.gotoView('clusters'); },
        })],
      }), stripHost, toolbarHost, bulkHost, tableHost);

      // The bulk bar only exists while something is selected — a permanently
      // visible "0 selected" toolbar is furniture.
      function drawBulk() {
        var picked = state.picked || [];
        if (!picked.length || !deps.canWrite()) { bulkHost.replaceChildren(); return; }

        // Everything selected has to be going to the SAME next status, or the
        // button cannot honestly say what it does. A mixed selection says so
        // and offers nothing.
        var statuses = {};
        picked.forEach(function (id) {
          var ev = loaded.find(function (e) { return String(e.id) === String(id); });
          if (ev) statuses[ev.status] = true;
        });
        var from = Object.keys(statuses);
        // A button PER legal next step. From `open` that is two — "investigating"
        // for the ones somebody is picking up, "resolved" for the ones being
        // dismissed — and naming both beats a dropdown nobody reads.
        var targets = from.length === 1 ? (LEGAL_NEXT[from[0]] || []) : [];

        var note = el('span', { class: 'meta' });
        var acts = targets.map(function (to, i) {
          return ui.button(i === targets.length - 1 ? 'primary' : 'secondary',
            t('events.bulkMove', { n: picked.length, status: t('events.status.' + to) }),
            { onclick: function () { run(to); } });
        });

        function run(status) {
          acts.forEach(function (b) { b.disabled = true; });
          note.className = 'meta';
          note.textContent = t('events.bulkWorking');
          deps.bulkStatus(picked.map(Number), status)
            .then(function (r) {
              var stuck = (r.results || []).filter(function (x) { return x.outcome !== 'moved'; });
              if (stuck.length) {
                note.className = 'inline-note is-warn';
                // NAMED, not counted: "#41, #52 could not move" tells you what
                // to do next; "2 failed" does not.
                note.textContent = t('events.bulkPartial', {
                  moved: r.moved, requested: r.requested,
                  ids: stuck.map(function (x) { return '#' + x.id; }).join(', '),
                });
              } else {
                note.textContent = t('events.bulkDone', { n: r.moved });
              }
              state.picked = [];
              load();
            })
            .catch(function (e) {
              note.className = 'inline-note is-crit';
              note.textContent = deps.errText(e);
              acts.forEach(function (b) { b.disabled = false; });
            });
        }

        bulkHost.replaceChildren(ui.panel({
          children: [el('div', { class: 'panel-body' },
            ui.toolbar({
              filters: [ui.filter('', ui.meta(t('events.bulkSelected', { n: picked.length })))],
              actions: acts.concat([ui.button('secondary', t('events.bulkClear'), {
                onclick: function () { state.picked = []; draw(); },
              })]),
            }),
            targets.length ? null : ui.inlineNote(t('events.bulkMixed'), 'info'),
            note)],
        }));
      }

      // Location is the one filter the server cannot do — events are keyed by
      // device, not by site — so it narrows what was loaded.
      function shown() {
        var loc = String(state.filters.location || '').toLowerCase();
        return loc
          ? loaded.filter(function (i) {
            return String(i.locationName || '').toLowerCase().indexOf(loc) !== -1;
          })
          : loaded;
      }

      // ---- StatStrip ---------------------------------------------------------
      function drawStrip() {
        var counts = { open: 0, investigating: 0, resolved: 0, closed: 0 };
        loaded.forEach(function (i) {
          if (counts[i.status] !== undefined) counts[i.status] += 1;
        });
        stripHost.replaceChildren(ui.statStrip(['open', 'investigating', 'resolved', 'closed'].map(function (k) {
          return {
            value: counts[k],
            label: t('events.status.' + k),
            active: state.filters.status === k,
            tone: k === 'open' ? 'crit' : k === 'investigating' ? 'warn' : undefined,
            title: t('events.statusHint'),
            onclick: function () {
              state.filters.status = state.filters.status === k ? '' : k;
              drawToolbar();
              load();
            },
          };
        })));
      }

      // ---- Toolbar -----------------------------------------------------------
      // A search field that hits the SERVER commits on Enter or blur; one that
      // narrows what is already loaded reacts as you type. Either way the state
      // is read off the event, so a commit never uses a stale value.
      function searchField(key, label, onCommit) {
        var take = function (e) { state.filters[key] = String(e.target.value || '').trim(); };
        var input = el('input', {
          type: 'search', 'aria-label': label, placeholder: label,
          oninput: function (e) { take(e); syncClear(); if (!onCommit) draw(); },
          onkeydown: function (e) { if (e.key === 'Enter' && onCommit) { take(e); onCommit(); } },
          onchange: function (e) { take(e); if (onCommit) onCommit(); },
        });
        input.value = state.filters[key] || '';
        return ui.filter(label, input);
      }

      // Clear is always present and disabled when there is nothing to clear.
      // Showing it only when a filter is set would mean rebuilding the toolbar
      // on every keystroke in the location field — and losing the focus with it.
      var clearBtn = null;
      function syncClear() {
        var f = state.filters;
        if (clearBtn) clearBtn.disabled = !(f.status || f.severity || f.device || f.location);
      }
      function clearFilters() {
        state.filters = { status: '', severity: '', device: '', location: '' };
        drawToolbar();
        drawStrip();
        load();
      }

      function drawToolbar() {
        var f = state.filters;
        clearBtn = ui.button('ghost', t('fleet.clearFilters'), { onclick: clearFilters });
        toolbarHost.replaceChildren(ui.toolbar({
          filters: [
            ui.filter(t('events.colStatus'), ui.select({
              label: t('events.colStatus'), value: f.status,
              options: [['', t('events.allStatuses')]].concat(
                ['open', 'investigating', 'resolved', 'closed'].map(function (k) {
                  return [k, t('events.status.' + k)];
                })),
              onchange: function (e) { f.status = e.target.value; drawStrip(); load(); },
            })),
            ui.filter(t('events.colSeverity'), ui.select({
              label: t('events.colSeverity'), value: f.severity,
              options: [['', t('events.allSeverities')], ['CRIT', 'CRIT'], ['WARN', 'WARN'], ['INFO', 'INFO']],
              onchange: function (e) { f.severity = e.target.value; load(); },
            })),
            // Device narrows the QUERY; location narrows what came back.
            searchField('device', t('events.filterDevice'), function () { load(); }),
            searchField('location', t('events.filterLocation'), null),
          ],
          actions: [clearBtn],
        }));
        syncClear();
      }

      // ---- DataTable ---------------------------------------------------------
      function sortRows(list) {
        var dir = state.sort.dir === 'asc' ? 1 : -1;
        var read = {
          severity: function (i) { return SEV_RANK[i.severity] || 0; },
          status: function (i) { return String(i.status || ''); },
          condition: function (i) { return deps.condition(i).toLowerCase(); },
          device: function (i) { return deps.agentLabel(i).toLowerCase(); },
          location: function (i) { return String(i.locationName || '').toLowerCase(); },
          first: function (i) { return new Date(i.firstEventAt || 0).getTime(); },
          last: function (i) { return new Date(i.lastEventAt || 0).getTime(); },
        }[state.sort.key];
        if (!read) return list;
        return list.slice().sort(function (x, y) {
          var a = read(x);
          var b = read(y);
          if (a < b) return -1 * dir;
          if (a > b) return 1 * dir;
          return 0;
        });
      }

      function draw() {
        var rows = sortRows(shown());
        // A row that filtering or a refresh removed cannot stay selected: a
        // bulk action must only ever touch what the reader can see.
        var visible = {};
        rows.forEach(function (r) { visible[String(r.id)] = true; });
        state.picked = (state.picked || []).filter(function (id) { return visible[String(id)]; });
        drawBulk();
        if (!loaded.length) {
          tableHost.replaceChildren(ui.panel({
            title: t('events.panel'),
            children: [ui.emptyState({ title: t('events.none'), body: t('events.noneHint') })],
          }));
          return;
        }
        if (!rows.length) {
          tableHost.replaceChildren(ui.panel({
            title: t('events.panel'),
            children: [ui.emptyState({
              title: t('events.noMatch'),
              body: t('events.noMatchHint'),
              action: ui.button('secondary', t('fleet.clearFilters'), { onclick: clearFilters }),
            })],
          }));
          return;
        }
        tableHost.replaceChildren(ui.panel({
          title: t('events.panel'),
          note: t('events.count', { shown: rows.length, total: loaded.length }),
          children: [ui.dataTable({
            // Eight columns is more than fixed widths can carry at 1280: the
            // flexible one (the condition, which is the point of the row) gets
            // squeezed to nothing. Only the three that must not move are
            // pinned; the browser lays the rest out.
            columns: [
              { key: 'severity', label: t('events.colSeverity'), width: '108px', sortable: true },
              { key: 'status', label: t('events.colStatus'), width: '124px', sortable: true },
              { key: 'condition', label: t('events.colCondition'), sortable: true },
              { key: 'device', label: t('events.colDevice'), sortable: true },
              { key: 'location', label: t('events.colLocation'), sortable: true },
              { key: 'first', label: t('events.colFirst'), sortable: true, time: true },
              { key: 'last', label: t('events.colLast'), sortable: true, time: true },
              deps.canWrite() ? { key: 'act', label: '', width: '104px' } : null,
            ].filter(Boolean),
            // Selection is operator+, because the action behind it is.
            select: deps.canWrite() ? {
              selected: state.picked,
              // Only rows that can actually move are tickable. Offering a
              // checkbox on a closed event and then reporting "illegal" for it
              // is a worse answer than not offering it.
              isSelectable: function (row) { return !!LEGAL_NEXT[row.event.status]; },
              onChange: function (keys) { state.picked = keys; drawBulk(); },
            } : null,
            rows: rows.map(function (i) {
              return {
                event: i,
                key: i.id,
                cells: {
                  severity: ui.badge(SEV_TONE[i.severity] || 'neutral', i.severity),
                  status: ui.badge(STATUS_TONE[i.status] || 'neutral', t('events.status.' + i.status)),
                  // The condition only: severity, device and site are the
                  // columns either side, and the stored title repeats all three.
                  // The full title is still the row's tooltip.
                  // …plus the situation it is part of, when other agents
                  // see the same fault (migration 129).
                  condition: el('span', { title: i.title || '' }, deps.condition(i),
                    i.clusterId != null && typeof deps.openCluster === 'function'
                      ? el('span', {}, ' ', ui.hostLink(t('events.partOfSituation', { id: i.clusterId }),
                        function () { deps.openCluster(i.clusterId); }))
                      : null),
                  device: ui.hostLink(deps.agentLabel(i), function () { deps.openEvent(i.id); }),
                  location: i.locationName ? ui.meta(i.locationName) : ui.metaXs(deps.locationLabel(i)),
                  first: el('span', { title: ui.fmt.abs(i.firstEventAt) }, ui.fmt.rel(i.firstEventAt)),
                  last: el('span', { title: ui.fmt.abs(i.lastEventAt) }, ui.fmt.rel(i.lastEventAt)),
                  act: deps.canWrite()
                    ? ui.rowActions({ label: t('events.guide'), onclick: function () { deps.guide(i.id); } }, null)
                    : '',
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
            onOpen: function (row) { deps.openEvent(row.event.id); },
          })],
        }));
      }

      function load() {
        tableHost.replaceChildren(ui.panel({ title: t('events.panel'), children: [ui.loadingState(6)] }));
        return deps.fetchEvents({
          status: state.filters.status,
          severity: state.filters.severity,
          device: state.filters.device,
        })
          .then(function (list) {
            loaded = list;
            drawStrip();
            draw();
          })
          .catch(function (e) {
            tableHost.replaceChildren(ui.panel({
              title: t('events.panel'),
              children: [ui.errorState({
                title: t('events.err.title'), body: deps.errText(e),
                detail: 'GET /api/events', onRetry: load,
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
  if (root) root.EventsPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
