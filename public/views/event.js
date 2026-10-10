// public/views/event.js — one event, as a DetailPage (template D).
//
// The record's page: what happened, where, what state it is in, and the eight
// panels that answer "what do I do about it". Built from the contract's
// components (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * the heading was `.inc-header` — an `<h2>`, a row of badges and a run of
//     `· ` separators, with a "← Events" button floated beside it. It is a
//     PageHeader: the title, the status beside it (template D's `status` slot),
//     the where as the lead, and Back as an action;
//   * the status transitions were bare `.small` buttons in an `.inc-actions`
//     div. There is one move from any state, so it is the PageHeader's single
//     primary — "Mark investigating", "Reopen" — rather than a loose row;
//   * `.inc-status-<state>` and `.inc-sev-<level>` were two more severity
//     vocabularies, one of them keyed on the server's word. Both are Badges on
//     the app's tones;
//   * eight `.card` blocks, each with its own `<h3>` that four separate loaders
//     rebuilt on every fill, become Panels. The loaders fill a body and the
//     panel keeps its title;
//   * "no event selected" and "event not found" were the same grey box with a
//     different sentence. They are an EmptyState and an ErrorState, and a 404
//     says which id it could not find.
//
// The panel bodies are NOT migrated: the work log, the guide, the blast radius,
// the path visualisation and the assistant are each their own machinery.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var SEV_TONE = { CRIT: 'crit', WARN: 'warn', INFO: 'info' };
    var STATUS_TONE = { open: 'crit', investigating: 'warn', resolved: 'ok', closed: 'neutral' };

    function sevBadge(s) { return ui.badge(SEV_TONE[s] || 'neutral', s || '–'); }
    function statusLabel(s) {
      var k = 'ev.status.' + s;
      var v = t(k);
      return v === k ? String(s || '') : v;
    }

    function view() {
      var id = deps.id();
      var page = ui.page();

      function back() {
        return ui.button('secondary', t('ev.back'), { onclick: function () { deps.openList(); } });
      }

      if (id == null) {
        page.append(
          ui.pageHeader({ title: t('ev.title'), actions: [back()] }),
          ui.panel({ children: [ui.emptyState({ title: t('ev.noneSelected'), body: t('ev.noneSelectedHint') })] }));
        return Promise.resolve(page);
      }

      return deps.fetchEvent(id).then(function (data) {
        var inc = data.event;
        var anomalies = data.anomalies || [];

        // At most ONE primary in a page header. `open` has two moves —
        // "investigating" for picking it up, "resolved" for dismissing it when
        // there is nothing to investigate — so the last one is the primary and
        // the earlier ones are secondary, the same rule the bulk bar on the
        // Events list uses.
        var moves = deps.canWrite() ? (deps.transitions(inc.status) || []) : [];
        var actions = moves.map(function (to, i) {
          // Two moves are not "mark as <state>" and must not be labelled as if
          // they were: reopening says the last conclusion was wrong, and going
          // back from resolved says the fix did not hold when it was checked.
          var label = t('ev.markAs', { state: statusLabel(to) });
          if (to === 'open') label = t('ev.reopen');
          else if (inc.status === 'resolved' && to === 'investigating') label = t('ev.verifyFailed');
          return ui.button(i === moves.length - 1 ? 'primary' : 'secondary', label, {
            onclick: function () { deps.setStatus(id, inc.status, to); },
          });
        });
        // Draft the regulator-facing NIS2 record of this case (pre-filled and
        // linked server-side). Secondary: it is a follow-up, not the next move.
        if (deps.canWrite() && typeof deps.draftNis2 === 'function') {
          actions.push(ui.button('secondary', t('ev.nis2Draft'), {
            title: t('ev.nis2DraftHint'),
            onclick: function () { deps.draftNis2(id); },
          }));
        }
        actions.push(back());

        page.append(ui.pageHeader({
          title: inc.title,
          status: sevBadge(inc.severity),
          lead: el('span', {},
            ui.badge(STATUS_TONE[inc.status] || 'neutral', statusLabel(inc.status)), ' ',
            deps.agentLink(inc), ui.meta(' · ' + deps.locationLabel(inc)
              + ' · ' + t('ev.opened', { at: ui.fmt.abs(inc.firstEventAt) })),
            // The situation (cross-agent cluster) this case is part of, when
            // the same fault is being seen from other agents too.
            inc.clusterId != null && typeof deps.openCluster === 'function'
              ? el('span', {}, ui.meta(' · '), ui.hostLink(t('ev.partOfSituation', { id: inc.clusterId }),
                function () { deps.openCluster(inc.clusterId); }))
              : null),
          help: { title: t('ev.info.title'), body: function () { return deps.helpBody(); } },
          actions: actions,
        }));

        // THE ATTACK INDICATION, IN FULL, FIRST.
        //
        // The red bar at the top of the shell shows one trimmed sentence and
        // links here. Until now "here" was a page whose heading named whatever
        // the case was called — a jitter event, say — with the scan sitting
        // fourth in a list of nine anomalies, trimmed to one line like all the
        // others. The reader had to go looking for the thing that was red.
        //
        // So the case's attack-indication findings (flagged server-side from
        // the one membership list) get their own panel above everything else,
        // with the detector's COMPLETE text — the part that says what would
        // make this benign is the part that was being cut off. The one the bar
        // opened is marked as such.
        var flagged = typeof deps.flaggedFinding === 'function' ? deps.flaggedFinding() : null;
        var attacks = anomalies.filter(function (a) { return a && a.attack; });
        var attackPanel = attacks.length ? ui.panel({
          title: t('ev.attack.title'),
          note: t('ev.attack.count', { n: attacks.length }),
          children: [el('div', { class: 'panel-body' }, el('ul', { class: 'attack-findings' },
            attacks.map(function (a) {
              var isFlagged = flagged != null && String(a.id) === String(flagged);
              return el('li', { class: 'attack-finding' + (isFlagged ? ' flagged' : '') },
                el('div', { class: 'attack-finding-head' },
                  sevBadge(a.severity), ' ', el('strong', {}, a.metric),
                  ui.meta(' · ' + ui.fmt.abs(a.createdAt)),
                  isFlagged ? el('span', {}, ui.meta(' · '), ui.badge('crit', t('ev.attack.fromBar'))) : null),
                el('p', { class: 'attack-finding-text' }, a.explanation || t('ev.attack.noText')));
            })))],
        }) : null;

        // Anomalies is the one panel this view builds itself: it is a list of
        // findings, which is a shape the contract already has.
        var anomPanel = ui.panel({
          title: t('ev.anomalies'),
          note: t('ev.anomaliesCount', { n: anomalies.length }),
          children: [anomalies.length
            ? el('div', { class: 'panel-body' }, ui.history(anomalies.map(function (a) {
              return [ui.fmt.short(a.createdAt), el('span', {},
                sevBadge(a.severity), ' ', el('strong', {}, a.metric), ' — ', a.explanation || '')];
            })))
            : ui.emptyState({ title: t('ev.noAnomalies'), body: t('ev.noAnomaliesHint') })],
        });

        // ---- verification (a resolved case is not a finished one) ----------
        //
        // `resolved` and `closed` are two states on purpose: the fix is in, and
        // somebody checked that it worked. Nothing on the screen said so, so
        // "Mark closed" sat there looking like the tidy-up after resolving —
        // and a case closed without a check carries the same badge as one that
        // was verified, which is the distinction being thrown away.
        //
        // The checklist is derived from what this case was actually built on
        // (its findings' own metrics), never invented: re-run what fired, then
        // judge it against the numbers from when it started. Nothing is run
        // from here. An active test on a network somebody has just worked on
        // is a decision, not a side effect of pressing Closed.
        var verifyPanel = null;
        if (inc.status === 'resolved') {
          var metrics = [];
          anomalies.forEach(function (a) {
            if (a && a.metric && metrics.indexOf(a.metric) < 0) metrics.push(a.metric);
          });
          var checks = [];
          if (metrics.length) {
            checks.push(t('ev.verify.check.metrics', { metrics: metrics.join(', ') }));
            checks.push(t('ev.verify.check.compare', { at: ui.fmt.abs(inc.firstEventAt) }));
          } else {
            // No findings left to name (retention may have purged them), so the
            // honest version of this line is that we cannot say what to re-run.
            checks.push(t('ev.verify.check.noMetrics'));
          }
          checks.push(t('ev.verify.check.related'));
          if (inc.clusterId != null) checks.push(t('ev.verify.check.situation', { id: inc.clusterId }));
          checks.push(t('ev.verify.check.log'));

          verifyPanel = ui.panel({
            title: t('ev.verify.title'),
            children: [
              ui.inlineNote(t('ev.verify.lead'), 'warn'),
              el('div', { class: 'panel-body' },
                el('ul', { class: 'verify-checks' }, checks.map(function (line) {
                  return el('li', {}, line);
                })),
                ui.metaXs(t('ev.verify.foot'))),
            ],
          });
        }

        if (attackPanel) page.append(attackPanel);
        if (verifyPanel) page.append(verifyPanel);

        // Everything else is app.js's, wrapped rather than rebuilt: each panel
        // owns its title, and the loaders fill the body under it.
        deps.panels(inc, anomalies, id, data).forEach(function (p) {
          if (!p) return;
          if (p.key === 'anomalies') { page.append(anomPanel); return; }
          // A body that already draws its own card (the work log, the guide,
          // the assistant) is appended as it is: a panel around it is a box
          // inside a box with the same name written on both.
          page.append(p.wrap === false ? p.node : ui.panel({
            title: p.title,
            children: [el('div', { class: 'panel-body' }, p.node)],
          }));
        });
        return page;
      }).catch(function (e) {
        var notFound = e && e.status === 404;
        page.replaceChildren(
          ui.pageHeader({ title: t('ev.title'), actions: [back()] }),
          ui.panel({
            children: [ui.errorState({
              title: notFound ? t('ev.notFound', { id: id }) : t('ev.err.title'),
              body: notFound ? t('ev.notFoundHint') : deps.errText(e),
              detail: 'GET /api/events/' + id,
              onRetry: notFound ? null : function () { return deps.rerender(); },
            })],
          }));
        return page;
      });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.EventPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
