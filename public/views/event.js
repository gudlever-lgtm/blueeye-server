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
          return ui.button(i === moves.length - 1 ? 'primary' : 'secondary',
            to === 'open' ? t('ev.reopen') : t('ev.markAs', { state: statusLabel(to) }), {
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

        // Everything else is app.js's, wrapped rather than rebuilt: each panel
        // owns its title, and the loaders fill the body under it.
        deps.panels(inc, anomalies, id).forEach(function (p) {
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
