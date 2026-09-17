// public/views/reporting.js — Reporting, as a ListPage (template A).
// A SHELL migration.
//
// Four sections — NIS2, the report generator, the schedules, and the audit
// trail — each its own module, each hundreds of lines with its own forms and
// tables. What is migrated here is the page they sit on.
//
// What this migration changes:
//   * the tab strip sat INSIDE the heading, so the page's name and its
//     navigation were one line of markup. The name is a PageHeader with the (?)
//     popover, and the strip is under it, where every other tabbed screen puts
//     it;
//   * "Loading…" and the error were both `.empty` — one grey box for "wait" and
//     for "it failed". They are a skeleton and an ErrorState with a Retry, and
//     the page is on screen around them rather than after them;
//   * the section goes into the URL (/reporting/audit), so a link to the audit
//     trail opens the audit trail. Picking a section used to re-render the whole
//     view through render(); now only the body is rebuilt.
//
// Audit is admin-only, so a section the reader can no longer reach falls back
// to the first rather than rendering an empty page.
//
// The four bodies are NOT migrated. Each migrates in its own commit.
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
      var bodyHost = el('div', {});

      var keys = deps.sections();
      var active = deps.section();
      if (keys.indexOf(active) < 0) {
        active = keys[0];
        deps.setSection(active);
      }

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('rep.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
      }), tabsHost, bodyHost);

      function drawBody() {
        bodyHost.replaceChildren(ui.panel({ children: [ui.loadingState(5)] }));
        var want = active;
        return Promise.resolve()
          .then(function () { return deps.render(want); })
          .then(function (node) {
            // A slow section that lost the race must not overwrite the one the
            // reader is now looking at.
            if (want !== active) return;
            bodyHost.replaceChildren(node);
          })
          .catch(function (e) {
            if (want !== active) return;
            bodyHost.replaceChildren(ui.panel({
              children: [ui.errorState({
                title: t('rep.err.title'),
                body: deps.errText(e),
                onRetry: drawBody,
              })],
            }));
          });
      }

      tabsHost.replaceChildren(ui.tabs(keys.map(function (k) { return [k, t('rep.tab.' + k)]; }), {
        active: active,
        ariaLabel: t('rep.title'),
        onPick: function (key) {
          if (active === key) return;
          active = key;
          deps.setSection(key);
          drawBody();
        },
      }));

      // The page is returned before the section resolves, so the header, the
      // tab strip and the skeleton are on screen while the body loads. Awaiting
      // the body first would leave the reader on the previous screen — and the
      // skeleton would never be seen at all.
      drawBody();
      return Promise.resolve(page);
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.ReportingPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
