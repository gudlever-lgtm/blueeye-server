// public/views/interfaces.js — Interfaces, as a ListPage (template A).
//
// Health per interface on one agent: link, utilisation, throughput, errors and
// discards, worst first. Built from the contract's components (public/ui.js,
// docs/ui-contract.md).
//
// What this migration changes:
//   * `.history-controls` — a loose label, a Refresh and a status span in one
//     flex line — is a Toolbar, with Refresh where every other screen puts it;
//   * the status chip was `.badge online|warn|error|down|grace` reading OK /
//     WARN / ERR / DOWN / IDLE — a fifth vocabulary for severity. It is a
//     contract Badge on the app's tones;
//   * `source: proc · measured 14:02` was a grey span at the end of the control
//     row. It is the panel's note, beside the table it describes;
//   * the two empty states were `.empty` divs with a paragraph in them. The one
//     that matters — an agent on a flow source, which can never fill this table
//     — keeps every word of its explanation, because it is the difference
//     between "wait" and "this will never work, here is what to change";
//   * a failed read replaced the table with a bare red line. It is an ErrorState
//     naming the call, with a Retry.
//
// The table is exported as well as drawn: the agent detail page renders the same
// interfaces, and two copies of this table would drift.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    // Worst first: down, then bad, then warn, then ok — and within a rank, the
    // busiest port first, because a saturated link is the one being asked about.
    var RANK = { down: 0, bad: 1, warn: 2, ok: 3 };
    var TONE = { ok: 'ok', warn: 'warn', bad: 'crit', down: 'crit' };

    // A virtual or idle port with the link down is not a fault, and it used to
    // sort to the very top — docker0 and a handful of veths above the port that
    // is actually dropping frames. It reads IDLE, so it ranks below OK too.
    function rankOf(i) { return (i && i.virtual && i.linkDown) ? 4 : RANK[i.status]; }

    function statusBadge(i) {
      // A virtual or idle port that is merely down (docker0, veth…, a VPN
      // tunnel) is not a fault, so it reads IDLE in neutral rather than DOWN in
      // red.
      if (i && i.virtual && i.linkDown) {
        return el('span', { title: t('iface.idleHint') }, ui.badge('neutral', t('iface.st.idle')));
      }
      var s = i && i.status;
      var key = 'iface.st.' + s;
      var label = t(key);
      return ui.badge(TONE[s] || 'neutral', label === key ? String(s || '–') : label);
    }

    function linkText(i) {
      if (!i.speedMbps && !i.operStatus && !i.duplex) return '–';
      var sp = i.speedMbps ? (i.speedMbps >= 1000 ? (i.speedMbps / 1000) + ' Gb/s' : i.speedMbps + ' Mb/s') : '';
      // The negotiated duplex (agent proc source). "unknown" says nothing a
      // reader can use, so only full/half are shown.
      var dx = i.duplex === 'full' || i.duplex === 'half' ? t('iface.duplex.' + i.duplex) : '';
      return [sp, dx, i.operStatus].filter(Boolean).join(' · ');
    }

    // WHICH fault it is, under the badge — "bad" alone sends somebody to the
    // cable when the fix is the port's duplex setting. Codes come from
    // src/health/interfaceHealth.js reasonsOf.
    function statusCell(i) {
      var reasons = Array.isArray(i && i.reasons) ? i.reasons : [];
      if (!reasons.length) return statusBadge(i);
      var lines = reasons.map(function (r) {
        var key = 'iface.reason.' + r;
        var label = t(key);
        return ui.metaXs(label === key ? r : label);
      });
      return el.apply(null, ['div', {}, statusBadge(i)].concat(lines));
    }

    // The empty case is two different answers. A flow source (sflow/netflow)
    // reports sampled conversations, not per-interface counters, so this table
    // is ALWAYS empty for it however healthy Diagnose looks — saying "no data
    // yet" there would send the reader to update an agent that is working.
    function emptyFor(source) {
      if (source === 'sflow' || source === 'netflow') {
        return ui.emptyState({
          icon: '◎',
          title: t('iface.flowSource.title', { source: source }),
          body: el('span', {},
            t('iface.flowSource.p1'),
            ' ', el('b', {}, 'proc'), ' ', t('common.or'), ' ', el('b', {}, 'snmp'), ' ',
            t('iface.flowSource.p2'),
            ' ', deps.viewLink('overview', t('nav.view.overview')), ', ',
            deps.viewLink('flows', t('nav.view.flows')), ' ', t('common.and'), ' ',
            deps.viewLink('geo', t('nav.view.geo')), '.'),
          action: deps.openAgents
            ? ui.button('secondary', t('iface.flowSource.go'), { onclick: deps.openAgents })
            : null,
        });
      }
      return ui.emptyState({ title: t('iface.none'), body: t('iface.noneHint') });
    }

    // Shared with the agent detail page — two copies of this table would drift.
    function table(interfaces, source) {
      var list = (interfaces || []).slice().sort(function (a, b) {
        return (rankOf(a) - rankOf(b))
          || ((b.rxBytesPerSec + b.txBytesPerSec) - (a.rxBytesPerSec + a.txBytesPerSec));
      });
      if (!list.length) return emptyFor(source);
      return ui.dataTable({
        columns: [
          { key: 'iface', label: t('iface.col.iface'), width: '150px' },
          { key: 'status', label: t('iface.col.status'), width: '96px' },
          // The link is the one column that can give: everything else is a bar
          // or a right-aligned number that clips the moment it is squeezed.
          { key: 'link', label: t('iface.col.link') },
          { key: 'util', label: t('iface.col.util'), width: '172px' },
          { key: 'rx', label: t('iface.col.rx'), width: '108px', num: true },
          { key: 'tx', label: t('iface.col.tx'), width: '108px', num: true },
          { key: 'err', label: t('iface.col.err'), width: '96px', num: true },
          // "Discards/s" is the longest header on the row; at 110px it clipped.
          { key: 'drop', label: t('iface.col.drop'), width: '128px', num: true },
        ],
        rows: list.map(function (i) {
          return {
            cells: {
              iface: i.iface,
              status: statusCell(i),
              link: ui.meta(linkText(i)),
              util: i.utilPct != null
                ? el('div', { class: 'util' }, deps.usageBar(i.utilPct), ui.metaXs(i.utilPct + '%'))
                : ui.meta('–'),
              rx: deps.fmtBytes(i.rxBytesPerSec) + '/s',
              tx: deps.fmtBytes(i.txBytesPerSec) + '/s',
              // A port dropping frames is the reason this screen exists, so the
              // number carries the tone rather than sitting grey beside a badge.
              err: el('span', { class: i.errPerSec > 0 ? 'num-crit' : null }, String(i.errPerSec)),
              drop: el('span', { class: i.dropPerSec > 0 ? 'num-warn' : null }, String(i.dropPerSec)),
            },
          };
        }),
      });
    }

    // ---------------------------------------------------------- forecast
    //
    // "When does this link run out of room?" — the projection lives beside the
    // table that shows where each link is NOW, because the two answer the same
    // question at different distances. A link at 40% and climbing five points a
    // day is the one to act on, and nothing on the current-state table can say
    // that.
    //
    // Only links that produced a usable projection are listed. A port with two
    // days of history, or one whose speed the agent cannot read, is left out
    // rather than shown with an empty row — the panel's own empty state says
    // why nothing is there.
    var DIR_TONE = { rising: 'warn', falling: 'ok', flat: 'neutral' };

    function daysCell(f) {
      if (!f.ok) return ui.meta(t('fc.tooLittle'));
      if (f.daysUntilCapacity == null) return ui.meta(t('fc.never'));
      var n = Math.round(f.daysUntilCapacity);
      // A link that fills inside a fortnight is the reason to look at this
      // panel at all, so it carries the tone rather than reading as grey text.
      var tone = n <= 14 ? 'crit' : n <= 60 ? 'warn' : 'neutral';
      return ui.badge(tone, t('fc.days', { n: n }));
    }

    function forecastTable(list) {
      var horizon = (list[0] && list[0].horizonDays) || 30;
      return ui.dataTable({
        columns: [
          { key: 'iface', label: t('fc.col.iface'), width: '150px' },
          { key: 'trend', label: t('fc.col.trend'), width: '150px' },
          { key: 'now', label: t('fc.col.now'), width: '96px', num: true },
          { key: 'projected', label: t('fc.col.projected', { days: horizon }), width: '110px', num: true },
          { key: 'until', label: t('fc.col.until'), width: '150px' },
          { key: 'why', label: '' },
        ],
        rows: list.map(function (f) {
          var pct = function (n) { return n == null ? '–' : Math.round(n) + '%'; };
          return {
            cells: {
              iface: f.iface,
              trend: f.ok
                ? el('span', {},
                  ui.badge(DIR_TONE[f.direction] || 'neutral', t('fc.dir.' + f.direction)),
                  ' ',
                  ui.metaXs(t('fc.perDay', { n: (f.slopePerDay > 0 ? '+' : '') + Math.round(f.slopePerDay * 10) / 10 + '%' })))
                : ui.meta('–'),
              now: f.ok ? pct(f.current) : '–',
              projected: f.ok ? pct(f.projected) : '–',
              until: daysCell(f),
              // The engine already writes a plain-language explanation carrying
              // its own evidence; showing it beats paraphrasing it here.
              why: ui.metaXs(f.explanation || ''),
            },
          };
        }),
      });
    }

    function view() {
      var state = deps.state;
      var page = ui.page();
      var barHost = el('div', {});
      var tableHost = el('div', {});
      var forecastHost = el('div', {});
      var agents = [];

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('iface.title'),
        lead: t('iface.lead'),
        help: { title: info.title, body: info.body },
      }), barHost, tableHost, forecastHost);

      function drawBar() {
        var sel = ui.select({
          label: t('iface.agent'),
          value: state.agentId,
          options: agents.map(function (a) { return [String(a.id), a.display_name || a.hostname]; }),
          onchange: function (e) { state.agentId = e.target.value; load(); loadForecast(); },
        });
        barHost.replaceChildren(ui.toolbar({
          filters: [ui.filter(t('iface.agent'), sel)],
          actions: [ui.button('secondary', t('iface.refresh'), { onclick: function () { load(); loadForecast(); } })],
        }));
      }

      // The forecast is a SEPARATE read from the 5-second table poll: it reads
      // two weeks of history, and re-running that every five seconds would be
      // an expensive answer to a question whose answer moves in days. It loads
      // when the agent changes, and on an explicit Refresh — not on the poll.
      function loadForecast() {
        if (!state.agentId || !deps.fetchForecast) return Promise.resolve();
        forecastHost.replaceChildren(ui.panel({ title: t('fc.title'), children: [ui.loadingState(3)] }));
        return deps.fetchForecast(state.agentId)
          .then(function (d) {
            var usable = (d.interfaces || []).filter(function (f) { return f.ok; });
            forecastHost.replaceChildren(ui.panel({
              title: t('fc.title'),
              note: t('fc.note', { days: d.windowDays }),
              children: [usable.length
                ? forecastTable(usable)
                : ui.emptyState({ title: t('fc.none'), body: t('fc.noneHint') })],
            }));
          })
          .catch(function (e) {
            // A failed forecast must not take the interface table with it —
            // the current state is the more urgent of the two.
            forecastHost.replaceChildren(ui.panel({
              title: t('fc.title'),
              children: [ui.errorState({
                title: t('fc.err.title'), body: deps.errText(e),
                detail: 'GET /api/forecast/interfaces', onRetry: loadForecast,
              })],
            }));
          });
      }

      function load() {
        if (!state.agentId) return Promise.resolve();
        return deps.fetchInterfaces(state.agentId)
          .then(function (d) {
            drawBar();
            tableHost.replaceChildren(ui.panel({
              title: t('iface.panel'),
              note: d.ts
                ? t('iface.measured', { source: d.source, at: ui.fmt.clock(d.ts) })
                : t('iface.neverMeasured'),
              children: [table(d.interfaces, d.source)],
            }));
          })
          .catch(function (e) {
            drawBar();
            tableHost.replaceChildren(ui.panel({
              title: t('iface.panel'),
              children: [ui.errorState({
                title: t('iface.err.title'), body: deps.errText(e),
                detail: 'GET /api/interfaces', onRetry: load,
              })],
            }));
          });
      }

      tableHost.replaceChildren(ui.panel({ title: t('iface.panel'), children: [ui.loadingState(5)] }));
      return deps.fetchAgents()
        .then(function (list) {
          agents = list || [];
          if (!agents.length) {
            // No estate at all: an agent picker with nothing in it, above a
            // table that can never fill, is three panels saying one thing.
            barHost.replaceChildren();
            forecastHost.replaceChildren();
            tableHost.replaceChildren(ui.panel({
              title: t('iface.panel'),
              children: [ui.emptyState({
                icon: '◎', title: t('iface.noAgents'), body: t('iface.noAgentsHint'),
                action: deps.openAgents
                  ? ui.button('secondary', t('iface.noAgentsGo'), { onclick: deps.openAgents })
                  : null,
              })],
            }));
            return;
          }
          if (!state.agentId || !agents.some(function (a) { return String(a.id) === String(state.agentId); })) {
            state.agentId = String(agents[0].id);
          }
          drawBar();
          loadForecast();
          return load().then(function () { deps.startPolling(load); });
        })
        .then(function () { return page; });
    }

    return { view: view, table: table };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.InterfacesPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
