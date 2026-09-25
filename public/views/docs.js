// public/views/docs.js — Documentation, as a ListPage (template A)
// (docs/ui-contract.md). A SHELL migration: the twenty-four article bodies
// stay in app.js and are passed in whole.
//
// What this migration changes:
//   * the topic picker was `.settings-nav` — three groups of `.small ghost`
//     buttons with an `.active` class. That is twenty-three buttons pretending
//     to be tabs, which the contract forbids outright, and it was the same
//     markup Settings used before 3.24. It is **two levels of SubTabs**, the
//     same as Settings: the three sections, then the articles in the section
//     you are in;
//   * the rail sat between the heading and the article, so the article started
//     a screen down the page. The strips are two rows;
//   * `.section-head` with an `<h2>` and a grey subtitle is a PageHeader;
//   * **the topic had no address.** Every article was `/docs`, so a link to
//     "how I find out why a site is unhealthy" was a link to "Documentation,
//     scroll down and click". It is `/docs/<topic>` now, and the section above
//     it is derived from the article, so an old `/docs` link still opens the
//     first one;
//   * an article whose body threw replaced it with a red `.empty error` box on
//     the page. It is an ErrorState in the panel, with the article still
//     selected and a Retry.
//
// **Deviation from the contract, recorded deliberately:** two SubTabs rows on
// one screen, for the reason Settings and Reporting have two — the second level
// belongs to the thing the first level selected. Twenty-three tabs in one row
// is what the wrapped buttons were.
//
// Not migrated: the article bodies. They are prose built by docsLead /
// docsSteps / docsTable / docsCode / docsExpect, and they are hardcoded English
// — a translation job of its own, not a layout one.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    function view() {
      var sections = deps.sections();
      var active = deps.topic();

      function find(id) {
        for (var i = 0; i < sections.length; i++) {
          for (var j = 0; j < sections[i].articles.length; j++) {
            if (sections[i].articles[j].id === id) return { si: i, article: sections[i].articles[j] };
          }
        }
        return null;
      }

      // An article the reader can no longer reach — an admin-only one, after a
      // role change, or an id from an older build — falls back to the first
      // rather than rendering an empty page.
      var hit = find(active);
      if (!hit) {
        if (!sections.length) {
          var bare = ui.page();
          bare.append(
            ui.pageHeader({ title: t('docs.title'), lead: t('docs.lead') }),
            ui.panel({ children: [ui.emptyState({ title: t('docs.none'), body: t('docs.noneHint') })] }));
          return Promise.resolve(bare);
        }
        active = sections[0].articles[0].id;
        deps.setTopic(active);
        hit = find(active);
      }
      var si = hit.si;

      var page = ui.page();
      var sectionHost = el('div', {});
      var articleHost = el('div', {});
      var bodyHost = el('div', {});

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('docs.title'),
        lead: t('docs.lead'),
        help: { title: info.title, body: info.body },
      // Each is a direct child of the page, so the page's own column gap
      // separates them — two strips and a body inside one wrapper would touch.
      }), sectionHost, articleHost, bodyHost);

      function drawSections() {
        sectionHost.replaceChildren(ui.tabs(sections.map(function (s, i) { return [String(i), s.section]; }), {
          active: String(si),
          ariaLabel: t('docs.sections'),
          // Moving section opens that section's first article — a strip with
          // nothing selected under it is a strip with no page behind it.
          onPick: function (key) { si = Number(key); open(sections[si].articles[0].id); },
        }));
      }

      function drawArticles() {
        articleHost.replaceChildren(ui.tabs(sections[si].articles.map(function (a) { return [a.id, a.title]; }), {
          active: active,
          ariaLabel: sections[si].section,
          onPick: open,
        }));
      }

      function open(id) {
        var found = find(id);
        if (!found) return;
        active = id;
        si = found.si;
        deps.setTopic(id);
        drawSections();
        drawArticles();
        drawBody();
      }

      function drawBody() {
        var found = find(active);
        var article = found.article;
        var children;
        try {
          children = article.body();
        } catch (e) {
          bodyHost.replaceChildren(ui.panel({
            title: article.title,
            children: [ui.errorState({
              title: t('docs.err.title', { article: article.title }),
              body: deps.errText(e),
              onRetry: drawBody,
            })],
          }));
          return;
        }
        bodyHost.replaceChildren(ui.panel({
          title: article.title,
          children: [el('article', { class: 'docs-article' }, children)],
        }));
      }

      drawSections();
      drawArticles();
      drawBody();
      return Promise.resolve(page);
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.DocsPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
