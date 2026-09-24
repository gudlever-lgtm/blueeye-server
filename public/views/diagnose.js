// public/views/diagnose.js — Diagnose, as a FormPage (template C).
//
// Describe the symptom in a sentence, get the causes the playbook catalogue
// knows about, the tests worth running, and — once they have run — a verdict per
// cause with the evidence behind it. Built from the contract's components
// (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * the question, the scope and the examples were a hand-built card. They are
//     a FormSection with one primary action;
//   * the verdict and direction pills become badges, which is what they always
//     meant. A pill was a chip carrying a state;
//   * the run controls were seven elements in a row with a bare <span> for
//     status. They are a form-actions row, and the status is an inline note,
//     so a failure reads as a failure rather than as grey text;
//   * "which matcher produced this" moves from a coloured strip to a badge in
//     the Panel head, where the reader is already looking for what a result is.
//
// What it keeps, deliberately: the per-test selection (a technician who knows a
// test is pointless here should not have to run it), the rounds loop with Stop,
// the one-package-per-agent repeat, and the evidence list — every rule, whether
// it fired, and the sentence behind it, which is what makes a verdict arguable
// rather than asserted.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var VERDICT_TONE = { confirmed: 'crit', ruled_out: 'ok' };
    var RULE_TONE = { fired: 'crit', notFired: 'ok', unknown: 'neutral' };
    var MAX_DESC = 1000;
    var ROUND_GAP_MS = 4000;

    function view() {
      var st = deps.state;
      var page = ui.page();
      var formHost = el('div', {});
      var outHost = el('div', {});

      var agents = [];
      var descInput = null;
      var agentSel = null;
      var peerSel = null;
      var targetIn = null;
      var askBtn = null;
      var askError = el('span', {});
      var examplesHost = el('div', {});

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('diag.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
      }), formHost, outHost);

      // ---- the question ------------------------------------------------------
      function drawForm() {
        askError = el('span', {});
        descInput = el('textarea', {
          id: 'diag-description', rows: '3', maxlength: String(MAX_DESC),
          placeholder: t('diag.field.placeholder'),
          'aria-label': t('diag.field.label'),
          // Kept on state as it is typed: a rebuild (a refresh, a trip to
          // another screen and back) must not lose a half-written description.
          oninput: function () { st.description = descInput.value; askError.replaceChildren(); },
          // Enter is a newline in a textarea, so the shortcut is the modified one.
          onkeydown: function (e) {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); }
          },
        });
        descInput.value = st.description || '';

        var agentOpts = [['', t('diag.agent.none')]].concat(agents.map(function (a) {
          return [String(a.id), a.display_name || a.hostname || ('#' + a.id)];
        }));
        agentSel = ui.select({
          id: 'diag-agent', label: t('diag.agent'), value: st.agentId == null ? '' : String(st.agentId),
          options: agentOpts,
          onchange: function (e) { st.agentId = e.target.value ? Number(e.target.value) : null; },
        });
        peerSel = ui.select({
          id: 'diag-peer', label: t('diag.peer'), value: st.peerAgentId == null ? '' : String(st.peerAgentId),
          options: [['', t('diag.peer.none')]].concat(agentOpts.slice(1)),
          onchange: function (e) { st.peerAgentId = e.target.value ? Number(e.target.value) : null; },
        });
        targetIn = el('input', {
          id: 'diag-target', type: 'text', placeholder: t('diag.target.placeholder'),
          'aria-label': t('diag.target'),
          oninput: function () { st.target = String(targetIn.value || '').trim() || null; },
        });
        targetIn.value = st.target || '';
        askBtn = ui.button('primary', t('diag.submit'), { onclick: ask });

        formHost.replaceChildren(ui.panel({
          children: [
            // No section title: the one field's label is the heading, and
            // printing "Describe the problem" twice is not a hierarchy.
            ui.formSection({
              single: true,
              fields: [
                ui.field({
                  id: 'diag-description', label: t('diag.field.label'),
                  hint: t('diag.field.hint', { max: MAX_DESC }),
                  control: descInput, errorNode: askError,
                }),
                examplesHost,
              ],
            }),
            ui.formSection({
              title: t('diag.scope'),
              hint: t('diag.peer.hint'),
              fields: [
                ui.field({ id: 'diag-agent', label: t('diag.agent'), control: agentSel }),
                ui.field({ id: 'diag-target', label: t('diag.target'), control: targetIn }),
                ui.field({ id: 'diag-peer', label: t('diag.peer'), control: peerSel }),
              ],
            }),
            ui.formActions([askBtn]),
          ],
        }));
      }

      // The examples are the catalogue's own symptoms, so they can never drift
      // from what the matcher actually knows.
      function drawExamples(picks) {
        if (!picks.length) { examplesHost.replaceChildren(); return; }
        examplesHost.replaceChildren(el('div', { class: 'diag-examples' },
          ui.metaXs(t('diag.examples')),
          picks.map(function (sym) {
            return ui.button('ghost', sym, {
              size: 'xs',
              onclick: function () {
                st.description = sym;
                descInput.value = sym;
                descInput.focus();
                askError.replaceChildren();
              },
            });
          })));
      }

      function ask() {
        var description = String(descInput.value || '').trim();
        if (!description) {
          askError.replaceChildren(el('span', { class: 'field-error' }, t('diag.needDescription')));
          descInput.focus();
          return;
        }
        askBtn.disabled = true;
        askBtn.textContent = t('diag.working');
        outHost.replaceChildren(ui.panel({ title: t('diag.causes'), children: [ui.loadingState(4)] }));
        var scope = {
          description: description,
          agentId: agentSel.value ? Number(agentSel.value) : null,
          peerAgentId: peerSel.value && peerSel.value !== agentSel.value ? Number(peerSel.value) : null,
          target: String(targetIn.value || '').trim() || null,
        };
        deps.ask(scope)
          .then(function (plan) {
            st.description = description;
            st.agentId = scope.agentId;
            st.peerAgentId = scope.peerAgentId;
            st.target = scope.target;
            st.plan = plan;
            st.evaluation = null;
            st.testRows = null;
            st.selectedTests = null;
            st.selectionSeeded = false;
            drawPlan();
          })
          .catch(function (e) {
            outHost.replaceChildren(ui.panel({
              title: t('diag.causes'),
              children: [ui.errorState({
                title: t('diag.err.ask'), body: deps.errText(e),
                detail: 'POST /api/diagnose', onRetry: ask,
              })],
            }));
          })
          .then(function () {
            askBtn.disabled = false;
            askBtn.textContent = t('diag.submit');
          });
      }

      // ---- the causes --------------------------------------------------------
      function causeBlock(cause, verdict) {
        var head = el('div', { class: 'diag-cause-head' }, el('strong', {}, cause.title));
        if (verdict) {
          head.append(ui.badge(VERDICT_TONE[verdict.verdict] || 'warn', t('diag.verdict.' + verdict.verdict)));
          if (verdict.reason) {
            head.append(ui.metaXs(verdict.reason === 'missing_data'
              ? t('diag.reason.missing_data', { facts: (verdict.missingFacts || []).join(', ') })
              : t('diag.reason.' + verdict.reason)));
          }
        } else if (cause.confidence != null) {
          head.append(ui.metaXs(Math.round(cause.confidence * 100) + '%'));
        }

        var body = el('div', { class: 'diag-cause-body' }, el('p', {}, cause.explanation));
        if (cause.reason) body.append(ui.metaXs(cause.reason));

        // How to read the answer: the views, with what to look for in each.
        var reading = el('div', { class: 'diag-reading' }, el('h4', {}, t('diag.reading')));
        (cause.views || []).forEach(function (v) {
          reading.append(el('div', { class: 'diag-view-row' },
            ui.button('ghost', t('diag.reading.open', { view: v.view }), {
              size: 'xs', onclick: function () { deps.navigate(v, st); },
            }),
            ui.meta(v.look_for)));
        });
        body.append(reading);

        // Every rule, whether it matched, and the sentence behind it — which is
        // what makes a verdict arguable instead of asserted.
        if (verdict && (verdict.evidence || []).length) {
          var evid = el('div', { class: 'diag-evidence' }, el('h4', {}, t('diag.evidence')));
          (verdict.evidence || []).forEach(function (e) {
            var state = e.result === true ? 'fired' : e.result === false ? 'notFired' : 'unknown';
            evid.append(el('div', { class: 'diag-rule' },
              el('code', {}, e.when),
              ui.badge(RULE_TONE[state], t('diag.evidence.' + state)),
              ui.metaXs(e.because)));
          });
          body.append(evid);
        }

        // Never shown for an eliminated cause — the server already dropped
        // those, and this is the belt to that braces.
        var fixes = verdict ? verdict.fixes : (cause.fixes || []).map(function (text) {
          return { text: text, complete: true };
        });
        if (fixes && fixes.length) {
          var fixEl = el('div', { class: 'diag-fixes' }, el('h4', {}, t('diag.fixes')));
          fixes.forEach(function (f) {
            var text = typeof f === 'string' ? f : f.text;
            var complete = typeof f === 'string' ? true : f.complete;
            fixEl.append(complete
              ? el('div', { class: 'diag-fix' }, text)
              : ui.inlineNote(text, 'warn'));
          });
          body.append(fixEl);
        }
        return el('div', { class: 'diag-cause' }, head, body);
      }

      function drawPlan() {
        var plan = st.plan;
        if (!plan) { outHost.replaceChildren(); return; }
        if (!plan.causes || !plan.causes.length) {
          outHost.replaceChildren(ui.panel({
            title: t('diag.causes'),
            children: [ui.emptyState({ title: plan.message || t('diag.empty'), body: t('diag.emptyHint') })],
          }));
          return;
        }
        var ev = st.evaluation;
        // After an evaluation the server has already ordered them confirmed →
        // open → eliminated; before one, the matcher's ranking stands.
        var ordered = ev
          ? ev.causes.map(function (c) {
            return {
              cause: plan.causes.filter(function (p) { return p.id === c.playbookId; })[0],
              verdict: c,
            };
          }).filter(function (x) { return x.cause; })
          : plan.causes.map(function (cause) { return { cause: cause, verdict: null }; });

        var causesPanel = ui.panel({
          title: t('diag.causes'),
          // Which matcher produced this, said where the reader is already
          // looking for what a result is worth.
          note: plan.usedAi ? t('diag.matched.llm') : t('diag.matched.keywords'),
          children: [
            ev || (ev && ev.summary)
              ? el('div', { class: 'panel-body diag-verdicts' },
                ui.inlineNote(t('diag.counts', ev.counts), 'info'),
                ev.summary && ev.summary.text
                  ? el('div', { class: 'diag-summary' },
                    el('h4', {}, t('diag.summary')),
                    el('p', {}, ev.summary.text),
                    ui.metaXs(t('diag.summary.ai')))
                  : null)
              : null,
            el('div', { class: 'panel-body' }, ordered.map(function (o) { return causeBlock(o.cause, o.verdict); })),
          ].filter(Boolean),
        });
        outHost.replaceChildren(causesPanel, testsPanel(plan));
      }

      // ---- the tests ---------------------------------------------------------
      function testsPanel(plan) {
        if (!plan.tests || !plan.tests.length || !plan.target) {
          return ui.panel({
            title: t('diag.tests'),
            children: [ui.emptyState({ title: t('diag.tests.none'), body: t('diag.tests.noneHint') })],
          });
        }
        // The checkboxes carry the STORED row ids, which the screen learns from
        // GET /api/diagnose/:id. Those rows are inserted in plan order and read
        // back ordered by id, so index pairing is exact; without the ids the
        // server would have to be told "the third one", which is not something
        // it could verify.
        var rowIds = st.testRows ? st.testRows.map(function (r) { return r.id; }) : [];
        if (!st.testRows && !deps.isViewer()) {
          deps.fetchSession(plan.sessionId)
            .then(function (rows) { st.testRows = rows; drawPlan(); })
            .catch(function () { st.testRows = []; });
        }
        // Seeded the first time the ids actually arrive: the first render
        // happens before the fetch lands, and seeding an empty set then would
        // leave the plan permanently unselected.
        if (!st.selectedTests || (!st.selectionSeeded && rowIds.length)) {
          st.selectedTests = new Set(rowIds);
          st.selectionSeeded = rowIds.length > 0;
        }
        var selected = st.selectedTests;
        var counter = el('span', {});
        var syncCount = function () {
          counter.replaceChildren(ui.metaXs(t('diag.tests.selected', {
            n: String(selected.size), total: String(rowIds.length || plan.tests.length),
          })));
        };

        var rows = plan.tests.map(function (tst, i) {
          var params = Object.keys(tst.params || {}).map(function (k) {
            return k + '=' + JSON.stringify(tst.params[k]);
          }).join(' ');
          var rowId = rowIds[i];
          var cb = null;
          if (rowId !== undefined && !deps.isViewer()) {
            cb = el('input', { type: 'checkbox', 'aria-label': t('diag.tests.pick') });
            cb.checked = selected.has(rowId);
            cb.addEventListener('change', function () {
              if (cb.checked) selected.add(rowId); else selected.delete(rowId);
              syncCount();
            });
          }
          return {
            cells: {
              pick: cb || '',
              test: el('code', {}, tst.probeType + ' ' + tst.target + (params ? ' ' + params : '')),
              dir: tst.direction === 'reverse' ? ui.badge('info', t('diag.tests.reverse')) : ui.meta('–'),
              why: el('div', {}, el('div', {}, tst.why || ''),
                ui.metaXs(t('diag.tests.askedBy', { causes: (tst.askedBy || []).join(', ') }))),
            },
          };
        });

        var children = [ui.dataTable({
          columns: [
            { key: 'pick', label: '', width: '44px' },
            { key: 'test', label: t('diag.col.test'), width: '340px' },
            { key: 'dir', label: t('diag.col.direction'), width: '130px' },
            { key: 'why', label: t('diag.col.why') },
          ],
          rows: rows,
        })];

        if (!deps.isViewer()) {
          syncCount();
          children.push(runRow(plan, selected, rowIds, counter));
        }
        return ui.panel({ title: t('diag.tests'), note: t('diag.tests.note'), children: children });
      }

      // Rounds + Stop, for the fault that is not there while you are looking at
      // it: the same plan dispatched again and again until it reproduces.
      function runRow(plan, selected, rowIds, counter) {
        var statusHost = el('div', {});
        var roundsUnit = el('span', {});
        var roundsInput = el('input', {
          type: 'number', min: '1', max: '20', value: '1',
          class: 'run-count', 'aria-label': t('probe.rounds.prefix'),
        });
        var syncRounds = function () {
          var n = Math.max(1, Math.min(20, Number(roundsInput.value) || 1));
          roundsUnit.replaceChildren(deps.plural('probe.rounds', n, { n: String(n) }));
        };
        roundsInput.addEventListener('input', syncRounds);
        roundsInput.addEventListener('click', function (e) { e.stopPropagation(); });
        syncRounds();
        var stopRequested = false;
        var runBtn = ui.button('primary', t('diag.tests.runSelected'), { onclick: runRounds });
        var stopBtn = ui.button('ghost', t('probe.stop'), { disabled: true, onclick: function () {
          stopRequested = true;
          stopBtn.disabled = true;
          say(t('diag.tests.stopped'), 'warn');
        } });
        var repeatChipEl = el('span', {});
        var repeatBtn = ui.button('secondary', t('diag.tests.repeat'), { onclick: repeat });
        var evalBtn = ui.button('secondary', t('diag.evaluate'), { onclick: evaluate });

        function say(text, tone) {
          statusHost.replaceChildren(text ? ui.inlineNote(text, tone || null) : null);
        }

        function runRounds() {
          var ids = [];
          selected.forEach(function (id) { ids.push(id); });
          if (rowIds.length && !ids.length) { say(t('diag.tests.noneSelected'), 'warn'); return; }
          var rounds = Math.max(1, Math.min(20, Number(roundsInput.value) || 1));
          stopRequested = false;
          runBtn.disabled = true;
          stopBtn.disabled = false;
          var round = 0;
          var next = function () {
            round += 1;
            if (round > rounds || stopRequested) {
              if (stopRequested) say(t('diag.tests.stopped'), 'warn');
              stopBtn.disabled = true;
              runBtn.disabled = false;
              return Promise.resolve();
            }
            say(rounds === 1
              ? t('diag.tests.running')
              : t('diag.tests.round', { round: String(round), rounds: String(rounds) }));
            // No ids yet (the fetch has not landed) means the whole plan, which
            // is exactly what the button did before it could select.
            var body = ids.length && rowIds.length ? { testIds: ids } : {};
            return deps.runTests(plan.sessionId, body)
              .then(function (r) {
                say(t('diag.tests.dispatched', { n: r.dispatched, total: r.total }));
                if (round >= rounds || stopRequested) {
                  stopBtn.disabled = true;
                  runBtn.disabled = false;
                  if (stopRequested) say(t('diag.tests.stopped'), 'warn');
                  return null;
                }
                return new Promise(function (res) { setTimeout(res, ROUND_GAP_MS); }).then(next);
              })
              .catch(function (e) {
                say(deps.errText(e), 'crit');
                stopBtn.disabled = true;
                runBtn.disabled = false;
              });
          };
          next();
        }

        // A plan can span two agents (a reverse test runs from the far end), and
        // a test package pushes every item to every target — so this writes ONE
        // PACKAGE PER AGENT rather than one that would run each test from the
        // wrong end.
        function repeat() {
          var rows = (st.testRows || []).filter(function (r) {
            return selected.has(r.id) && r.agentId != null;
          });
          if (!rows.length) { say(t('diag.tests.noneSelected'), 'warn'); return; }
          deps.repeat(rows, st, repeatChipEl);
        }

        function evaluate() {
          evalBtn.disabled = true;
          say(t('diag.evaluating'));
          deps.evaluate(plan.sessionId)
            .then(function (res) { st.evaluation = res; say(''); drawPlan(); })
            .catch(function (e) { say(deps.errText(e), 'crit'); })
            .then(function () { evalBtn.disabled = false; });
        }

        return el('div', { class: 'diag-run' },
          ui.formActions([
            el('label', { class: 'field-inline' }, roundsInput, roundsUnit),
            runBtn, stopBtn,
          ], [repeatBtn, evalBtn]),
          el('div', { class: 'diag-run-status' }, counter, repeatChipEl, statusHost));
      }

      return deps.fetchAgents()
        .then(function (list) {
          agents = list;
          drawForm();
          deps.fetchExamples().then(drawExamples).catch(function () { /* no examples */ });
          if (st.plan) drawPlan();
          return page;
        });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.DiagnoseView = apiObj;
})(typeof window !== 'undefined' ? window : null);
