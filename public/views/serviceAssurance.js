// public/views/serviceAssurance.js — Service Assurance, as a ListPage
// (template A). A SHELL migration.
//
// Eight screens — applications, journeys, tests, runs, history, health,
// schedules, monitors — live in public/serviceAssurance.js, which is 5,100
// lines and ships standalone. What is migrated here is the page they sit on:
// the PageHeader with the (?) popover, and the tab strip.
//
// What this migration changes:
//   * the module carried its OWN copy of the tab strip — correct keyboard and
//     ARIA, written out a second time because the module ships standalone. The
//     contract forbids a page-local copy of a component, so the module grew an
//     `embedded` mode: the host draws the chrome, the module draws the body,
//     and without the flag it still owns its own shell for standalone use;
//   * the screen gains a PageHeader and the (?) popover. It had neither: the
//     tab strip was the first thing on the page, so the section's name appeared
//     only in the nav and the breadcrumb.
//
// The eight tab bodies are NOT migrated. Each is hundreds of lines with its own
// forms, detail screens and polling; they migrate in their own commits.
// `ui:check` holds this file to the contract meanwhile.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    function view() {
      var page = ui.page();
      var tabsHost = el('div', {});

      var mod = deps.mount();
      if (!mod) {
        return Promise.resolve(ui.page(
          ui.pageHeader({ title: t('sa.title') }),
          ui.panel({ children: [ui.errorState({ title: t('sa.err.load'), body: t('sa.err.loadHint') })] })));
      }

      function drawTabs() {
        tabsHost.replaceChildren(ui.tabs(mod.tabs, {
          active: mod.activeTab(),
          ariaLabel: t('sa.title'),
          onPick: function (key) { deps.setTab(key); mod.setTab(key); },
        }));
      }

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('sa.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
      }), tabsHost, mod.node);
      drawTabs();
      return Promise.resolve(page);
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.ServiceAssurancePage = apiObj;
})(typeof window !== 'undefined' ? window : null);
