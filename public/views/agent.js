// public/views/agent.js — one agent, as a DetailPage (template D).
// A SHELL migration.
//
// The device's own page: its health verdict and the metrics behind it, its
// config history, its CMDB asset, what it talks to, its activity, and four
// folds of live tooling. What is migrated here is the page they sit on.
//
// What this migration changes:
//   * the heading was a `.section-head` with SIX things in one flex row: a Back
//     button, the name, a status badge, a location link with a 📍 in it, and
//     three more buttons. It is a PageHeader — the name, the status beside it
//     (template D's `status` slot), the location as the lead, and the actions
//     where actions go, with "Run test" as the one primary;
//   * the location link was `.linklike` with an emoji glued to the front. It is
//     a HostLink, which is what the contract has for "a place you can open";
//   * `.badge <status>` was the raw server word as a class. It is a Badge on a
//     tone;
//   * the health résumé, the three cards and the activity timeline were `.card`
//     divs whose `<h3>` three separate loaders rebuilt on every fill. They are
//     Panels; the loaders fill a body and the panel keeps its title;
//   * "Select an agent in the overview" and a bare red line for a failed load
//     were both `.empty`. They are an EmptyState and an ErrorState, and a 404
//     names the id it could not find.
//
// The four `<details class="sec">` folds — Probes, Interfaces, NIC firmware and
// Traffic — are passed in whole. They carry their own forms, pollers and
// charts, and the fold itself is doing real work on a page this long.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var STATUS_TONE = { online: 'ok', offline: 'crit' };

    function view() {
      var id = deps.id();
      var page = ui.page();

      function back() {
        return ui.button('secondary', t('ad.back'), { onclick: function () { deps.openFleet(); } });
      }

      if (id == null) {
        page.append(
          ui.pageHeader({ title: t('ad.title'), actions: [back()] }),
          ui.panel({ children: [ui.emptyState({ title: t('ad.noneSelected'), body: t('ad.noneSelectedHint') })] }));
        return Promise.resolve(page);
      }

      return deps.fetchAgent(id).then(function (agent) {
        var name = agent.display_name || agent.hostname;

        page.append(ui.pageHeader({
          title: name,
          status: ui.badge(STATUS_TONE[agent.status] || 'neutral', agent.status || '–'),
          lead: el('span', {},
            ui.meta(agent.platform + ' / ' + agent.arch + ' · '),
            agent.location_id != null
              ? ui.hostLink(agent.location_name || '#' + agent.location_id,
                function () { deps.openLocation(agent.location_id); })
              : ui.meta(agent.location_name || t('ad.noLocation'))),
          help: { title: t('ad.info.title'), body: function () { return deps.helpBody(); } },
          actions: [
            ui.button('secondary', t('ad.flows'), { onclick: function () { deps.openFlows(); } }),
            ui.button('secondary', t('ad.export'), { onclick: function () { deps.exportInvestigation(id, name); } }),
            deps.canWrite()
              ? ui.button('primary', t('ad.runTest'), { onclick: function () { deps.runTest(agent); } })
              : null,
            back(),
          ],
        }));

        // This agent, opened on the screens that chase a fault further.
        var ctx = deps.contextActions ? deps.contextActions({ agentId: Number(id) }) : null;
        if (ctx) page.append(ctx);

        // The health verdict and the metrics behind it. The body is filled by
        // the poller, so the panel is built once and kept.
        var healthBody = el('div', { class: 'agent-health' });
        page.append(ui.panel({ title: t('ad.health'), children: [el('div', { class: 'panel-body' }, healthBody)] }));

        // Config history / CMDB / Dependencies, side by side.
        var grid = ui.panelGrid();
        deps.cards(id).forEach(function (c) {
          grid.append(ui.panel({ title: c.title, children: [el('div', { class: 'panel-body' }, c.node)] }));
        });
        page.append(grid);

        // The activity timeline draws its own card with its own heading and a
        // range picker in it, so the page appends it as it is — a panel around
        // it is a box inside a box with the same name on both.
        page.append(deps.timeline(id));

        // The four folds, passed in whole.
        deps.folds(id, agent).forEach(function (n) { page.append(n); });

        deps.start(id, healthBody);
        return page;
      }).catch(function (e) {
        var notFound = e && e.status === 404;
        page.replaceChildren(
          ui.pageHeader({ title: t('ad.title'), actions: [back()] }),
          ui.panel({
            children: [ui.errorState({
              title: notFound ? t('ad.notFound', { id: id }) : t('ad.err.title'),
              body: notFound ? t('ad.notFoundHint') : deps.errText(e),
              detail: 'GET /agents/' + id,
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
  if (root) root.AgentPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
