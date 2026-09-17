// public/views/situation.js — one situation, as a DetailPage (template D).
// A SHELL migration.
//
// A situation is findings the analyser grouped into one story. Its five panels
// — what changed, the evidence, the recommended actions, the advisory and the
// timeline — stay in public/clusterView.js, which ships standalone. What is
// migrated here is the page they sit on.
//
// What this migration changes:
//   * the heading was `.inc-header`: an `<h2>` reading "Situation #14", three
//     badges from three different vocabularies (`.inc-status-*`, `.conf-*`,
//     `.rc-*`) and a run of `· ` separators, with Back floated beside it and an
//     `.inc-actions` bar underneath. It is a PageHeader — the suspected cause
//     as the title (which is what the reader is here for; the id is in the
//     address), the status beside it, the rest as the lead;
//   * Acknowledge and Resolve were two `.small` buttons in a row. Resolve is
//     the one that closes the story, so it is the primary; Acknowledge is the
//     secondary beside it;
//   * "no situation selected" and "situation not found" were the same grey box
//     with a different sentence. A 404 names the id it could not find and
//     offers no Retry, because asking again gets the same answer.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var STATUS_TONE = { open: 'crit', acknowledged: 'warn', resolved: 'ok', closed: 'neutral' };
    var CONF_TONE = { high: 'ok', medium: 'warn', low: 'neutral' };

    function view() {
      var id = deps.id();
      var page = ui.page();

      function back() {
        return ui.button('secondary', t('sit.back'), { onclick: function () { deps.openList(); } });
      }

      if (id == null) {
        page.append(
          ui.pageHeader({ title: t('sit.detail.title'), actions: [back()] }),
          ui.panel({ children: [ui.emptyState({ title: t('sit.noneSelected'), body: t('sit.noneSelectedHint') })] }));
        return Promise.resolve(page);
      }

      return deps.fetchDetail(id).then(function (detail) {
        var rc = detail.suspectedRootCause || {};
        var agents = Array.isArray(detail.affectedAgents) ? detail.affectedAgents.length : 0;
        var moves = deps.actions(detail.status);

        var actions = [];
        // Resolve is the move that closes the story, so it is the primary even
        // when Acknowledge is offered beside it.
        if (moves.indexOf('ack') >= 0) {
          actions.push(ui.button('secondary', t('sit.ack'), { onclick: function () { deps.ack(id); } }));
        }
        if (moves.indexOf('resolve') >= 0) {
          actions.push(ui.button('primary', t('sit.resolve'), { onclick: function () { deps.resolve(id); } }));
        }
        actions.push(back());

        page.append(ui.pageHeader({
          // The suspected cause is what the reader came for; the id is already
          // in the address, so it does not need to be the headline too.
          title: deps.causeLabel(rc.classification),
          status: ui.badge(STATUS_TONE[detail.status] || 'neutral', deps.statusLabel(detail.status)),
          lead: el('span', {},
            ui.badge(CONF_TONE[detail.confidence] || 'neutral',
              t('sit.confidenceOf', { level: deps.confLabel(detail.confidence) })), ' ',
            ui.meta(t('sit.detail.lead', {
              n: agents,
              first: ui.fmt.abs(detail.firstSeen),
              last: ui.fmt.abs(detail.lastSeen),
            }))),
          help: { title: t('sit.info.title'), body: function () { return deps.helpBody(); } },
          actions: actions,
        }));

        // The five panels are the module's, passed in whole.
        page.append(deps.mount(detail));
        return page;
      }).catch(function (e) {
        var notFound = e && e.status === 404;
        page.replaceChildren(
          ui.pageHeader({ title: t('sit.detail.title'), actions: [back()] }),
          ui.panel({
            children: [ui.errorState({
              title: notFound ? t('sit.notFound', { id: id }) : t('sit.err.detail'),
              body: notFound ? t('sit.notFoundHint') : deps.errText(e),
              detail: 'GET /api/event-clusters/' + id,
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
  if (root) root.SituationPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
