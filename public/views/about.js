// public/views/about.js — the About page, as a ListPage (template A)
// (docs/ui-contract.md).
//
// What this build is, and what the product grew into. The history itself is
// data and lives in public/about.js; this is the screen that draws it.
//
// What this migration changes:
//   * the `.section-head`, the accent-bordered `.about-build` box and a lead
//     paragraph were three stacked blocks of page chrome. They are one
//     PageHeader: the title, and the build this host runs as its lead. The
//     framing sentence moved into the (?) popover, where page background
//     belongs, and the subtitle went — it said what the title and the lead
//     already said;
//   * the filter row was seven `.chip`s carrying a count each. A count you
//     click to filter by is a StatStrip, which is what the contract has for
//     it. The "Everything" chip went with them: clicking the active card
//     clears the filter, the same gesture as everywhere else;
//   * `.about-month` was a hand-rolled section heading with its own rule and
//     letter-spacing. A month is a Panel now, with the number of entries in it
//     as the panel note — so the separate `.about-count` line went too;
//   * the version was a `.badge`. A version is metadata, not a state.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;
    var data = deps.data;
    var locale = deps.locale || 'en';
    var text = function (entry) { return entry[locale] || entry.en; };
    var plural = deps.plural || function (key, n) { return String(n); };

    var page = ui.page();
    page.classList.add('about');
    var area = 'all';

    // The build line answers "what am I actually talking to?", so it leads the
    // page. The version and its release date come from GET /system/version —
    // the same pair the sidebar foot is stamped with — so the page can never
    // claim a build the server is not on. A failed read costs the pair, never
    // the history, which is the point of the page.
    function buildLead() {
      return el('span', { class: 'about-build' },
        el('strong', {}, 'BlueEyes Network Resilience System'),
        ui.meta(' · ' + (deps.version ? 'v' + deps.version : '—')),
        ui.meta(' · ' + (deps.releaseDate
          ? t('about.build.released', { date: deps.releaseDate })
          : t('about.build.unknownDate'))));
    }

    var head = ui.pageHeader({
      title: t('about.title'),
      lead: buildLead(),
      help: { title: deps.help().title, body: deps.help().body },
    });

    var strip = el('div', { class: 'about-filters' });
    var list = el('div', { class: 'about-timeline' });

    function counts(key) {
      return data.RELEASES.filter(function (e) { return e.area === key; }).length;
    }

    function drawStrip() {
      strip.replaceChildren(ui.statStrip(data.AREAS.map(function (key) {
        return {
          value: counts(key),
          label: t(data.AREA_KEYS[key]),
          active: key === area,
          // Clicking the card you are already filtered by clears it, which is
          // what the "Everything" chip used to be for.
          onclick: function () { area = area === key ? 'all' : key; draw(); },
        };
      })));
    }

    function entry(e) {
      var body = text(e);
      return el('li', { class: 'about-item' },
        el('div', { class: 'about-item-meta' },
          el('span', { class: 'meta about-ver' }, 'v' + e.v),
          el('span', { class: 'about-area' }, t(data.AREA_KEYS[e.area]))),
        el('div', { class: 'about-item-body' },
          el('div', { class: 'about-item-title' }, body.t),
          el('div', { class: 'about-item-sum muted' }, body.s)));
    }

    function drawList() {
      var shown = data.RELEASES.filter(function (e) { return area === 'all' || e.area === area; });
      if (!shown.length) {
        list.replaceChildren(ui.panel({ children: [ui.emptyState({
          title: t('about.none'), body: t('about.noneHint'),
        })] }));
        return;
      }
      list.replaceChildren.apply(list, data.byMonth(shown).map(function (group) {
        return ui.panel({
          title: data.monthLabel(group.bucket, locale),
          note: plural('about.count', group.items.length, { count: String(group.items.length) }),
          children: [el('ol', { class: 'about-items' }, group.items.map(entry))],
        });
      }));
    }

    function draw() { drawStrip(); drawList(); }

    draw();
    page.append(head, strip, list,
      el('p', { class: 'meta about-foot' }, t('about.foot')));
    return page;
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.AboutPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
