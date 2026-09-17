// public/views/investigate.js — Investigate, as a FormPage (template C).
//
// Pick a target and a window, and get the fault classified — LOCAL, UPSTREAM,
// DOWNSTREAM, APP_NOT_NET or INSUFFICIENT_DATA — with the evidence it rests on.
// Built from the contract's components (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * the three loose labels become a FormSection, and "Investigate" becomes
//     the page's one primary action;
//   * errors stop being a grey sentence under the form. A validation problem
//     belongs to the field it is about; a failed run is an ErrorState that
//     names the call;
//   * the history was a stack of full cards, each as long as the result you
//     just ran. It is a DataTable, and a row opens the run in the Drawer;
//   * the page is called Investigate — the title said "Troubleshooting", which
//     is a different screen in the same section.
//
// The classification card itself (`investigationCard`) stays in app.js: it is
// shared with nothing today, but it carries the NIS2 draft block and the
// AI-narrative fold, each of which migrates on its own terms. The view asks for
// it and app.js hands it over.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var CLASS_TONE = {
      LOCAL: 'crit', UPSTREAM: 'warn', DOWNSTREAM: 'warn',
      APP_NOT_NET: 'info', INSUFFICIENT_DATA: 'neutral',
    };
    function classLabel(key) {
      var k = 'inv.class.' + key;
      var v = t(k);
      return v === k ? String(key || '–') : v;
    }
    function confidence(inv) {
      return typeof inv.confidence === 'number' ? Math.round(inv.confidence * 100) + ' %' : '–';
    }

    function view() {
      var state = deps.state;
      if (!state.type) state.type = 'agent';
      if (!state.window) state.window = '30';

      var page = ui.page();
      var formHost = el('div', {});
      var resultHost = el('div', {});
      var historyHost = el('div', {});

      var agents = [];
      var locations = [];
      var history = [];
      var errorNode = el('span', {});
      var runBtn = null;

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('inv.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
      }), formHost, resultHost, historyHost);

      // ---- FormSection -------------------------------------------------------
      // The value control depends on the target type: a list when the server
      // knows the options, free text when it cannot.
      function valueControl() {
        if (state.type === 'agent') {
          return ui.select({
            id: 'inv-value', label: t('inv.value'),
            value: state.value || '',
            options: [['', t('inv.pickAgent')]].concat(agents.map(function (a) {
              return [String(a.id), a.display_name || a.hostname];
            })),
            onchange: function (e) { state.value = e.target.value; clearError(); },
          });
        }
        if (state.type === 'site') {
          return ui.select({
            id: 'inv-value', label: t('inv.value'),
            value: state.value || '',
            options: [['', t('inv.pickSite')]].concat(locations.map(function (l) {
              return [String(l.id), l.name];
            })),
            onchange: function (e) { state.value = e.target.value; clearError(); },
          });
        }
        var input = el('input', {
          id: 'inv-value', type: 'text',
          placeholder: state.type === 'subnet' ? t('inv.egSubnet') : t('inv.egInterface'),
          oninput: function (e) { state.value = e.target.value; clearError(); },
        });
        input.value = state.value || '';
        return input;
      }

      function clearError() { errorNode.replaceChildren(); }
      function showError(text) {
        errorNode.replaceChildren(el('span', { class: 'field-error' }, text));
      }

      function drawForm() {
        errorNode = el('span', {});
        runBtn = ui.button('primary', t('inv.run'), { onclick: run });
        formHost.replaceChildren(ui.panel({
          children: [
            ui.formSection({
              title: t('inv.form'),
              hint: t('inv.formHint'),
              fields: [
                ui.field({
                  id: 'inv-type', label: t('inv.type'),
                  control: ui.select({
                    id: 'inv-type', label: t('inv.type'), value: state.type,
                    options: [
                      ['agent', t('inv.type.agent')],
                      ['interface', t('inv.type.interface')],
                      ['subnet', t('inv.type.subnet')],
                      ['site', t('inv.type.site')],
                    ],
                    onchange: function (e) {
                      state.type = e.target.value;
                      state.value = '';
                      drawForm();
                    },
                  }),
                }),
                ui.field({
                  id: 'inv-value', label: t('inv.value'),
                  control: valueControl(),
                  errorNode: errorNode,
                }),
                ui.field({
                  id: 'inv-window', label: t('inv.window'),
                  hint: t('inv.windowHint'),
                  control: ui.select({
                    id: 'inv-window', label: t('inv.window'), value: state.window,
                    options: [['15', t('inv.window.15')], ['30', t('inv.window.30')], ['60', t('inv.window.60')]],
                    onchange: function (e) { state.window = e.target.value; },
                  }),
                }),
              ],
            }),
            ui.formActions([runBtn]),
          ],
        }));
      }

      // ---- the run -----------------------------------------------------------
      function run() {
        var value = String(state.value || '').trim();
        if (!value) { showError(t('inv.needValue')); return; }
        clearError();
        runBtn.disabled = true;
        runBtn.textContent = t('inv.running');
        resultHost.replaceChildren(ui.panel({
          title: t('inv.result'), children: [ui.loadingState(4)],
        }));
        deps.run({ type: state.type, value: value, windowMinutes: Number(state.window) })
          .then(function (inv) {
            resultHost.replaceChildren(ui.panel({
              title: t('inv.result'),
              note: t('inv.resultNote', { window: state.window }),
              children: [deps.card(inv)],
            }));
            return loadHistory();
          })
          .catch(function (e) {
            resultHost.replaceChildren(ui.panel({
              title: t('inv.result'),
              children: [ui.errorState({
                title: t('inv.err.run'), body: deps.errText(e),
                detail: 'POST /api/investigation/run', onRetry: run,
              })],
            }));
          })
          .then(function () {
            runBtn.disabled = false;
            runBtn.textContent = t('inv.run');
          });
      }

      // ---- history -----------------------------------------------------------
      function targetOf(inv) {
        var ref = inv.locationRef || {};
        var label = ref.value == null ? '–' : String(ref.value);
        if (ref.type === 'agent') {
          var a = agents.filter(function (x) { return String(x.id) === String(ref.value); })[0];
          if (a) label = a.display_name || a.hostname;
        } else if (ref.type === 'site') {
          var l = locations.filter(function (x) { return String(x.id) === String(ref.value); })[0];
          if (l) label = l.name;
        }
        return label;
      }

      function drawHistory() {
        if (!history.length) {
          historyHost.replaceChildren(ui.panel({
            title: t('inv.history'),
            children: [ui.emptyState({ kind: 'nodata', title: t('inv.noHistory'), body: t('inv.noHistoryHint') })],
          }));
          return;
        }
        historyHost.replaceChildren(ui.panel({
          title: t('inv.history'),
          note: t('inv.historyCount', { n: history.length }),
          children: [ui.dataTable({
            dense: true,
            columns: [
              { key: 'when', label: t('inv.col.when'), width: '180px', time: true },
              { key: 'target', label: t('inv.col.target'), width: '220px' },
              { key: 'verdict', label: t('inv.col.verdict'), width: '170px' },
              { key: 'conf', label: t('inv.col.confidence'), width: '120px', num: true },
              { key: 'why', label: t('inv.col.why') },
            ],
            rows: history.map(function (inv) {
              return {
                inv: inv,
                cells: {
                  when: ui.fmt.abs(inv.createdAt || (inv.window && inv.window.to)),
                  target: ui.meta(targetOf(inv)),
                  verdict: ui.badge(CLASS_TONE[inv.classification] || 'neutral', classLabel(inv.classification)),
                  conf: confidence(inv),
                  why: inv.explanation || '–',
                },
              };
            }),
            onOpen: function (row, tr) {
              ui.openDrawer({
                title: classLabel(row.inv.classification),
                meta: targetOf(row.inv) + ' · ' + ui.fmt.abs(row.inv.createdAt || ''),
                status: ui.badge(CLASS_TONE[row.inv.classification] || 'neutral', classLabel(row.inv.classification)),
                row: tr,
                sections: [deps.card(row.inv)],
              });
            },
          })],
        }));
      }

      function loadHistory() {
        return deps.fetchHistory()
          .then(function (list) { history = list; drawHistory(); })
          .catch(function () {
            historyHost.replaceChildren(ui.panel({
              title: t('inv.history'),
              children: [ui.emptyState({ kind: 'nodata', title: t('inv.noHistory'), body: t('inv.historyFailed') })],
            }));
          });
      }

      historyHost.replaceChildren(ui.panel({ title: t('inv.history'), children: [ui.loadingState(4)] }));
      return deps.fetchTargets()
        .then(function (d) {
          agents = d.agents || [];
          locations = d.locations || [];
          drawForm();
          return loadHistory();
        })
        .then(function () { return page; })
        .catch(function (e) {
          formHost.replaceChildren(ui.panel({
            children: [ui.errorState({
              title: t('inv.err.targets'), body: deps.errText(e), detail: 'GET /agents',
            })],
          }));
          return page;
        });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.InvestigateView = apiObj;
})(typeof window !== 'undefined' ? window : null);
