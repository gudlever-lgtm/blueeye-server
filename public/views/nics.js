// public/views/nics.js — NICs, as a DashboardPage (template B).
//
// The fleet's network cards: which models are deployed, and which of them are
// running mismatched firmware. Built from the contract's components
// (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * the Models / Agents switch was a `.seg` segmented control — two buttons
//     with an `.on` class, which is the "buttons as tabs" the contract forbids.
//     It is SubTabs, and the choice is in the URL;
//   * the agents on a given firmware were `.chip ghost small` buttons: chips
//     carrying an action AND a host name, which the contract forbids twice
//     over. They are HostLinks;
//   * `style: 'margin-left:.4rem'` on the drift badge was the last inline style
//     on this screen;
//   * the summary line was grey prose with one word going red — "3 model(s)
//     with firmware drift". It is a StatStrip, and clicking the drift count
//     filters to the models that have it;
//   * the Agents view stacked one table per agent down the page, each with its
//     own heading. It is one table of agents; the NIC specs open in a Drawer;
//   * a failed load replaced the page with a bare red line. It is an ErrorState
//     naming the call, with a Retry.
//
// The per-agent NIC table is exported: the agent detail page draws the same
// thing, and two copies of it would drift.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    // Shared with the agent detail page.
    function nicTable(nics) {
      if (!Array.isArray(nics) || !nics.length) {
        return ui.emptyState({ title: t('nic.noneAgent'), body: t('nic.noneAgentHint') });
      }
      return ui.dataTable({
        columns: [
          { key: 'iface', label: t('nic.col.iface'), width: '130px' },
          { key: 'driver', label: t('nic.col.driver'), width: '150px' },
          { key: 'driverVersion', label: t('nic.col.driverVer'), width: '140px' },
          { key: 'firmware', label: t('nic.col.firmware'), width: '170px' },
          { key: 'bus', label: t('nic.col.bus') },
        ],
        rows: nics.map(function (n) {
          return {
            cells: {
              iface: n.iface || '—',
              driver: n.driver || '—',
              driverVersion: ui.meta(n.driverVersion || '—'),
              firmware: n.firmwareVersion || '—',
              bus: ui.meta(n.busInfo || n.pciId || '—'),
            },
          };
        }),
      });
    }

    function view() {
      var state = deps.state;
      if (state.driftOnly == null) state.driftOnly = false;
      if (state.q == null) state.q = '';

      var page = ui.page();
      var stripHost = el('div', {});
      var tabsHost = el('div', {});
      var barHost = el('div', {});
      // Two panels in one page slot would otherwise touch — the page's own
      // column gap only separates its direct children.
      var bodyHost = el('div', { class: 'panel-stack' });
      var inv = null;

      var search = el('input', { type: 'search', value: state.q });
      search.addEventListener('input', function () {
        state.q = search.value.trim().toLowerCase();
        drawBody();
      });

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('nic.title'),
        lead: t('nic.lead'),
        help: { title: info.title, body: info.body },
      }), stripHost, tabsHost, barHost, bodyHost);

      function has(v, needle) {
        return String(v == null ? '' : v).toLowerCase().indexOf(needle) >= 0;
      }

      function drawStrip() {
        stripHost.replaceChildren(ui.statStrip([
          { value: inv.agents, label: t('nic.stat.agents') },
          { value: inv.totalNics, label: t('nic.stat.nics') },
          {
            value: inv.drift.length,
            label: t('nic.stat.drift'),
            tone: inv.drift.length ? 'warn' : undefined,
            active: state.driftOnly,
            title: t('nic.stat.driftHint'),
            onclick: function () {
              state.driftOnly = !state.driftOnly;
              // Drift is a property of a model, so the filter only means
              // anything on the Models tab.
              if (state.driftOnly && deps.tab() !== 'models') {
                deps.setTab('models');
                drawTabs();
                drawBar();
              }
              drawStrip();
              drawBody();
            },
          },
        ]));
      }

      function drawTabs() {
        tabsHost.replaceChildren(ui.tabs([['models', t('nic.tab.models')], ['agents', t('nic.tab.agents')]], {
          active: deps.tab(),
          ariaLabel: t('nic.groupBy'),
          onPick: function (key) {
            deps.setTab(key);
            drawBar();
            drawBody();
          },
        }));
      }

      function drawBar() {
        search.placeholder = deps.tab() === 'agents' ? t('nic.searchAgents') : t('nic.searchModels');
        barHost.replaceChildren(ui.toolbar({
          filters: [
            ui.filter(t('nic.search'), search),
            ui.button('ghost', t('nic.clear'), {
              disabled: !state.q && !state.driftOnly,
              onclick: function () {
                state.q = ''; state.driftOnly = false; search.value = '';
                drawStrip(); drawBody();
              },
            }),
          ],
        }));
      }

      // ---- Models -----------------------------------------------------------
      function agentLinks(agents) {
        return el('span', { class: 'nic-agents' }, (agents || []).map(function (a, i) {
          return el('span', {},
            i ? ui.meta(', ') : null,
            ui.hostLink(a.name + (a.iface ? ' (' + a.iface + ')' : ''), function () { deps.openAgent(a.id); }));
        }));
      }

      function modelsBody() {
        var needle = state.q;
        function match(m) {
          return !needle || has(m.label, needle)
            || (m.firmwares || []).some(function (f) { return has(f.firmwareVersion, needle); });
        }
        var drift = inv.drift.filter(match);
        var out = [];

        if (drift.length) {
          // One row per (model, firmware): what is deployed, how many units, and
          // which machines — the outlier is the row worth opening.
          var rows = [];
          drift.forEach(function (m) {
            m.firmwares.forEach(function (f) {
              rows.push({
                cells: {
                  model: m.label,
                  firmware: f.firmwareVersion || '—',
                  state: ui.badge(f.isOutlier ? 'warn' : 'ok', f.isOutlier ? t('nic.outlier') : t('nic.majority')),
                  units: String(f.count),
                  agents: agentLinks(f.agents),
                },
              });
            });
          });
          out.push(ui.panel({
            title: t('nic.drift.title'),
            note: t('nic.drift.note', { n: drift.length }),
            children: [
              el('div', { class: 'panel-body' }, ui.inlineNote(t('nic.drift.hint'), 'warn')),
              ui.dataTable({
                columns: [
                  { key: 'model', label: t('nic.col.model') },
                  { key: 'firmware', label: t('nic.col.firmware'), width: '180px' },
                  { key: 'state', label: t('nic.col.state'), width: '116px' },
                  { key: 'units', label: t('nic.col.units'), width: '84px', num: true },
                  { key: 'agents', label: t('nic.col.agents'), width: '300px' },
                ],
                rows: rows,
              }),
            ],
          }));
        }

        if (state.driftOnly) {
          if (!drift.length) {
            out.push(ui.panel({
              title: t('nic.drift.title'),
              children: [ui.emptyState({
                icon: '✓',
                title: t('nic.noDrift'),
                body: t('nic.noDriftHint'),
                action: ui.button('secondary', t('nic.showAll'), {
                  onclick: function () { state.driftOnly = false; drawStrip(); drawBody(); },
                }),
              })],
            }));
          }
          return out;
        }

        var models = inv.drivers.filter(match);
        out.push(ui.panel({
          title: t('nic.models.title'),
          note: needle
            ? t('nic.models.ofTotal', { n: models.length, total: inv.drivers.length })
            : t('nic.models.count', { n: inv.drivers.length }),
          children: [models.length
            ? ui.dataTable({
              columns: [
                { key: 'model', label: t('nic.col.model') },
                { key: 'units', label: t('nic.col.units'), width: '84px', num: true },
                { key: 'firmwares', label: t('nic.col.firmwares'), width: '340px' },
                { key: 'state', label: t('nic.col.state'), width: '104px' },
              ],
              rows: models.map(function (m) {
                return {
                  cells: {
                    model: m.label,
                    units: String(m.count),
                    firmwares: ui.meta(m.firmwares.map(function (f) {
                      return f.firmwareVersion + ' ×' + f.count;
                    }).join(' · ')),
                    state: m.hasDrift ? ui.badge('warn', t('nic.driftBadge')) : ui.meta('–'),
                  },
                };
              }),
            })
            : ui.emptyState({
              title: needle ? t('nic.noMatch') : t('nic.noModels'),
              body: needle ? t('nic.noMatchHint') : t('nic.noModelsHint'),
              action: needle
                ? ui.button('secondary', t('nic.clear'), {
                  onclick: function () { state.q = ''; search.value = ''; drawBar(); drawBody(); },
                })
                : null,
            })],
        }));
        return out;
      }

      // ---- Agents -----------------------------------------------------------
      function agentsBody() {
        var needle = state.q;
        function nicMatch(n) {
          return !needle || [n.iface, n.driver, n.driverVersion, n.firmwareVersion, n.busInfo, n.pciId]
            .some(function (v) { return has(v, needle); });
        }
        function agentMatch(a) {
          return !needle || has(a.name, needle) || has(a.location, needle) || a.nics.some(nicMatch);
        }
        var agents = inv.byAgent.filter(agentMatch);
        if (!agents.length) {
          return [ui.panel({
            title: t('nic.agents.title'),
            children: [ui.emptyState({
              title: t('nic.noMatch'),
              body: t('nic.noMatchHint'),
              action: ui.button('secondary', t('nic.clear'), {
                onclick: function () { state.q = ''; search.value = ''; drawBar(); drawBody(); },
              }),
            })],
          })];
        }
        return [ui.panel({
          title: t('nic.agents.title'),
          note: needle
            ? t('nic.agents.ofTotal', { n: agents.length, total: inv.byAgent.length })
            : t('nic.agents.count', { n: inv.byAgent.length }),
          children: [ui.dataTable({
            columns: [
              { key: 'agent', label: t('nic.col.agent') },
              { key: 'location', label: t('nic.col.location'), width: '180px' },
              { key: 'count', label: t('nic.col.interfaces'), width: '130px', num: true },
              { key: 'drivers', label: t('nic.col.drivers'), width: '260px' },
            ],
            rows: agents.map(function (a) {
              // When the filter matched a NIC, only the matching ones are the
              // answer; when it matched the agent, all of them are.
              var nics = needle && a.nics.some(nicMatch) ? a.nics.filter(nicMatch) : a.nics;
              return {
                a: a, nics: nics,
                cells: {
                  agent: a.name,
                  location: a.location ? a.location : ui.meta('–'),
                  count: String(a.nics.length),
                  drivers: ui.meta(uniqueDrivers(a.nics).join(', ') || '–'),
                },
              };
            }),
            onOpen: function (r, tr) { openAgentDrawer(r.a, r.nics, tr); },
          })],
        })];
      }

      function uniqueDrivers(nics) {
        var seen = {};
        var out = [];
        (nics || []).forEach(function (n) {
          if (!n.driver || seen[n.driver]) return;
          seen[n.driver] = 1;
          out.push(n.driver);
        });
        return out;
      }

      // The NIC specs used to be a table stacked under every agent, all the way
      // down the page. One agent's cards are a detail, so they open as one.
      function openAgentDrawer(a, nics, tr) {
        ui.openDrawer({
          title: a.name,
          meta: a.location || undefined,
          row: tr,
          sections: [ui.drawerSection(t('nic.drawer.cards'), nicTable(nics))],
          footer: ui.drawerFooter([
            ui.button('secondary', t('nic.drawer.open'), { onclick: function () { deps.openAgent(a.id); } }),
          ]),
        });
      }

      function drawBody() {
        bodyHost.replaceChildren.apply(bodyHost,
          (deps.tab() === 'agents' ? agentsBody() : modelsBody()));
      }

      function load() {
        bodyHost.replaceChildren(ui.panel({ title: t('nic.models.title'), children: [ui.loadingState(5)] }));
        return deps.fetchInventory()
          .then(function (d) {
            inv = d;
            if (!inv.agents) {
              // Nothing reports NIC data yet: a strip of zeros, a tab strip and
              // a search box are four ways of saying the same nothing.
              stripHost.replaceChildren();
              tabsHost.replaceChildren();
              barHost.replaceChildren();
              bodyHost.replaceChildren(ui.panel({
                title: t('nic.models.title'),
                children: [ui.emptyState({
                  icon: '◎',
                  title: t('nic.noInventory'),
                  body: el('span', {},
                    t('nic.noInventoryP1'), ' ', el('code', {}, 'ethtool -i'), ' ', t('nic.noInventoryP2')),
                })],
              }));
              return;
            }
            drawStrip();
            drawTabs();
            drawBar();
            drawBody();
          })
          .catch(function (e) {
            stripHost.replaceChildren();
            tabsHost.replaceChildren();
            barHost.replaceChildren();
            bodyHost.replaceChildren(ui.panel({
              title: t('nic.models.title'),
              children: [ui.errorState({
                title: t('nic.err.title'), body: deps.errText(e),
                detail: 'GET /api/fleet/nics', onRetry: load,
              })],
            }));
          });
      }

      return load().then(function () { return page; });
    }

    return { view: view, nicTable: nicTable };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.NicsPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
