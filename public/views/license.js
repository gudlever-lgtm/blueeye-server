// public/views/license.js — License status, as a DashboardPage (template B)
// (docs/ui-contract.md).
//
// What this server is licensed for, what it is using of that, and what every
// plan would give it. Reached at /license and as the License section inside
// Settings; the second passes `mode: 'embedded'`.
//
// What this migration changes:
//   * the `.section-head` was an `<h2>` and a button. It is a PageHeader with
//     the licence's own state in template D's status slot — the state is the
//     whole subject of the page, so it belongs beside the title rather than in
//     the first cell of a grid below it;
//   * three `.cards` rows of `stat()` divs, each under a loose `<h3>`, held
//     sixteen figures with no order of importance: the licence's own status
//     next to the server id next to the support level. The four an
//     administrator acts on — agents, test paths, history, expiry — are a
//     StatStrip; the rest are one Panel of key/values, which is what a
//     reference block is;
//   * `.alert-banner sev-WARN` was a page-local banner component. The trust
//     misconfiguration is an InlineNote, and it says the same thing;
//   * the feature matrix was a `.tablewrap` + `table.matrix` with `.active` on
//     the current plan's cells. It is a DataTable; the current plan is named in
//     its column header rather than shaded, because a shaded column in a table
//     that already greys unentitled rows is two colours saying two things;
//   * a feature the plan does not include was a `muted` row with a `–`. It is
//     a dimmed row, which the DataTable already has, and the tick is a Badge
//     only where it is a state — "Roadmap" is, "✓" is not.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    // 'grace' is valid, and says so — it is not a warning until it runs out.
    var STATUS_TONE = {
      valid: 'ok', grace: 'warn', expired: 'crit', not_yet_valid: 'warn',
      invalid: 'crit', unlicensed: 'crit', unknown: 'neutral',
    };
    function statusLabel(s) {
      var k = 'lic.status.' + s;
      var v = t(k);
      return v === k ? String(s || 'unknown') : v;
    }
    function limit(v) { return (v === null || v === undefined) ? t('lic.unlimited') : String(v); }

    function view() {
      var embedded = deps.mode && deps.mode() === 'embedded';
      var page = ui.page();

      return deps.fetchAll().then(function (d) {
        var s = d.status;
        var plan = d.plan;
        var usage = d.usage;
        var matrix = d.matrix;
        var offline = s.mode === 'offline';

        var revalidate = deps.canWrite()
          ? ui.button('primary', t('lic.revalidate'), { onclick: function () { deps.refresh(); } })
          : null;
        var badge = ui.badge(STATUS_TONE[s.status] || 'neutral', statusLabel(s.status));

        if (embedded) {
          page.append(ui.toolbar({ filters: [badge], actions: [revalidate] }));
        } else {
          page.append(ui.pageHeader({
            title: t('lic.title'),
            status: badge,
            lead: plan
              ? t('lic.lead.plan', { plan: plan.plan_name, mode: offline ? t('lic.mode.offline') : t('lic.mode.online') })
              : t('lic.lead.bare', { mode: offline ? t('lic.mode.offline') : t('lic.mode.online') }),
            help: { title: deps.help().title, body: deps.help().body },
            actions: [revalidate],
          }));
        }

        // A misconfigured trust anchor makes every proof fail verification the
        // same way a genuinely bad proof would, so "Re-validate now" keeps
        // answering 200 while sitting on whatever was last cached. That looks
        // like "revalidation doesn't pick up licence changes" rather than
        // "verifying against the wrong public key", so it says so outright.
        var trust = s.publicKeyTrust;
        if (trust && (trust.source === 'blocked' || !trust.configured)) {
          page.append(ui.inlineNote(
            t('lic.trust.lead') + ' ' + (!trust.configured ? t('lic.trust.placeholder') : t('lic.trust.blocked')),
            'crit'));
        }
        if (offline && !s.licensed) page.append(ui.inlineNote(t('lic.restricted'), 'warn'));
        if (s.reason) page.append(ui.inlineNote(t('lic.reason', { reason: s.reason }), 'info'));

        // ---- the four figures somebody acts on ------------------------------
        function used(u) {
          if (!u) return null;
          if (u.max === null || u.max === undefined) return { value: u.used + ' / ∞' };
          var pct = u.max > 0 ? Math.round((u.used / u.max) * 100) : 0;
          return { value: u.used + ' / ' + u.max, tone: pct >= 90 ? 'crit' : (pct >= 75 ? 'warn' : undefined), pct: pct };
        }
        var agents = usage ? used(usage.agents) : (s.maxAgents != null ? { value: '– / ' + s.maxAgents } : null);
        var paths = usage ? used(usage.test_paths) : null;
        var days = usage ? usage.history_days : (plan ? plan.limits.history_days : undefined);
        if (agents || paths) {
          page.append(ui.statStrip([
            agents ? { value: agents.value, label: t('lic.kpi.agents'), tone: agents.tone } : null,
            paths ? { value: paths.value, label: t('lic.kpi.paths'), tone: paths.tone } : null,
            days === undefined ? null : { value: days === null ? '∞' : days, label: t('lic.kpi.history') },
            {
              // A date, not a timestamp: an expiry with a minute on it reads as
              // precision the licence does not have.
              value: s.validUntil ? ui.fmt.date(s.validUntil) : (s.licensed ? t('lic.perpetual') : '–'),
              label: t('lic.kpi.expires'),
            },
          ]));
          // The bar was the only thing the old usage card said that a number
          // does not, so it stays — under the strip, where a percentage of a
          // limit belongs.
          var bars = [agents, paths].filter(function (x) { return x && x.pct != null; });
          if (bars.length) {
            page.append(el('div', { class: 'lic-bars' }, bars.map(function (x) { return deps.usageBar(x.pct); })));
          }
        }

        // ---- the reference block --------------------------------------------
        page.append(ui.panel({
          title: t('lic.details'),
          children: [ui.keyValues([
            [t('lic.kv.licensed'), s.licensed ? t('lic.yes') : t('lic.no')],
            plan ? [t('lic.kv.plan'), 'BlueEyes ' + plan.plan_name + (plan.is_trial ? ' (' + t('lic.trial') + ')' : '')] : null,
            plan ? [t('lic.kv.support'), plan.support_level] : null,
            plan ? [t('lic.kv.maxAgents'), limit(plan.limits.max_agents)] : [t('lic.kv.maxAgents'), String(s.maxAgents)],
            plan ? [t('lic.kv.maxPaths'), limit(plan.limits.max_test_paths)] : null,
            [t('lic.kv.validation'), offline ? t('lic.mode.offlineLong') : t('lic.mode.onlineLong')],
            offline ? null : [t('lic.kv.serverId'), s.serverId || '–'],
            (offline && s.organizationId) ? [t('lic.kv.org'), s.organizationId] : null,
            [t('lic.kv.verified'), s.verifiedAt ? ui.fmt.short(s.verifiedAt) : '–'],
            // Grace is an online-only concept: running on a cached proof while
            // the licence server cannot be reached.
            offline ? null : [t('lic.kv.grace'), s.graceUntil ? ui.fmt.short(s.graceUntil) : '–'],
          ])],
          foot: ui.metaXs(t('lic.renew')),
        }));

        // ---- what every plan gives ------------------------------------------
        if (matrix) {
          var active = matrix.activePlan;
          var activePlan = matrix.plans.find(function (p) { return p.plan_key === active; });
          page.append(ui.panel({
            title: t('lic.matrix'),
            note: activePlan
              ? t('lic.matrixNote', { plan: activePlan.plan_name })
              : t('lic.matrixNoteBare'),
            children: [ui.dataTable({
              columns: [{ key: 'feature', label: t('lic.col.feature') }].concat(matrix.plans.map(function (p) {
                // The current plan is named in the panel note, not shaded and
                // not spelled out in the header: a shaded column in a table
                // that already dims unentitled rows is two colours saying two
                // different things, and "Professional (current)" is a header
                // that clips at any plan name longer than a word.
                return { key: p.plan_key, label: p.plan_name, width: '168px' };
              })),
              rows: matrix.features.map(function (f) {
                var roadmap = f.status === 'roadmap';
                var entitled = activePlan && activePlan.features[f.key];
                var cells = { feature: f.label };
                matrix.plans.forEach(function (p) {
                  var on = p.features[f.key];
                  // A roadmap feature is priced into the plan but not built
                  // yet: never a tick where the tier would include it.
                  cells[p.plan_key] = on
                    ? (roadmap ? ui.badge('info', t('lic.roadmap')) : '✓')
                    : ui.meta('–');
                });
                return { dimmed: !entitled || roadmap, cells: cells };
              }),
            })],
            foot: ui.metaXs(t('lic.matrixFoot')),
          }));
        }
        return page;
      }).catch(function (e) {
        var parts = [];
        if (!embedded) parts.push(ui.pageHeader({ title: t('lic.title') }));
        parts.push(ui.panel({ children: [ui.errorState({
          title: t('lic.err.title'),
          body: deps.errText(e),
          detail: 'GET /license/status',
          onRetry: function () { return deps.rerender(); },
        })] }));
        page.replaceChildren.apply(page, parts);
        return page;
      });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.LicensePage = apiObj;
})(typeof window !== 'undefined' ? window : null);
