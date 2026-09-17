// public/views/settings.js — Settings, as a ListPage (template A).
// A SHELL migration.
//
// Twenty-two sections in five groups. What is migrated here is the page they
// sit on; every section body stays where it is and migrates on its own.
//
// What this migration changes:
//   * the section picker was five wrapped clusters of `.small ghost` buttons
//     with an `.active` class — twenty-two buttons pretending to be tabs, which
//     the contract forbids outright. It is **two levels of SubTabs**: the five
//     groups, then the sections of the group you are in. Five fits a strip and
//     so does eight; twenty-two never did, which is why they wrapped;
//   * the group is derived from the section, so the address does not change and
//     a link to /settings/retention still opens Retention — with Data selected
//     above it;
//   * the licence pill was `.badge active|bad` on a bare `div` above the
//     content. It is a contract Badge in a Toolbar row, and it moves with the
//     section rather than sitting above the strips;
//   * a section that threw replaced the whole page body with a red box. It is
//     an ErrorState inside the panel, with the section still selected and a
//     Retry, so a failing section no longer looks like a broken Settings.
//
// **Deviation from the contract, recorded deliberately:** the contract asks for
// one SubTabs row per screen. Settings has two, for the same reason Reporting
// does — the second level belongs to the thing the first level selected. With
// one level this screen needs twenty-two tabs in a row, which is what the
// wrapped buttons were.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    function view() {
      var groups = deps.groups();
      var active = deps.tab();
      var all = [];
      groups.forEach(function (g) {
        g[1].forEach(function (s) { all.push(s[0]); });
      });
      // A section the reader can no longer reach (an admin-only one, after a
      // role change) falls back rather than rendering an empty page.
      if (all.indexOf(active) < 0) {
        active = all[0];
        deps.setTab(active);
      }
      function groupOf(key) {
        for (var i = 0; i < groups.length; i++) {
          for (var j = 0; j < groups[i][1].length; j++) {
            if (groups[i][1][j][0] === key) return i;
          }
        }
        return 0;
      }
      var gi = groupOf(active);

      var page = ui.page();
      var groupHost = el('div', {});
      var sectionHost = el('div', {});
      var licHost = el('div', {});
      var bodyHost = el('div', {});

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('set.title'),
        lead: t('set.lead'),
        help: { title: info.title, body: info.body },
      // Each is a direct child of the page, so the page's own column gap
      // separates them — a bar and a body inside one wrapper would touch.
      }), groupHost, sectionHost, licHost, bodyHost);

      function drawGroups() {
        groupHost.replaceChildren(ui.tabs(groups.map(function (g, i) { return [String(i), g[0]]; }), {
          active: String(gi),
          ariaLabel: t('set.groups'),
          onPick: function (key) {
            gi = Number(key);
            // Moving group selects that group's first section — a group with
            // nothing selected under it is a strip with no page behind it.
            open(groups[gi][1][0][0]);
          },
        }));
      }

      function drawSections() {
        sectionHost.replaceChildren(ui.tabs(groups[gi][1].map(function (s) { return [s[0], s[1]]; }), {
          active: active,
          ariaLabel: groups[gi][0],
          onPick: open,
        }));
      }

      function open(key) {
        active = key;
        gi = groupOf(key);
        deps.setTab(key);
        drawGroups();
        drawSections();
        drawBody();
      }

      // The licence answer belongs with the section it is about. It cannot sit
      // on a panel head, because the sections draw their own `.settings-card`
      // panels — a second one around them is a box inside a box with the
      // section's name on both. So the badge gets a toolbar row of its own, and
      // the panel is kept for the two states the section cannot draw itself.
      function drawLicence(key) {
        var lic = deps.licence(key);
        licHost.replaceChildren(ui.toolbar({
          filters: [el('span', { title: lic.title }, ui.badge(lic.ok ? 'ok' : 'crit', lic.text))],
        }));
      }

      function drawBody() {
        var want = active;
        drawLicence(want);
        bodyHost.replaceChildren(ui.panel({ title: deps.label(want), children: [ui.loadingState(5)] }));
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
              title: deps.label(want),
              children: [ui.errorState({
                title: t('set.err.title', { section: deps.label(want) }),
                body: deps.errText(e),
                onRetry: drawBody,
              })],
            }));
          });
      }

      drawGroups();
      drawSections();
      // The page is on screen before the section resolves, so the strips and
      // the skeleton are visible while it loads.
      drawBody();
      return Promise.resolve(page);
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.SettingsPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
