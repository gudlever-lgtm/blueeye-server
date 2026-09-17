// public/views/location.js — one location, as a DetailPage (template D).
//
// A site's page: how its agents are doing, which of them are there, and where
// its traffic goes. Built from the contract's components (public/ui.js,
// docs/ui-contract.md).
//
// What this migration changes:
//   * the heading was a `.section-head` with a Back button, an `<h2>` with a 📍
//     glued to the name, the description, the coordinates, a spacer and four
//     more buttons. It is a PageHeader: the name, the description and the
//     coordinates as the lead, and the actions where actions go with Edit as
//     the one primary;
//   * the six `kpiCard`s in a `.noc-kpis` row are a StatStrip. Each one carried
//     a label and a sub-line ("Agents" over "online at this site"); the strip
//     has one label, so the two became one — "Agents online", "Median latency",
//     "Worst packet loss";
//   * the agents table had **ten** columns, two of which said the same thing:
//     Connection is the socket and Health is derived from it, so `down` and
//     `offline` were always the same row. Connection went, and with it Targets
//     and Version, which are both on the agent's own page — the row opens it;
//   * "No agents at this location yet" was a grey sentence in a card. A site
//     with nobody at it is the normal state of a site somebody has just added,
//     so it says what to do about it.
//
// The traffic map and the data-flow list are NOT migrated: the map carries the
// reader's pan and zoom, and the flow rows use the traffic-type colour ramp.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var HEALTH_TONE = { ok: 'ok', warn: 'warn', bad: 'crit', down: 'crit', stale: 'neutral', unknown: 'neutral' };
    function healthLabel(s) {
      var k = 'ld.health.' + (s || 'unknown');
      var v = t(k);
      return v === k ? String(s || 'unknown') : v;
    }

    function view() {
      var id = deps.id();
      var page = ui.page();

      function back() {
        return ui.button('secondary', t('ld.back'), { onclick: function () { deps.openList(); } });
      }

      if (id == null) {
        page.append(
          ui.pageHeader({ title: t('ld.title'), actions: [back()] }),
          ui.panel({ children: [ui.emptyState({ title: t('ld.noneSelected'), body: t('ld.noneSelectedHint') })] }));
        return Promise.resolve(page);
      }

      return deps.fetchAll(id).then(function (d) {
        var loc = d.location;
        var members = d.members;
        var scoped = d.scoped;
        var byId = d.byId;

        page.append(ui.pageHeader({
          title: loc.name,
          lead: el('span', {},
            loc.description ? loc.description : ui.meta(t('ld.noDescription')),
            loc.latitude != null
              ? ui.meta(' · ' + Number(loc.latitude).toFixed(3) + ', ' + Number(loc.longitude).toFixed(3))
              : ui.meta(' · ' + t('ld.noCoords'))),
          help: { title: t('ld.info.title'), body: function () { return deps.helpBody(); } },
          actions: [
            ui.button('secondary', t('ld.liveTraffic'), { onclick: function () { deps.traffic(loc); } }),
            deps.hasAssistant()
              ? ui.button('secondary', t('ld.ai'), { onclick: function () { deps.summary(loc); } })
              : null,
            deps.canWrite()
              ? ui.button('primary', t('ld.edit'), { onclick: function () { deps.edit(loc); } })
              : null,
            back(),
          ],
        }));

        // ---- the site's health, in the same language the Overview uses ------
        var k = deps.kpis(scoped);
        // The denominator is the site's roster, not how many of its agents the
        // health read happened to know about. A read that failed, or one that
        // has not caught up with an agent enrolled a minute ago, used to shrink
        // the site instead of reporting nobody online.
        var total = members.length;
        page.append(ui.statStrip([
          {
            value: k.online + '/' + total, label: t('ld.kpi.agents'),
            tone: total && k.online === 0 ? 'crit' : (k.online < total ? 'warn' : undefined),
          },
          { value: k.latency == null ? '–' : k.latency + ' ms', label: t('ld.kpi.latency') },
          {
            value: k.loss == null ? '–' : k.loss + '%', label: t('ld.kpi.loss'),
            tone: k.loss == null ? undefined : (k.loss >= 20 ? 'crit' : (k.loss >= 2 ? 'warn' : undefined)),
          },
          {
            value: k.jitter == null ? '–' : k.jitter + ' ms', label: t('ld.kpi.jitter'),
            tone: k.jitter >= 30 ? 'warn' : undefined,
          },
          { value: k.paths, label: t('ld.kpi.paths') },
          {
            value: k.alerts, label: t('ld.kpi.alerts'),
            tone: k.crit ? 'crit' : (k.warn ? 'warn' : undefined),
            title: k.crit ? t('ld.kpi.critHint', { n: k.crit }) : (k.warn ? t('ld.kpi.warnHint', { n: k.warn }) : t('ld.kpi.clear')),
          },
        ]));

        // ---- who is here ----------------------------------------------------
        page.append(ui.panel({
          title: t('ld.agents'),
          note: t('ld.agentCount', { n: members.length }),
          children: [members.length
            ? ui.dataTable({
              columns: [
                { key: 'agent', label: t('ld.col.agent') },
                // Connection went: Health is derived from it, so `down` and
                // `offline` were always the same row said twice.
                // "degraded" is the longest label the badge carries; at 116px it clipped.
                { key: 'health', label: t('ld.col.health'), width: '134px' },
                { key: 'loss', label: t('ld.col.loss'), width: '96px', num: true },
                { key: 'latency', label: t('ld.col.latency'), width: '124px', num: true },
                { key: 'jitter', label: t('ld.col.jitter'), width: '104px', num: true },
                { key: 'throughput', label: t('ld.col.throughput'), width: '140px', num: true },
                { key: 'last', label: t('ld.col.last'), width: '148px', time: true },
              ],
              rows: members.map(function (m) {
                var a = byId.get(m.id);
                var h = a && a.health;
                var met = (h && h.metrics) || {};
                return {
                  m: m,
                  cells: {
                    agent: m.display_name || m.hostname,
                    health: h ? ui.badge(HEALTH_TONE[h.status] || 'neutral', healthLabel(h.status)) : ui.meta('–'),
                    loss: met.lossPct != null ? met.lossPct + '%' : '–',
                    latency: deps.latencyText(met),
                    jitter: met.jitterMs != null ? met.jitterMs + ' ms' : '–',
                    throughput: deps.throughputText(a && a.throughput),
                    last: ui.meta(m.last_seen ? ui.fmt.short(m.last_seen) : '–'),
                  },
                };
              }),
              onOpen: function (r) { deps.openAgent(r.m.id); },
            })
            : ui.emptyState({
              icon: '◎',
              title: t('ld.noAgents'),
              body: t('ld.noAgentsHint'),
              action: ui.button('secondary', t('ld.enrol'), { onclick: function () { deps.openEnrollment(); } }),
            })],
        }));

        // ---- where its traffic goes ----------------------------------------
        // The map and the flow list are the module's; they carry the reader's
        // pan and zoom and the traffic-type colour ramp.
        page.append(ui.panelGrid.apply(null, deps.flows(loc, id)));
        return page;
      }).catch(function (e) {
        var notFound = e && e.status === 404;
        page.replaceChildren(
          ui.pageHeader({ title: t('ld.title'), actions: [back()] }),
          ui.panel({
            children: [ui.errorState({
              title: notFound ? t('ld.notFound', { id: id }) : t('ld.err.title'),
              body: notFound ? t('ld.notFoundHint') : deps.errText(e),
              detail: 'GET /locations',
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
  if (root) root.LocationPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
