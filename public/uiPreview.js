// public/uiPreview.js — the two UI-contract example screens.
//
// Phase 1 of the UI unification (docs/ui-contract.md): Changes rebuilt as a
// ListPage (template A) and Probes & Tests as a FormPage (template C), on
// /ui-preview/changes and /ui-preview/probes, admin only. The live screens are
// untouched — these exist so the direction can be seen and approved before the
// rest of the codebase is migrated, and they are DELETED once Changes and
// Probes move onto their real routes.
//
// Both read the real APIs (/api/changes, /agents, /api/connection-test/checks),
// so what is on screen is this server's own data.
//
// Repo convention: createX(deps). app.js passes its own helpers in rather than
// this file reaching into app.js's scope.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var api = deps.api;
    var t = deps.t;
    var plural = deps.plural;
    var errText = deps.errText;
    var openAgent = deps.openAgent;
    // Every component comes from public/ui.js — this module is two PAGES, not a
    // second component library. That is the point of the exercise: a screen is
    // a composition, and anything it needs that ui.js has not got is a gap in
    // the contract rather than something to hand-roll here.
    var ui = deps.ui;
    var SEV_TONE = { CRIT: 'crit', WARN: 'warn', INFO: 'info' };
    var SEV_ORDER = { CRIT: 3, WARN: 2, INFO: 1 };
    // A key built from data is resolved through a variable, never concatenated
    // inside the translate call: the gate sweeps the source for literal keys,
    // and a concatenation reads to it as a truncated key it cannot verify.
    function severityLabel(sev) { var k = 'changes.group.' + sev; var v = t(k); return v === k ? String(sev) : v; }
    function kindLabel(kind) { var k = 'changes.kind.' + kind; var v = t(k); return v === k ? String(kind || '\u2014') : v; }
    function tabLabel(key) { var k = 'route.tab.probes.' + key; var v = t(k); return v === k ? key : v; }

    // ---- Example 1 · Changes as a ListPage (template A) ---------------------

    function changesView() {
      var root = ui.page();
      var state = {
        window: '7d',
        severity: '',
        host: '',
        sort: { key: 'time', dir: 'desc' },
        forced: new URLSearchParams(window.location.search).get('state') || '',
      };
      var names = {};
      var body = el('div', {});
      var stripHost = el('div', {});

      var markSeen = ui.button('primary', t('changes.markSeen'), {
        onclick: function () {
          markSeen.disabled = true;
          api('/api/changes/seen', { method: 'POST', body: {} })
            .then(function () { ui.toast(t('changes.marked'), t('uip.markedDetail')); return load(); })
            .catch(function (e) { ui.toast(t('changes.title'), errText(e), { bad: true }); })
            .then(function () { markSeen.disabled = false; });
        },
      });

      root.append(ui.pageHeader({
        title: t('changes.title'),
        lead: t('changes.subtitle'),
        help: {
          title: t('uip.help.changes.title'),
          body: function () {
            return [
              el('p', {}, t('uip.help.changes.p1')),
              el('p', {}, t('uip.help.changes.p2')),
              el('p', {}, t('uip.help.changes.p3')),
            ];
          },
        },
        // One primary. "Fleet grid" is a way out of the page, so it is secondary.
        actions: [
          ui.button('secondary', t('changes.fleetLink'), { onclick: function () { deps.gotoView('fleet'); } }),
          markSeen,
        ],
      }), stripHost, body);

      function toolbar(onChange) {
        return ui.toolbar({
          filters: [
            ui.filter(t('changes.window'), ui.select({
              label: t('changes.window'), value: state.window, options: ['24h', '7d', '30d'],
              onchange: function (e) { state.window = e.target.value; load(); },
            })),
            ui.filter(t('uip.filter.severity'), ui.select({
              label: t('uip.filter.severity'), value: state.severity,
              options: [['', t('uip.filter.all')], ['CRIT', t('changes.group.CRIT')],
                ['WARN', t('changes.group.WARN')], ['INFO', t('changes.group.INFO')]],
              onchange: function (e) { state.severity = e.target.value; onChange(); },
            })),
            ui.filter(t('uip.filter.host'), el('input', {
              type: 'search', value: state.host, placeholder: t('uip.filter.hostPlaceholder'),
              'aria-label': t('uip.filter.host'), size: '16',
              oninput: function (e) { state.host = e.target.value; onChange(); },
            })),
          ],
          actions: [
            ui.button('secondary', t('uip.export'), {
              onclick: function () { ui.toast(t('uip.exportQueued'), t('uip.exportDetail')); },
            }),
          ],
        });
      }

      function hostName(id) { return names[id] || (t('uip.agentN', { id: id })); }

      function openRowDrawer(ev, tr) {
        var tone = SEV_TONE[ev.severity] || 'info';
        var indicationKey = 'changes.indicates.' + ev.family;
        var indication = ev.family ? t(indicationKey) : '';
        var sections = [
          ui.drawerSection(t('uip.drawer.what'), el('p', {}, ev.summary)),
          indication && indication !== indicationKey
            ? ui.drawerSection(t('uip.drawer.why'), el('p', {}, indication)) : null,
          ui.drawerSection(t('uip.drawer.detail'), ui.keyValues([
            [t('uip.drawer.source'), ev.source || '—'],
            [t('uip.drawer.type'), ev.type || '—'],
            [t('uip.drawer.metric'), ev.metric || '—'],
            [t('uip.drawer.host'), ev.agentId == null ? '—' : hostName(ev.agentId)],
          ])),
          ui.drawerSection(t('uip.drawer.history'), ui.history([
            [ui.fmt.short(ev.firstAt || ev.timestamp), t('uip.drawer.first')],
            [ui.fmt.short(ev.timestamp), t('uip.drawer.last')],
            [null, t('uip.drawer.seen', { count: Number(ev.count) || 1 })],
          ])),
        ];
        ui.openDrawer({
          title: ev.summary,
          status: ui.badge(tone, severityLabel(ev.severity)),
          meta: ui.fmt.abs(ev.timestamp),
          row: tr,
          sections: sections.filter(Boolean),
          footer: ev.agentId == null ? null : ui.drawerFooter([], [
            ui.button('primary', t('uip.drawer.openHost'), {
              onclick: function () { ui.closeDrawer(); openAgent(Number(ev.agentId)); },
            }),
          ]),
        });
      }

      function table(events) {
        var rows = events.map(function (ev) {
          var count = Number(ev.count) || 1;
          return {
            ev: ev,
            cells: {
              time: ui.fmt.short(ev.timestamp),
              severity: ui.badge(SEV_TONE[ev.severity] || 'info', String(ev.severity || '')),
              type: ui.meta(kindLabel(ev.kind)),
              title: ev.summary,
              // Host is a link in its own column, never a chip on the title.
              host: ev.agentId == null ? ui.meta('—')
                : ui.hostLink(hostName(ev.agentId), function () { openAgent(Number(ev.agentId)); }),
              // Metadata as muted text, not a chip.
              count: ui.meta(count > 1 ? count + '×' : '—'),
              actions: ui.rowActions(
                { label: t('uip.act.ack'), onclick: function () { ui.toast(t('uip.act.acked'), ev.summary); } },
                [
                  { label: t('uip.act.open'), onclick: function () { openRowDrawer(ev, null); } },
                  ev.agentId == null ? null : { label: t('uip.act.host'), onclick: function () { openAgent(Number(ev.agentId)); } },
                  '-',
                  { label: t('uip.act.mute'), danger: true, onclick: function () { ui.toast(t('uip.act.muted'), ev.summary); } },
                ].filter(Boolean)),
            },
          };
        });
        return ui.dataTable({
          columns: [
            { key: 'time', label: t('uip.col.time'), width: '136px', sortable: true, time: true },
            { key: 'severity', label: t('uip.col.severity'), width: '108px', sortable: true },
            { key: 'type', label: t('uip.col.type'), width: '150px', sortable: true },
            { key: 'title', label: t('uip.col.title'), sortable: true },
            { key: 'host', label: t('uip.col.host'), width: '172px', sortable: true },
            { key: 'count', label: t('uip.col.count'), width: '122px', sortable: true, num: true },
            { key: 'actions', label: '', width: '104px' },
          ],
          rows: rows,
          sort: state.sort,
          onSort: function (key) {
            state.sort = state.sort.key === key
              ? { key: key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
              : { key: key, dir: 'desc' };
            draw();
          },
          onOpen: function (row, tr) { openRowDrawer(row.ev, tr); },
        });
      }

      var data = null;

      function visible() {
        var out = (data.events || []).filter(function (ev) {
          if (state.severity && ev.severity !== state.severity) return false;
          if (state.host) {
            var n = ev.agentId == null ? '' : hostName(ev.agentId);
            if (n.toLowerCase().indexOf(state.host.toLowerCase()) < 0) return false;
          }
          return true;
        });
        var dir = state.sort.dir === 'asc' ? 1 : -1;
        var key = state.sort.key;
        return out.sort(function (a, b) {
          var av, bv;
          if (key === 'severity') { av = SEV_ORDER[a.severity] || 0; bv = SEV_ORDER[b.severity] || 0; }
          else if (key === 'count') { av = Number(a.count) || 1; bv = Number(b.count) || 1; }
          else if (key === 'host') { av = a.agentId == null ? '' : hostName(a.agentId); bv = b.agentId == null ? '' : hostName(b.agentId); }
          else if (key === 'type') { av = a.kind || ''; bv = b.kind || ''; }
          else if (key === 'title') { av = a.summary || ''; bv = b.summary || ''; }
          else { av = a.timestamp || ''; bv = b.timestamp || ''; }
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        });
      }

      function draw() {
        var counts = { CRIT: 0, WARN: 0, INFO: 0 };
        (data.events || []).forEach(function (ev) { if (counts[ev.severity] !== undefined) counts[ev.severity]++; });
        var pick = function (sev) {
          return function () { state.severity = state.severity === sev ? '' : sev; draw(); };
        };
        stripHost.replaceChildren(ui.statStrip([
          { value: counts.CRIT, label: t('changes.group.CRIT'), tone: 'crit', active: state.severity === 'CRIT', onclick: pick('CRIT') },
          { value: counts.WARN, label: t('changes.group.WARN'), tone: 'warn', active: state.severity === 'WARN', onclick: pick('WARN') },
          { value: counts.INFO, label: t('changes.group.INFO'), tone: 'info', active: state.severity === 'INFO', onclick: pick('INFO') },
          { value: (data.events || []).length, label: t('uip.total'), active: state.severity === '', onclick: function () { state.severity = ''; draw(); } },
        ]));

        var rows = visible();
        var kids = [toolbar(draw)];
        kids.push(ui.inlineNote(t('changes.since', { when: ui.fmt.abs(data.since) })
          + (data.correlated > 0 ? ' · ' + t('changes.correlated', { rows: data.total, raw: data.rawTotal }) : '')));
        // A partial result is a fact about the DATA, so it sits above the table
        // as an inline note — never a banner, never hidden behind the (?).
        if (data.partial && (data.failedSources || []).length) {
          kids.push(ui.inlineNote('⚠ ' + t('changes.partial', { sources: data.failedSources.join(', ') }), 'warn'));
        }
        kids.push(ui.panel({
          title: t('uip.panel.changes'),
          note: t('uip.rowCount', { n: rows.length }),
          children: [
            rows.length ? table(rows) : ui.emptyState({
              title: t('changes.empty', { when: ui.fmt.abs(data.since) }),
              body: t('changes.emptyHint'),
              action: state.severity || state.host
                ? ui.button('secondary', t('uip.clearFilters'), {
                  onclick: function () { state.severity = ''; state.host = ''; draw(); },
                })
                : null,
            }),
          ],
          foot: rows.length ? [
            el('span', {}, t('uip.showing', { shown: rows.length, total: (data.events || []).length })),
            el('div', { class: 'foot-right' },
              ui.button('secondary', '‹ ' + t('uip.prev'), { disabled: true }),
              ui.button('secondary', t('uip.next') + ' ›', { disabled: true })),
          ] : null,
        }));
        body.replaceChildren.apply(body, kids);
      }

      function load() {
        ui.closeDrawer();
        body.replaceChildren(ui.panel({ title: t('uip.panel.changes'), children: [ui.loadingState(6)] }));
        stripHost.replaceChildren();
        // The two states a live server rarely produces on demand. Reachable as
        // ?state=empty / ?state=error so both can be reviewed without waiting
        // for the server to have a bad day.
        if (state.forced === 'empty') {
          data = { since: new Date().toISOString(), events: [], total: 0, rawTotal: 0, correlated: 0 };
          draw();
          return Promise.resolve();
        }
        if (state.forced === 'error') {
          body.replaceChildren(ui.panel({
            title: t('uip.panel.changes'),
            children: [ui.errorState({
              title: t('uip.err.title'),
              body: t('uip.err.body'),
              detail: 'GET /api/changes?window=' + state.window,
              onRetry: function () { state.forced = ''; load(); },
            })],
          }));
          return Promise.resolve();
        }
        return api('/api/changes?window=' + encodeURIComponent(state.window))
          .then(function (d) { data = d; draw(); })
          .catch(function (e) {
            body.replaceChildren(ui.panel({
              title: t('uip.panel.changes'),
              children: [ui.errorState({
                title: t('uip.err.title'),
                body: errText(e),
                detail: 'GET /api/changes?window=' + state.window,
                onRetry: load,
              })],
            }));
          });
      }

      return api('/agents')
        .catch(function () { return []; })
        .then(function (agents) {
          (agents || []).forEach(function (a) { names[a.id] = a.display_name || a.hostname || t('uip.agentN', { id: a.id }); });
          return load();
        })
        .then(function () { return root; });
    }

    // ---- Example 2 · Probes & Tests as a FormPage (template C) --------------

    function probesView() {
      var root = ui.page();
      var tab = new URLSearchParams(window.location.search).get('tab') || 'connection';
      var body = el('div', {});

      root.append(ui.pageHeader({
        title: t('uip.probes.title'),
        lead: t('uip.probes.lead'),
        help: {
          title: t('uip.probes.title'),
          body: function () {
            return [
              el('p', {}, t('uip.help.probes.p1')),
              el('p', {}, t('uip.help.probes.p2')),
              el('p', {}, t('uip.help.probes.p3')),
            ];
          },
        },
      }));
      root.append(ui.tabs(
        [['run', tabLabel('run')], ['connection', tabLabel('connection')], ['packages', tabLabel('packages')]],
        {
          active: tab,
          ariaLabel: t('uip.probes.title'),
          onPick: function (key) {
            tab = key;
            var qs = key === 'connection' ? '' : ('?tab=' + key);
            try { window.history.replaceState(null, '', window.location.pathname + qs); } catch (e) { /* URL API off */ }
            render();
          },
        }));
      root.append(body);

      function notInPreview() {
        return ui.panel({
          title: tabLabel(tab),
          children: [ui.emptyState({
            icon: '⚑',
            title: t('uip.probes.notInPreview'),
            body: t('uip.probes.notInPreviewBody'),
          })],
        });
      }

      function checkLabel(c) {
        var checkKey = 'ct.check.' + c.id;
        var base = t(checkKey);
        if (base === checkKey) base = c.id;
        return c.port ? base + ' ' + c.port : base;
      }

      function render() {
        if (tab !== 'connection') { body.replaceChildren(notInPreview()); return Promise.resolve(); }
        body.replaceChildren(ui.panel({ title: t('ct.title'), children: [ui.loadingState(4)] }));
        return Promise.all([
          api('/agents').catch(function () { return []; }),
          api('/api/connection-test/checks').catch(function () { return null; }),
        ]).then(function (res) {
          var agents = res[0] || [];
          var cat = res[1];
          if (!cat) {
            body.replaceChildren(ui.panel({
              title: t('ct.title'),
              children: [ui.errorState({
                title: t('uip.err.title'),
                body: t('uip.err.body'),
                detail: 'GET /api/connection-test/checks',
                onRetry: render,
              })],
            }));
            return;
          }
          if (!agents.length) {
            body.replaceChildren(ui.panel({
              title: t('ct.title'),
              children: [ui.emptyState({ icon: '◎', title: t('ct.noAgents'), body: t('uip.probes.enrolFirst') })],
            }));
            return;
          }
          var checks = cat.checks || [];
          var rounds = 3;

          var agentSel = el('select', { id: 'uip-agent' }, agents.map(function (a) {
            return el('option', { value: String(a.id) }, a.display_name || a.hostname || t('uip.agentN', { id: a.id }));
          }));
          var targetInput = el('input', { id: 'uip-target', type: 'text', value: '', placeholder: t('ct.targetPlaceholder') });
          var targetErr = el('span', { class: 'field-error' });
          var countInput = el('input', {
            id: 'uip-count', type: 'number', min: '1', max: '20', value: String(rounds),
            // The button says how many rounds it will run, so it follows the
            // field. A Run that keeps saying "3" while the box reads 7 is the
            // kind of small lie that costs somebody a debugging session.
            oninput: function (e) {
              var n = Math.max(1, Math.min(20, Number(e.target.value) || 1));
              runBtn.textContent = t('ct.run.prefix') + ' ' + n + ' ' + plural('ct.run.suffix', n);
            },
          });

          var stopBtn = ui.button('secondary', t('ct.stop'), { disabled: true });
          var runBtn = ui.button('primary', t('ct.run.prefix') + ' ' + rounds + ' ' + plural('ct.run.suffix', rounds), {
            onclick: function () {
              var target = targetInput.value.trim();
              if (!target) {
                targetInput.setAttribute('aria-invalid', 'true');
                targetErr.textContent = t('uip.probes.targetRequired');
                targetInput.focus();
                return;
              }
              targetInput.removeAttribute('aria-invalid');
              targetErr.textContent = '';
              var n = Number(countInput.value) || 1;
              ui.toast(t('uip.probes.queued'), t('uip.probes.queuedDetail', {
                target: target, n: n, agent: agentSel.options[agentSel.selectedIndex].text,
              }));
              ui.toast(t('uip.probes.previewOnly'), t('uip.probes.previewOnlyDetail'), { bad: true });
            },
          });

          var form = ui.panel({
            title: t('ct.title'),
            children: [el('div', { class: 'panel-body' },
              ui.formSection({
                title: t('uip.probes.sec.where'),
                hint: t('uip.probes.sec.whereHint'),
                fields: [
                  ui.field({
                    id: 'uip-agent', label: t('ct.agent'), control: agentSel,
                    hint: t('uip.probes.agentHint'),
                  }),
                  ui.field({
                    id: 'uip-target', label: t('ct.target'), control: targetInput,
                    hint: t('uip.probes.targetHint'), errorNode: targetErr,
                  }),
                ],
              }),
              ui.formActions([ui.meta(t('ct.defaultOn'))], [
                el('label', { class: 'count-field', for: 'uip-count' }, t('uip.probes.rounds'), countInput),
                ui.button('secondary', t('ct.repeat')),
                stopBtn,
                runBtn,
              ]))],
          });

          // The catalogue as the server serves it: a check the agent cannot run
          // is dimmed with the reason, from the start, rather than hidden.
          var rows = checks.map(function (c) {
            var supported = c.available !== false;
            var applies = c.applies !== false;
            var tone = supported && applies ? 'ok' : 'neutral';
            var label = supported ? (applies ? t('ct.state.ok') : t('ct.reason.notApplicable')) : t('ct.reason.notSupported');
            var descKey = 'ct.check.' + c.id + '.desc';
            var desc = t(descKey);
            if (desc === descKey) desc = '';
            var reason = supported
              ? (applies ? desc : t('ct.why.notApplicable'))
              : t('ct.why.notSupported');
            return {
              dimmed: !(supported && applies),
              cells: {
                check: checkLabel(c),
                status: ui.badge(tone, label.toUpperCase()),
                result: ui.meta(reason),
                duration: ui.meta('—'),
              },
            };
          });

          var runnable = rows.filter(function (r) { return !r.dimmed; }).length;
          var results = ui.panel({
            title: t('uip.probes.resultTitle'),
            note: t('ct.resultsNote'),
            children: [
              ui.dataTable({
                columns: [
                  { key: 'check', label: t('uip.probes.col.check'), width: '210px', sortable: true },
                  { key: 'status', label: t('uip.probes.col.status'), width: '150px', sortable: true },
                  { key: 'result', label: t('uip.probes.col.result') },
                  { key: 'duration', label: t('uip.probes.col.duration'), width: '120px', num: true, sortable: true },
                ],
                rows: rows,
                // The catalogue has one honest order — the server's — so the
                // header does not offer a sort it would have to invent.
                sort: null,
              }),
            ],
            foot: [el('span', {}, t('uip.probes.summary', {
              total: rows.length, runnable: runnable, blocked: rows.length - runnable,
            }))],
          });

          body.replaceChildren(form, results);
        });
      }

      return render().then(function () { return root; });
    }

    return {
      changes: changesView,
      probes: probesView,
      closeOverlays: ui.closeOverlays,
    };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.UiPreview = apiObj;
})(typeof window !== 'undefined' ? window : null);
