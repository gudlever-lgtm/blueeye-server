// public/views/systemHealth.js — "Is BlueEyes itself all right?"
//
// The one screen about the monitoring system rather than about the network it
// monitors. Every other screen answers with data this server collected; this one
// answers whether it could collect anything at all.
//
// THREE states, never two — and the middle one is the reason the screen exists:
//
//   OK       we measured it and it is fine
//   FAILING  we measured it and it is not
//   UNKNOWN  we could not measure it, so we cannot say
//
// `unknown` is never drawn green and never counted as fine. A page that shows
// eight green and hides three unread signals is a page that says "all well"
// about a system it can only partly see.
//
// It adds no server surface: GET /system/self composes what other screens
// already read (src/system/selfHealth.js).

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    // Tone per state. `unknown` takes the NEUTRAL tone, not the warning one: it
    // is an absence of knowledge, and dressing it as a warning teaches people
    // to dismiss the warnings that are real.
    var TONE = { ok: 'ok', failing: 'crit', unknown: 'neutral' };
    var STATE_LABEL = { ok: 'self.state.ok', failing: 'self.state.failing', unknown: 'self.state.unknown' };
    // A key per signal id, through a map: the gate sweeps the source for
    // literal t() keys, and one glued together at the call site is one it
    // cannot read.
    var SIGNAL_LABEL = {
      database: 'self.sig.database',
      telemetry: 'self.sig.telemetry',
      license: 'self.sig.license',
      signing: 'self.sig.signing',
      trustKeys: 'self.sig.trustKeys',
      agents: 'self.sig.agents',
      ingest: 'self.sig.ingest',
      commandQueue: 'self.sig.commandQueue',
      assuranceWorkers: 'self.sig.assuranceWorkers',
      backgroundJobs: 'self.sig.backgroundJobs',
      storage: 'self.sig.storage',
    };

    function signalLabel(id) {
      var k = SIGNAL_LABEL[id];
      return k ? t(k) : String(id);
    }
    function stateLabel(state) {
      var k = STATE_LABEL[state];
      return k ? t(k) : String(state);
    }

    function view() {
      var page = ui.page();
      var host = el('div', {});
      var data = null;
      var failed = null;

      var info = deps.help();
      var refresh = ui.button('secondary', t('self.refresh'), { onclick: function () { load(); } });
      page.append(ui.pageHeader({
        title: t('self.title'),
        lead: t('self.lead'),
        help: { title: info.title, body: info.body },
        actions: [refresh],
      }), host);

      function draw() {
        if (failed) {
          host.replaceChildren(ui.errorState({
            title: t('self.err.title'),
            body: deps.errText(failed),
            detail: 'GET /system/self',
            onRetry: load,
          }));
          return;
        }
        if (!data) { host.replaceChildren(ui.loadingState(6)); return; }

        var counts = data.counts || { ok: 0, failing: 0, unknown: 0 };
        // The overall verdict, in a sentence. Three numbers rather than one
        // badge, because "9 OK" means something different beside "0 unknown"
        // than beside "2 unknown".
        var verdict = ui.inlineNote(t('self.verdict.' + ({
          ok: 'ok', failing: 'failing', unknown: 'unknown',
        }[data.state] || 'unknown')), data.state === 'ok' ? 'ok' : 'warn');

        var strip = ui.statStrip([
          { value: counts.ok, label: t('self.count.ok'), tone: undefined },
          { value: counts.failing, label: t('self.count.failing'), tone: counts.failing ? 'crit' : undefined },
          // Never toned 'ok', whatever the number: a count of blind spots is
          // not good news at any value.
          { value: counts.unknown, label: t('self.count.unknown'), tone: counts.unknown ? 'warn' : undefined },
        ]);

        var table = ui.dataTable({
          columns: [
            { key: 'state', label: t('self.col.state'), width: '110px' },
            { key: 'signal', label: t('self.col.signal'), width: '24%' },
            { key: 'detail', label: t('self.col.detail') },
          ],
          rows: (data.signals || []).map(function (s) {
            return {
              key: s.id,
              cells: {
                state: ui.badge(TONE[s.state] || 'neutral', stateLabel(s.state)),
                signal: el('strong', {}, signalLabel(s.id)),
                detail: ui.metaXs(String(s.detail || '—')),
              },
            };
          }),
        });

        host.replaceChildren(
          verdict,
          strip,
          ui.panel({
            title: t('self.panel.title'),
            note: data.checkedAt ? t('self.checkedAt', { at: ui.fmt.short(data.checkedAt) }) : '',
            children: [table],
          })
        );
      }

      function load() {
        refresh.disabled = true;
        data = null;
        failed = null;
        draw();
        return deps.fetch()
          .then(function (res) { data = res || null; })
          .catch(function (e) { failed = e; })
          .then(function () { refresh.disabled = false; draw(); });
      }

      load();
      return Promise.resolve(page);
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.SystemHealthPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
