// public/views/home.js — Overview, as a DashboardPage (template B).
//
// The landing screen, and the answer to one question: is the network all
// right, and if not, where do I go next? The dashboard has twenty-odd
// screens; arriving on any one of them means reading a list before knowing
// whether there is anything to read. This page is the layer above them —
// counts first, then the three lists that are worth looking at on arrival,
// each row a link into the screen that owns it.
//
// It adds no server surface: the three reads are the ones the Fleet,
// Troubleshooting and Changes screens already make, and app.js hands them in.
// Each read is independent and best-effort — a source that fails takes its own
// panel down and says so, rather than blanking the screen a shift starts on.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var SEV_TONE = { CRIT: 'crit', WARN: 'warn', INFO: 'info' };
    // How many rows each list shows. The point of the page is the shortlist;
    // every panel's footer action opens the full screen.
    var ROWS = 6;

    // A key built from data goes through a variable, never concatenated inside
    // the translate call: the gate sweeps the source for literal keys.
    function severityLabel(sev) { var k = 'changes.group.' + sev; var v = t(k); return v === k ? String(sev) : v; }

    function view() {
      var page = ui.page();
      var stripHost = el('div', {});
      var noteHost = el('div', {});
      var causeHost = el('div', {});
      var agentHost = el('div', {});
      var changeHost = el('div', {});
      // One slot per source: null until it answers, an Error when it failed.
      var data = { fleet: null, tshoot: null, changes: null };
      var failed = { fleet: null, tshoot: null, changes: null };

      var info = deps.help();
      var refresh = ui.button('secondary', t('home.refresh'), { onclick: function () { load(); } });
      page.append(ui.pageHeader({
        title: t('home.title'),
        lead: t('home.lead'),
        help: { title: info.title, body: info.body },
        actions: [refresh],
      }), stripHost, noteHost, causeHost, agentHost, changeHost);

      // ---- the counts --------------------------------------------------------
      function drawStrip() {
        var f = (data.fleet && data.fleet.summary) || {};
        var s = (data.tshoot && data.tshoot.summary) || {};
        var ch = (data.changes && data.changes.events) || [];
        var problems = (Number(f.bad) || 0) + (Number(f.down) || 0) + (Number(f.warn) || 0);
        var hint = t('home.stat.hint');
        var cards = [
          { value: data.fleet ? (f.total || 0) : '—', label: t('home.stat.agents'), title: hint, onclick: function () { deps.go('fleet'); } },
          {
            value: data.fleet ? (f.offline || 0) : '—', label: t('home.stat.offline'),
            tone: f.offline ? 'crit' : undefined, title: hint, onclick: function () { deps.go('fleet'); },
          },
          {
            value: data.fleet ? problems : '—', label: t('home.stat.problems'),
            tone: problems ? 'warn' : undefined, title: hint, onclick: function () { deps.go('fleet'); },
          },
          {
            value: data.tshoot ? (s.rootCauses || 0) : '—', label: t('home.stat.causes'),
            tone: s.rootCauses ? 'crit' : undefined, title: hint, onclick: function () { deps.go('troubleshooting'); },
          },
          {
            value: data.tshoot ? (s.activeFaults || 0) : '—', label: t('home.stat.faults'),
            tone: s.activeFaults ? 'warn' : undefined, title: hint, onclick: function () { deps.go('troubleshooting'); },
          },
          { value: data.changes ? ch.length : '—', label: t('home.stat.changes'), title: hint, onclick: function () { deps.go('changes'); } },
        ];
        stripHost.replaceChildren(ui.statStrip(cards));
      }

      // A count whose source failed reads as a dash above, and the note says
      // which source — never a reassuring zero.
      function drawNote() {
        var out = [];
        Object.keys(failed).forEach(function (k) { if (failed[k]) out.push(t('home.source.' + k)); });
        var partial = data.tshoot && data.tshoot.partial;
        if (!out.length && !partial) { noteHost.replaceChildren(); return; }
        noteHost.replaceChildren(ui.inlineNote(out.length
          ? t('home.note.failed', { sources: out.join(', ') })
          : t('home.note.partial'), 'warn'));
      }

      // ---- a panel that knows its source may have failed --------------------
      function sourcePanel(key, title, action, build) {
        var body;
        if (failed[key]) {
          body = ui.errorState({
            title: t('home.err.title'),
            body: deps.errText(failed[key]),
            detail: deps.endpoint[key],
            onRetry: load,
          });
        } else if (!data[key]) body = ui.loadingState(3);
        else body = build();
        return ui.panel({ title: title, actions: [action], children: [body] });
      }

      // ---- what needs attention ---------------------------------------------
      function drawCauses() {
        causeHost.replaceChildren(sourcePanel('tshoot', t('home.causes.title'),
          ui.button('secondary', t('home.causes.all'), { size: 'xs', onclick: function () { deps.go('troubleshooting'); } }),
          function () {
            var causes = (data.tshoot.rootCauses || []).slice(0, ROWS);
            if (!causes.length) {
              return ui.emptyState({ kind: 'ok', title: t('home.causes.empty'), body: t('home.causes.emptyBody') });
            }
            return ui.dataTable({
              columns: [
                { key: 'cause', label: t('home.col.cause') },
                { key: 'impact', label: t('home.col.impact'), width: '20%' },
                { key: 'since', label: t('home.col.since'), width: '140px' },
              ],
              rows: causes.map(function (rc, i) {
                var devices = (rc.affectedDeviceIds || []).length;
                return {
                  key: String(rc.id != null ? rc.id : i),
                  cells: {
                    cause: ui.hostLink(String(rc.cause || t('home.causes.unnamed')), function () { deps.go('troubleshooting'); }),
                    impact: ui.metaXs(t('home.causes.devices', { n: devices })),
                    since: ui.metaXs(rc.firstSeen ? ui.fmt.short(rc.firstSeen) : '—'),
                  },
                };
              }),
            });
          }));
      }

      // ---- agents worth a look ----------------------------------------------
      function drawAgents() {
        agentHost.replaceChildren(sourcePanel('fleet', t('home.agents.title'),
          ui.button('secondary', t('home.agents.all'), { size: 'xs', onclick: function () { deps.go('fleet'); } }),
          function () {
            // The server returns the fleet worst-first already, so the
            // shortlist is the head of the list that is not OK.
            var bad = (data.fleet.agents || []).filter(function (a) {
              return !a.online || ((a.health && a.health.status) || 'ok') !== 'ok';
            }).slice(0, ROWS);
            if (!bad.length) {
              return ui.emptyState({ kind: 'ok', title: t('home.agents.empty'), body: t('home.agents.emptyBody') });
            }
            return ui.dataTable({
              columns: [
                { key: 'agent', label: t('home.col.agent') },
                { key: 'health', label: t('home.col.health'), width: '120px' },
                { key: 'site', label: t('home.col.site'), width: '22%' },
                { key: 'seen', label: t('home.col.seen'), width: '140px' },
              ],
              rows: bad.map(function (a) {
                return {
                  key: String(a.agentId),
                  cells: {
                    agent: ui.hostLink(String(a.displayName || a.hostname || a.agentId), function () { deps.openAgent(a.agentId); }),
                    health: a.online ? deps.healthBadge(a.health) : ui.badge('neutral', t('home.agents.offline')),
                    site: ui.metaXs(a.locationName || '—'),
                    seen: ui.metaXs(a.lastReportAt ? ui.fmt.rel(a.lastReportAt) : t('home.agents.never')),
                  },
                };
              }),
            });
          }));
      }

      // ---- what changed ------------------------------------------------------
      function drawChanges() {
        changeHost.replaceChildren(sourcePanel('changes', t('home.changes.title'),
          ui.button('secondary', t('home.changes.all'), { size: 'xs', onclick: function () { deps.go('changes'); } }),
          function () {
            var events = (data.changes.events || []).slice(0, ROWS);
            if (!events.length) {
              return ui.emptyState({ kind: 'nodata', title: t('home.changes.empty'), body: t('home.changes.emptyBody') });
            }
            return ui.dataTable({
              columns: [
                { key: 'sev', label: t('home.col.sev'), width: '120px' },
                { key: 'what', label: t('home.col.what') },
                { key: 'when', label: t('home.col.when'), width: '140px' },
              ],
              rows: events.map(function (ev, i) {
                return {
                  key: String(ev.ackKey || i),
                  cells: {
                    sev: ui.badge(SEV_TONE[ev.severity] || 'info', severityLabel(ev.severity)),
                    what: ui.hostLink(String(ev.summary || '—'), function () { deps.go('changes'); }),
                    when: ui.metaXs(ui.fmt.short(ev.timestamp)),
                  },
                };
              }),
            });
          }));
      }

      function drawAll() {
        drawStrip();
        drawNote();
        drawCauses();
        drawAgents();
        drawChanges();
      }

      // Three independent reads: one failure never stops the other two, which
      // is the whole reason this page is worth arriving on.
      function load() {
        refresh.disabled = true;
        data = { fleet: null, tshoot: null, changes: null };
        failed = { fleet: null, tshoot: null, changes: null };
        drawAll();
        var one = function (key) {
          return Promise.resolve()
            .then(function () { return deps.fetch[key](); })
            .then(function (res) { data[key] = res || {}; })
            .catch(function (e) { failed[key] = e; });
        };
        return Promise.all([one('fleet'), one('tshoot'), one('changes')])
          .then(function () { refresh.disabled = false; drawAll(); });
      }

      load();
      return Promise.resolve(page);
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.HomePage = apiObj;
})(typeof window !== 'undefined' ? window : null);
