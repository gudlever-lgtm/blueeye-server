// public/views/probes.js — Probes & Tests, as a FormPage (template C).
//
// The page shell on the UI contract (docs/ui-contract.md): PageHeader with the
// help behind (?), SubTabs, and the active tab's body underneath.
//
// The three tab BODIES are still app.js's — Run a probe, Connection test and
// Test packages are ~1,700 lines between them, and each carries live machinery
// (dispatch, polling, a schedule dialog) that a shell migration has no business
// touching. They are passed in and migrate in their own commits. That split is
// the whole reason a migrated view lives in its own file: `npm run ui:check`
// holds THIS file to the contract while the bodies it renders are still on the
// old chrome.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var TABS = ['run', 'connection', 'burst', 'packages'];
    // The tab's own label, from the catalogue the route map already names them in.
    function tabLabel(key) {
      var k = 'route.tab.probes.' + key;
      var v = t(k);
      return v === k ? key : v;
    }

    function view() {
      var active = TABS.indexOf(deps.getTab()) >= 0 ? deps.getTab() : 'run';
      var root2 = ui.page();
      // Each tab answers a different question, so each has its own one-line
      // description and its own help — the page title alone cannot say whether
      // you are about to run one check or forty.
      var info = deps.helpFor(active);

      root2.append(ui.pageHeader({
        title: t('probes.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
      }));
      root2.append(ui.tabs(TABS.map(function (k) { return [k, tabLabel(k)]; }), {
        active: active,
        ariaLabel: t('probes.title'),
        onPick: function (key) { deps.setTab(key); },
      }));

      var body = el('div', {});
      root2.append(body);
      return Promise.resolve(deps.tabBody(active)).then(function (node) {
        body.replaceChildren(node);
        return root2;
      }, function (err) {
        body.replaceChildren(ui.panel({
          title: tabLabel(active),
          children: [ui.errorState({ body: deps.errText(err), onRetry: function () { deps.rerender(); } })],
        }));
        return root2;
      });
    }

    return { view: view, TABS: TABS };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.ProbesView = apiObj;
})(typeof window !== 'undefined' ? window : null);
