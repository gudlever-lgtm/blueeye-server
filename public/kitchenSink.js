// public/kitchenSink.js — every component, every state, on one page.
//
// /ui-kitchen-sink, admin only. Two jobs:
//   * a visual reference, so "what does an ErrorState look like" is a link
//     rather than a hunt through the codebase;
//   * a test surface — the components are rendered here in every state they
//     have, so a regression in one of them shows up on a page that is checked
//     rather than only on whichever screen happens to use it.
//
// It builds itself from public/ui.js like any migrated screen. Nothing here is
// bespoke: if a demo needs markup ui.js has not got, that is a gap in the
// contract, not a licence to hand-roll it here.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    // A labelled specimen: what it is, and the thing itself.
    function specimen(name, note, node) {
      return el('div', { class: 'ks-item' },
        el('div', { class: 'ks-label' }, name),
        note ? el('div', { class: 'ks-note' }, note) : null,
        el('div', { class: 'ks-demo' }, node));
    }
    function shelf() {
      return el('div', { class: 'ks-shelf' }, [].slice.call(arguments));
    }

    function tokensPanel() {
      var SPACE = ['--s-1', '--s-2', '--s-3', '--s-4', '--s-5', '--s-6'];
      var TYPE = ['--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl'];
      var SEV = ['--sev-crit', '--sev-warn', '--sev-info', '--sev-ok'];
      var SURFACE = ['--bg', '--surface', '--surface-alt', '--border', '--text', '--text-muted', '--accent'];
      var swatches = function (names) {
        return el('div', { class: 'ks-swatches' }, names.map(function (n) {
          return el('div', { class: 'ks-swatch' },
            el('span', { class: 'ks-chipcolor', 'data-token': n }),
            el('code', {}, n));
        }));
      };
      return ui.panel({
        title: t('ks.tokens.title'),
        note: t('ks.tokens.note'),
        children: [el('div', { class: 'panel-body' },
          specimen(t('ks.tokens.semantic'), null, swatches(SEV)),
          specimen(t('ks.tokens.surface'), null, swatches(SURFACE)),
          specimen(t('ks.tokens.spacing'), null, el('div', { class: 'ks-ruler' }, SPACE.map(function (n) {
            return el('div', { class: 'ks-rule' }, el('span', { class: 'ks-bar', 'data-token': n }), el('code', {}, n));
          }))),
          specimen(t('ks.tokens.type'), null, el('div', { class: 'ks-typelist' }, TYPE.map(function (n) {
            return el('div', { class: 'ks-typerow', 'data-token': n }, el('span', {}, t('ks.tokens.sample')), el('code', {}, n));
          }))))],
      });
    }

    function buttonsPanel() {
      return ui.panel({
        title: t('ks.buttons.title'),
        note: t('ks.buttons.note'),
        children: [el('div', { class: 'panel-body' },
          specimen('primary / secondary / ghost / danger', null, shelf(
            ui.button('primary', t('ks.buttons.primary')),
            ui.button('secondary', t('ks.buttons.secondary')),
            ui.button('ghost', t('ks.buttons.ghost')),
            ui.button('danger', t('ks.buttons.danger')))),
          specimen(t('ks.buttons.disabled'), t('ks.buttons.disabledNote'), shelf(
            ui.button('primary', t('ks.buttons.primary'), { disabled: true }),
            ui.button('secondary', t('ks.buttons.secondary'), { disabled: true }))),
          specimen(t('ks.buttons.sizes'), t('ks.buttons.sizesNote'), shelf(
            ui.button('secondary', t('ks.buttons.secondary')),
            ui.button('secondary', t('ks.buttons.small'), { size: 'xs' }),
            ui.button('ghost', '⋯', { icon: true, ariaLabel: t('ui.moreActions') }),
            ui.button('ghost', '⋯', { icon: true, size: 'xs', ariaLabel: t('ui.moreActions') }))))],
      });
    }

    function badgesPanel() {
      return ui.panel({
        title: t('ks.badges.title'),
        note: t('ks.badges.note'),
        children: [el('div', { class: 'panel-body' },
          specimen(t('ks.badges.status'), t('ks.badges.statusNote'), shelf(
            ui.badge('crit', 'CRITICAL'), ui.badge('warn', 'WARNING'), ui.badge('info', 'INFO'),
            ui.badge('ok', 'OK'), ui.badge('neutral', 'NOT SUPPORTED'))),
          specimen(t('ks.badges.meta'), t('ks.badges.metaNote'), shelf(
            ui.meta('135×'), ui.meta(t('ks.badges.anomalies')), ui.meta('Event'), ui.meta('open'))),
          specimen(t('ks.badges.host'), t('ks.badges.hostNote'),
            ui.hostLink('oslo-edge-01', function () {})))],
      });
    }

    function formPanel() {
      return ui.panel({
        title: t('ks.form.title'),
        note: t('ks.form.note'),
        children: [el('div', { class: 'panel-body' },
          ui.formSection({
            title: t('ks.form.section'),
            hint: t('ks.form.sectionHint'),
            fields: [
              ui.field({
                id: 'ks-a', label: t('ks.form.select'), hint: t('ks.form.selectHint'),
                control: ui.select({ id: 'ks-a', value: 'b', options: [['a', 'oslo-edge-01'], ['b', 'cph-core-02']] }),
              }),
              ui.field({
                id: 'ks-b', label: t('ks.form.text'), hint: t('ks.form.textHint'),
                control: el('input', { id: 'ks-b', type: 'text', value: 'api.internal.example.net' }),
              }),
              ui.field({
                id: 'ks-c', label: t('ks.form.invalid'), error: t('ks.form.invalidError'),
                control: el('input', { id: 'ks-c', type: 'text', value: '45000' }),
              }),
              ui.field({
                id: 'ks-d', label: t('ks.form.number'),
                control: el('input', { id: 'ks-d', type: 'number', value: '3', min: '1', max: '20' }),
              }),
              // Type two letters to see the list: the specimen answers from a
              // fixed set, so the component is shown without a server.
              ui.field({
                id: 'ks-e', label: t('ks.form.suggest'), hint: t('ks.form.suggestHint'),
                control: ui.suggestInput({
                  id: 'ks-e', placeholder: 'IP, MAC, hostname or agent:<id>',
                  emptyText: t('ks.form.suggestNone'),
                  suggest: function (q) {
                    var all = [
                      { value: 'agent:7', label: 'oslo-edge-01', badge: 'Agent', meta: 'agent:7 · Oslo' },
                      { value: '10.1.10.6', label: 'cph-core-02', badge: 'Switch', meta: '10.1.10.6 · Copenhagen' },
                      { value: 'aa:bb:cc:dd:ee:07', label: 'sto-branch-07', badge: 'Host', meta: 'aa:bb:cc:dd:ee:07' },
                    ];
                    var needle = String(q).toLowerCase();
                    return all.filter(function (o) {
                      return o.label.toLowerCase().indexOf(needle) !== -1 || o.value.indexOf(needle) !== -1;
                    });
                  },
                }),
              }),
            ],
          }),
          ui.formActions([ui.meta(t('ks.form.actionsLeft'))], [
            ui.button('secondary', t('ks.buttons.secondary')),
            ui.button('primary', t('ks.buttons.primary')),
          ]))],
      });
    }

    function tablePanel(state) {
      var ROWS = [
        ['12/09, 14:02', 'CRIT', 'crit', 'Probe outage', 'latency degraded at oslo-edge-01', 'oslo-edge-01', '135×'],
        ['12/09, 13:58', 'WARN', 'warn', 'Interface state', 'Gi0/2 flapping (12 transitions)', 'cph-core-02', '12×'],
        ['12/09, 11:20', 'INFO', 'info', 'Agent state', 'agent upgraded to v0.162.0', 'sto-branch-07', '—'],
      ];
      var rows = ROWS.map(function (r, i) {
        return {
          id: i,
          cells: {
            time: r[0],
            severity: ui.badge(r[2], r[1]),
            type: ui.meta(r[3]),
            title: r[4],
            host: ui.hostLink(r[5], function () {}),
            count: ui.meta(r[6]),
            actions: ui.rowActions(
              { label: t('ks.table.ack'), onclick: function () { ui.toast(t('ks.table.acked'), r[4]); } },
              [
                { label: t('ks.table.open'), onclick: function () { openDemoDrawer(r); } },
                '-',
                { label: t('ks.table.mute'), danger: true, onclick: function () {} },
              ]),
          },
        };
      });
      // The dimmed row: present, legible, plainly out of play.
      rows.push({
        id: 99, dimmed: true,
        cells: {
          time: '—', severity: ui.badge('neutral', 'NOT SUPPORTED'), type: ui.meta('—'),
          title: t('ks.table.dimmed'), host: ui.meta('—'), count: ui.meta('—'), actions: '',
        },
      });
      return ui.panel({
        title: t('ks.table.title'),
        note: t('ks.table.note'),
        actions: [ui.button('secondary', state.dense ? t('ks.table.comfortable') : t('ks.table.compact'), {
          onclick: function () { state.dense = !state.dense; state.redraw(); },
        })],
        children: [ui.dataTable({
          dense: state.dense,
          columns: [
            { key: 'time', label: t('ks.col.time'), width: '136px', sortable: true, time: true },
            { key: 'severity', label: t('ks.col.severity'), width: '108px', sortable: true },
            { key: 'type', label: t('ks.col.type'), width: '150px', sortable: true },
            { key: 'title', label: t('ks.col.title'), sortable: true },
            { key: 'host', label: t('ks.col.host'), width: '172px', sortable: true },
            { key: 'count', label: t('ks.col.count'), width: '122px', sortable: true, num: true },
            { key: 'actions', label: '', width: '104px' },
          ],
          rows: rows,
          sort: { key: 'time', dir: 'desc' },
          onSort: function () {},
          onOpen: function (row, tr) { openDemoDrawer(ROWS[row.id] || ROWS[0], tr); },
        })],
        foot: [
          el('span', {}, t('ks.showing', { shown: rows.length, total: rows.length })),
          el('div', { class: 'foot-right' },
            ui.button('secondary', '‹ ' + t('ks.prev'), { disabled: true }),
            ui.button('secondary', t('ks.next') + ' ›', { disabled: true })),
        ],
      });
    }

    function openDemoDrawer(r, tr) {
      ui.openDrawer({
        title: r[4],
        status: ui.badge(r[2], r[1]),
        meta: '12/09/2026, 14:02:33',
        row: tr,
        sections: [
          ui.drawerSection(t('ks.drawer.what'), el('p', {}, t('ks.drawer.what'))),
          ui.drawerSection(t('ks.drawer.why'), el('p', {}, t('ks.drawer.why'))),
          ui.drawerSection(t('ks.drawer.detail'), ui.keyValues([
            ['Baseline', '18.2 ms'], ['MAD', '6.7 ms'], ['Measured', '61.3 ms'],
            ['z-score', '6.4'], ['Rule', 'latency.median · crit ≥ 5.0'],
          ])),
          ui.drawerSection(t('ks.drawer.history'), ui.history([
            ['12/09, 14:02', t('ks.drawer.first')],
            ['12/09, 14:06', t('ks.drawer.rose')],
            [null, t('ks.drawer.seen', { count: 135 })],
          ])),
        ],
        footer: ui.drawerFooter(
          [ui.button('ghost', t('ks.drawer.openAnalysis'))],
          [ui.button('secondary', t('ks.drawer.mute')), ui.button('primary', t('ks.table.ack'))]),
      });
    }

    function statesPanel() {
      return ui.panel({
        title: t('ks.states.title'),
        note: t('ks.states.note'),
        children: [el('div', { class: 'panel-body' },
          specimen('EmptyState', null, ui.emptyState({
            title: t('ks.states.emptyTitle'), body: t('ks.states.emptyBody'),
            action: ui.button('secondary', t('ks.states.emptyAction')),
          })),
          specimen('LoadingState', t('ks.states.loadingNote'), ui.loadingState(3)),
          specimen('ErrorState', null, ui.errorState({
            detail: 'GET /api/changes?window=7d',
            onRetry: function () { ui.toast(t('ks.states.retried')); },
          })),
          specimen('inlineNote', t('ks.states.noteNote'), el('div', {},
            ui.inlineNote(t('ks.states.inline')),
            ui.inlineNote('⚠ ' + t('ks.states.inlineWarn'), 'warn'))))],
      });
    }

    function overlaysPanel() {
      return ui.panel({
        title: t('ks.overlays.title'),
        note: t('ks.overlays.note'),
        children: [el('div', { class: 'panel-body' }, shelf(
          ui.button('secondary', t('ks.overlays.drawer'), {
            onclick: function () {
              openDemoDrawer(['', 'CRITICAL', 'crit', '', 'Latency tripled at oslo-edge-01']);
            },
          }),
          ui.button('secondary', t('ks.overlays.toastOk'), {
            onclick: function () { ui.toast(t('ks.overlays.toastOkTitle'), t('ks.overlays.toastOkBody')); },
          }),
          ui.button('secondary', t('ks.overlays.toastErr'), {
            onclick: function () { ui.toast(t('ks.overlays.toastErrTitle'), t('ks.overlays.toastErrBody'), { bad: true }); },
          })))],
      });
    }

    function chartsPanel() {
      var bars = [
        { label: 'passed', points: [{ y: 3 }, { y: 5 }, { y: 4 }, { y: 6 }, { y: 2 }] },
        { label: 'failed', points: [{ y: 1 }, { y: 0 }, { y: 2 }, { y: 0 }, { y: 1 }] },
      ];
      var line = [{
        label: 'rtt (ms)',
        points: Array.from({ length: 48 }, function (_, i) {
          return { y: 18 + Math.round(9 * Math.sin(i / 5) + (i > 30 ? 40 : 0)) };
        }),
      }];
      var labels5 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
      return ui.panelGrid(
        ui.panel({
          title: t('ks.chart.bars'), note: t('ks.chart.barsNote'),
          children: [el('div', { class: 'panel-body' }, ui.chart({ series: bars, labels: labels5, height: 220 }))],
        }),
        ui.panel({
          title: t('ks.chart.line'), note: t('ks.chart.lineNote'),
          children: [el('div', { class: 'panel-body' }, ui.chart({ series: line, height: 220 }))],
        }),
        ui.panel({
          title: t('ks.chart.tiny'), note: t('ks.chart.tinyNote'),
          children: [el('div', { class: 'panel-body' }, ui.chart({
            series: [{ label: 'incidents', points: [{ y: 1 }, { y: 0 }, { y: 1 }] }],
            labels: ['Aug', 'Sep', 'Oct'], height: 200,
          }))],
        }),
        ui.panel({
          title: t('ks.chart.empty'), note: t('ks.chart.emptyNote'),
          children: [el('div', { class: 'panel-body' }, ui.chart({ series: [] }))],
        }));
    }

    function timePanel() {
      var iso = '2026-09-12T14:02:33.000Z';
      return ui.panel({
        title: t('ks.time.title'), note: t('ks.time.note'),
        children: [el('div', { class: 'panel-body' }, ui.keyValues([
          ['fmt.abs', ui.fmt.abs(iso)],
          ['fmt.short', ui.fmt.short(iso)],
          ['fmt.clock', ui.fmt.clock(iso)],
          ['fmt.rel', ui.fmt.rel(new Date(Date.now() - 4 * 60000).toISOString())],
          ['fmt.duration', ui.fmt.duration(740) + ' · ' + ui.fmt.duration(1400) + ' · ' + ui.fmt.duration(90000)],
          [t('ks.time.missing'), ui.fmt.abs(null)],
        ]))],
      });
    }

    var SECTIONS = [
      ['tokens', tokensPanel],
      ['buttons', buttonsPanel],
      ['badges', badgesPanel],
      ['table', tablePanel],
      ['form', formPanel],
      ['states', statesPanel],
      ['overlays', overlaysPanel],
      ['charts', chartsPanel],
      ['time', timePanel],
    ];

    function view() {
      var state = { tab: 'tokens', dense: false, redraw: null };
      var root = ui.page();
      var body = el('div', {});

      root.append(ui.pageHeader({
        title: t('ks.title'),
        lead: t('ks.lead'),
        help: {
          title: t('ks.title'),
          body: function () {
            return [el('p', {}, t('ks.help.p1')), el('p', {}, t('ks.help.p2'))];
          },
        },
      }));
      root.append(ui.tabs(SECTIONS.map(function (s) {
        var key = 'ks.tab.' + s[0];
        var label = t(key);
        return [s[0], label === key ? s[0] : label];
      }), {
        active: state.tab,
        ariaLabel: t('ks.title'),
        onPick: function (key) { state.tab = key; draw(); },
      }));
      root.append(body);

      function draw() {
        var hit = SECTIONS.filter(function (s) { return s[0] === state.tab; })[0] || SECTIONS[0];
        body.replaceChildren(hit[1](state));
      }
      state.redraw = draw;
      draw();
      return Promise.resolve(root);
    }

    return { view: view, SECTIONS: SECTIONS.map(function (s) { return s[0]; }) };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.KitchenSink = apiObj;
})(typeof window !== 'undefined' ? window : null);
