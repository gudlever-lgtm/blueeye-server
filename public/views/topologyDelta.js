// public/views/topologyDelta.js — Topology delta, as a ListPage (template A).
//
// Every difference between two LLDP snapshots, newest first: a neighbour that
// appeared or went, a link that changed state, a port that moved, a port that
// will not settle. Built from the contract's components (public/ui.js,
// docs/ui-contract.md).
//
// What this migration changes:
//   * two rows of toggle chips — change type on one, site and severity on the
//     other, with a third row of removable chips repeating them — become a
//     StatStrip for the change types and one Toolbar for the rest;
//   * the feed becomes a DataTable, sortable by time, and the summary gets the
//     width it needs to be read;
//   * "Kritiske" and "Advarsler" were Danish on an English screen. They go
//     through the catalogue now, in both languages.
//
// The change-type filter stays in the URL, so a filtered feed is still one
// link, and the site and severity still come from the SHARED global filter the
// other screens use rather than a second copy of it.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;
    var Delta = deps.Delta;

    var SEV_TONE = { CRIT: 'crit', WARN: 'warn', INFO: 'info' };

    function typeLabel(key) {
      var k = 'delta.type.' + key;
      var v = t(k);
      return v === k ? key.replace(/_/g, ' ') : v;
    }

    function view() {
      var state = deps.state;
      if (!state.sort) state.sort = { key: 'time', dir: 'desc' };

      var page = ui.page();
      var stripHost = el('div', {});
      var toolbarHost = el('div', {});
      var tableHost = el('div', {});

      var events = [];
      var agents = [];
      var locations = [];
      var nameById = {};
      var types = Delta.parseChangeTypes(deps.search());

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('delta.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
        actions: [ui.button('secondary', t('delta.openTopology'), {
          onclick: function () { deps.gotoView('topology'); },
        })],
      }), stripHost, toolbarHost, tableHost);

      function nameFor(hid) { return nameById[hid] || t('delta.hostN', { id: hid }); }

      // A site filter naming a site, not the agents in it: the filter is by
      // site, so the ids are resolved here rather than sent to the server.
      function siteAgentIdSet() {
        var site = deps.filter().site;
        if (!site) return null;
        var want = String(site).toLowerCase();
        var s = new Set();
        agents.forEach(function (a) {
          if (String(a.location_name || '').toLowerCase() === want || String(a.location_id) === want) {
            s.add(Number(a.id));
          }
        });
        return s;
      }

      function filtered() {
        return Delta.filterChanges(events, {
          types: types,
          severityTokens: deps.filter().severity,
          siteAgentIds: siteAgentIdSet(),
        });
      }

      // ---- StatStrip: the change types, as a filter --------------------------
      function drawStrip() {
        var counts = Delta.countByType(events);
        stripHost.replaceChildren(ui.statStrip(Delta.CHANGE_TYPES.map(function (ct) {
          var on = types.indexOf(ct.key) !== -1;
          return {
            value: counts[ct.key] || 0,
            label: typeLabel(ct.key),
            active: on,
            title: t('delta.filterHint'),
            onclick: function () {
              types = on
                ? types.filter(function (k) { return k !== ct.key; })
                : Delta.normalizeTypes(types.concat(ct.key));
              deps.syncTypes(types);
              draw();
            },
          };
        })));
      }

      // ---- Toolbar: site + severity, from the SHARED filter ------------------
      function drawToolbar() {
        var f = deps.filter();
        var dirty = !!f.site || f.severity.length || types.length;
        toolbarHost.replaceChildren(ui.toolbar({
          filters: [
            ui.filter(t('fleet.filter.site'), ui.select({
              label: t('fleet.filter.site'), value: f.site == null ? '' : String(f.site),
              options: [['', t('fleet.filter.allSites')]].concat(locations.map(function (l) {
                return [String(l.id), l.name];
              })),
              onchange: function (e) { deps.setSite(e.target.value || null); draw(); },
            })),
            ui.filter(t('delta.filter.severity'), ui.select({
              label: t('delta.filter.severity'),
              value: f.severity.length === 1 ? f.severity[0] : '',
              options: [
                ['', t('delta.severity.all')],
                ['CRIT', t('changes.group.CRIT')],
                ['WARN', t('changes.group.WARN')],
              ],
              onchange: function (e) { deps.setSeverity(e.target.value ? [e.target.value] : []); draw(); },
            })),
          ],
          actions: [dirty ? ui.button('ghost', t('fleet.clearFilters'), {
            onclick: function () {
              types = [];
              deps.syncTypes(types);
              deps.setSite(null);
              deps.setSeverity([]);
              draw();
            },
          }) : null],
        }));
      }

      // ---- DataTable ---------------------------------------------------------
      function drawTable() {
        if (!events.length) {
          tableHost.replaceChildren(ui.panel({
            title: t('delta.panel'),
            children: [ui.emptyState({ kind: 'ok', title: t('delta.none'), body: t('delta.noneHint') })],
          }));
          return;
        }
        var rows = filtered();
        if (!rows.length) {
          tableHost.replaceChildren(ui.panel({
            title: t('delta.panel'),
            children: [ui.emptyState({
              title: t('delta.noMatch'),
              body: t('delta.noMatchHint'),
              action: ui.button('secondary', t('fleet.clearFilters'), {
                onclick: function () {
                  types = [];
                  deps.syncTypes(types);
                  deps.setSite(null);
                  deps.setSeverity([]);
                  draw();
                },
              }),
            })],
          }));
          return;
        }
        var dir = state.sort.dir === 'asc' ? 1 : -1;
        var key = state.sort.key;
        rows = rows.slice().sort(function (x, y) {
          var a; var b;
          if (key === 'type') { a = Delta.changeTypeOf(x); b = Delta.changeTypeOf(y); }
          else if (key === 'host') { a = nameFor(x.agentId); b = nameFor(y.agentId); }
          else if (key === 'sev') { a = Delta.severityToken(x); b = Delta.severityToken(y); }
          else { a = x.timestamp || ''; b = y.timestamp || ''; }
          if (a < b) return -1 * dir;
          if (a > b) return 1 * dir;
          return 0;
        });
        tableHost.replaceChildren(ui.panel({
          title: t('delta.panel'),
          note: t('delta.count', { shown: rows.length, total: events.length }),
          children: [ui.dataTable({
            columns: [
              { key: 'time', label: t('delta.col.time'), width: '180px', sortable: true, time: true },
              { key: 'type', label: t('delta.col.type'), width: '180px', sortable: true },
              { key: 'host', label: t('delta.col.host'), width: '200px', sortable: true },
              { key: 'sev', label: t('delta.col.sev'), width: '110px', sortable: true },
              { key: 'what', label: t('delta.col.what') },
            ],
            rows: rows.map(function (e) {
              var sev = Delta.severityToken(e);
              return {
                e: e,
                cells: {
                  time: e.timestamp ? ui.fmt.abs(e.timestamp) : '–',
                  type: ui.meta(typeLabel(Delta.changeTypeOf(e))),
                  host: e.agentId != null
                    ? ui.hostLink(nameFor(e.agentId), function () { deps.openAgent(e.agentId); })
                    : ui.meta('–'),
                  sev: ui.badge(SEV_TONE[sev] || 'neutral', sev),
                  what: e.summary || '',
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
          })],
        }));
      }

      function draw() { drawStrip(); drawToolbar(); drawTable(); }

      function load() {
        return deps.fetchAll()
          .then(function (d) {
            events = d.events || [];
            agents = d.agents || [];
            locations = d.locations || [];
            nameById = {};
            agents.forEach(function (a) {
              nameById[a.id] = a.display_name || a.hostname || t('delta.hostN', { id: a.id });
            });
            draw();
          })
          .catch(function (e) {
            // 403 is the answer for a viewer, not a failure: the feed is an
            // evidence record and the endpoint is operator+.
            tableHost.replaceChildren(ui.panel({
              title: t('delta.panel'),
              children: [e.status === 403
                ? ui.emptyState({ icon: '🔒', title: t('delta.forbidden'), body: t('delta.forbiddenHint') })
                : ui.errorState({
                  title: t('delta.err.title'), body: deps.errText(e),
                  detail: 'GET /api/topology/changes', onRetry: load,
                })],
            }));
          });
      }

      tableHost.replaceChildren(ui.panel({ title: t('delta.panel'), children: [ui.loadingState(6)] }));
      return load().then(function () { return page; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.TopologyDeltaView = apiObj;
})(typeof window !== 'undefined' ? window : null);
