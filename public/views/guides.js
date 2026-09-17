// public/views/guides.js — Guides, as a ListPage (template A).
// A SHELL migration.
//
// Five guided walkthroughs (Monitoring, Fleet, Diagnostics, Service Assurance,
// Insights), one per nav entry. The steps themselves stay in public/guides.js,
// which ships standalone. What is migrated here is the page they sit on.
//
// What this migration changes:
//   * the legacy hero banner goes. Guides opened with an info banner explaining
//     what a guide is, above a heading that said the same thing again in the
//     line under it. The contract deleted info banners; the help is in the (?)
//     popover now, where the reader asks for it;
//   * three stacked lead lines (title, what the guide covers, "7 steps — …")
//     become a PageHeader with one lead. The footer already says "Step 1 of 7",
//     so the step count is not worth a line of its own;
//   * "we could not read the live state" was a callout in the document flow. It
//     is an advisory about the data, so it is an inline note above it;
//   * Back / Next were `.ghost` and `.primary` — the legacy button classes. They
//     are contract buttons, and Back is the page's secondary rather than a
//     borderless one the reader cannot see.
//
// The stepper and the step bodies are NOT migrated; they are the module's, and
// they are the document.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    function view() {
      var mod = deps.mount();
      if (!mod) return null;

      var page = ui.page();
      var noteHost = el('div', {});
      var footHost = el('div', {});

      var info = deps.help();
      page.append(ui.pageHeader({
        title: mod.title,
        lead: mod.subtitle,
        help: { title: info.title, body: info.body },
      }), noteHost, mod.node, footHost);

      function drawNote(error) {
        noteHost.replaceChildren.apply(noteHost, error
          ? [ui.inlineNote(t('guide.stateUnavailable', { message: error }), 'warn')]
          : []);
      }

      // Back · "Step 3 of 7" · Next. The last step offers Restart instead of a
      // Next that would go nowhere.
      function drawFoot(step, total) {
        var last = step === total - 1;
        footHost.replaceChildren(ui.formActions([
          ui.button('secondary', '← ' + t('guide.back'), {
            disabled: step === 0,
            onclick: function () { mod.go(step - 1); },
          }),
          ui.metaXs(t('guide.stepOf', { n: String(step + 1), total: String(total) })),
        ], [
          last
            ? ui.button('primary', t('guide.restart'), { onclick: function () { mod.go(0); } })
            : ui.button('primary', t('guide.next') + ' →', { onclick: function () { mod.go(step + 1); } }),
        ]));
      }

      mod.watch(function (s) { drawNote(s.error); drawFoot(s.step, s.total); });
      // The module drew once before it had a watcher to tell.
      drawNote(null);
      drawFoot(mod.step(), mod.total);
      return page;
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.GuidesPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
