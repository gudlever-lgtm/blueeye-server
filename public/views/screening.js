// public/views/screening.js — Test Settings, as a ListPage (template A)
// (docs/ui-contract.md).
//
// Every integration, alert channel and outbound dependency this server has, with
// what it is configured as and — for the ones that can be tested — what happened
// when it last was. Reached at /test-settings and as the Screening section
// inside Settings; the second passes `mode: 'embedded'`.
//
// What this migration changes:
//   * the `.section-head` was an `<h2>`, a `.spacer` and a button. It is a
//     PageHeader with "Run full screening" as the one primary;
//   * the summary was four `.badge`s reading "Targets: 31", "OK: 24",
//     "Warnings: 5", "Critical: 2". A badge is a state, and a count is not —
//     they were a strip of counts wearing a state's clothes. It is a StatStrip,
//     and because a StatStrip filters, clicking Critical now shows the two
//     rather than leaving the reader to find them;
//   * a group was a `.settings-card` with an `<h3>`, holding `.screen-row`s
//     three lines tall: a badge, a name, a mono detail, a wrapped row of
//     `.screen-chip`s, a result line, and two controls stacked at the right.
//     A group is a Panel and a target is one DataTable row; the per-check
//     verdicts and the full result move into the Drawer the row opens;
//   * `.screen-chip` carried "TLS: OK", "Auth: Warning" — a label and a verdict
//     in a pill, which is what the contract's Badge-vs-metadata rule is about.
//     In the drawer they are key/values: the label is the key, the verdict is a
//     Badge, and the note that was only a `title=` tooltip is readable text;
//   * "Loading…" was a grey word. It is a LoadingState, and a failed catalogue
//     read is an ErrorState with a Retry instead of red text on the page.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var SEV_TONE = { ok: 'ok', info: 'info', warn: 'warn', bad: 'crit' };
    function sevLabel(s) { return t('scr.sev.' + s) === 'scr.sev.' + s ? String(s) : t('scr.sev.' + s); }

    function view() {
      var embedded = deps.mode && deps.mode() === 'embedded';
      var catalog = [];
      var groupOrder = [];
      var results = new Map(); // target id -> last run result
      var filter = null;       // a severity from the strip, or null for all
      var running = false;

      var page = ui.page();
      var stripHost = el('div', {});
      var bodyHost = el('div', {});
      var runBtn = ui.button('primary', t('scr.runAll'), { onclick: runAll });

      if (embedded) {
        page.append(ui.toolbar({ actions: [runBtn] }));
      } else {
        page.append(ui.pageHeader({
          title: t('scr.title'),
          lead: t('scr.lead'),
          help: { title: deps.help().title, body: deps.help().body },
          actions: [runBtn],
        }));
      }
      page.append(stripHost, bodyHost);

      function sevOf(target) {
        var r = results.get(target.id);
        return r ? r.severity : target.posture;
      }

      function drawStrip() {
        var counts = { ok: 0, info: 0, warn: 0, bad: 0 };
        catalog.forEach(function (x) { counts[sevOf(x)] += 1; });
        function card(key, label, tone) {
          return {
            value: counts[key], label: label, tone: counts[key] ? tone : undefined,
            active: filter === key,
            onclick: function () { filter = filter === key ? null : key; drawStrip(); drawBody(); },
          };
        }
        stripHost.replaceChildren(ui.statStrip([
          // The total is not a filter — clicking it clears, which is what the
          // strip does to an active card anyway.
          {
            value: catalog.length, label: t('scr.kpi.targets'), active: filter === null,
            onclick: function () { filter = null; drawStrip(); drawBody(); },
          },
          card('ok', t('scr.kpi.ok'), 'ok'),
          card('warn', t('scr.kpi.warn'), 'warn'),
          card('bad', t('scr.kpi.bad'), 'crit'),
        ]));
      }

      // What the last run said, as one line. A target with no live test says so
      // rather than leaving the column blank and looking like it never ran.
      function resultText(target) {
        var r = results.get(target.id);
        // The cell says it short; the drawer says it in full. The long sentence
        // ("Configuration screened only — no live test for this target.") used
        // to be the widest thing in the column by a factor of three.
        if (!r) return target.runnable ? ui.meta(t('scr.notRun')) : ui.meta(t('scr.noLiveTest'));
        var parts = [];
        if (r.ran) parts.push(r.ok ? '✓' : '✗');
        if (r.detail) parts.push(r.detail);
        if (r.ran && r.durationMs != null) parts.push(r.durationMs + ' ms');
        return parts.join(' · ');
      }

      function openTarget(target) {
        var r = results.get(target.id);
        var checks = target.security || [];
        ui.openDrawer({
          title: target.name,
          status: ui.badge(SEV_TONE[sevOf(target)] || 'neutral', sevLabel(sevOf(target))),
          meta: target.group,
          sections: [
            target.detail ? ui.drawerSection(t('scr.what'), el('p', {}, target.detail)) : null,
            // The verdicts that were pills with a tooltip. The note is the half
            // that says what to do about it, and it was only ever a `title=`.
            checks.length ? ui.drawerSection(t('scr.checks'), ui.keyValues(checks.map(function (c) {
              return [c.label, el('span', {},
                ui.badge(SEV_TONE[c.status] || 'neutral', sevLabel(c.status)),
                c.note ? ui.meta(' ' + c.note) : null)];
            }))) : null,
            ui.drawerSection(t('scr.lastRun'), r
              ? ui.keyValues([
                [t('scr.kv.outcome'), r.ran ? (r.ok ? t('scr.passed') : t('scr.failed')) : t('scr.notRun')],
                r.detail ? [t('scr.kv.detail'), r.detail] : null,
                (r.ran && r.durationMs != null) ? [t('scr.kv.took'), r.durationMs + ' ms'] : null,
              ])
              : el('p', { class: 'muted' }, target.runnable ? t('scr.notRunHint') : t('scr.configOnly'))),
          ],
          footer: ui.drawerFooter(
            [target.runnable && target.licensed !== false
              ? ui.button('primary', t('scr.run'), { onclick: function () { ui.closeDrawer(); runTargets([target.id]); } })
              : null],
            [deps.setupLink(target)]),
        });
      }

      function rowFor(target) {
        var sev = sevOf(target);
        var canRun = target.runnable && target.licensed !== false;
        return {
          target: target,
          cells: {
            status: ui.badge(SEV_TONE[sev] || 'neutral', sevLabel(sev)),
            name: target.name,
            where: target.detail ? ui.meta(target.detail) : ui.meta('—'),
            result: resultText(target),
            act: ui.rowActions(
              canRun ? { label: t('scr.run'), onclick: function () { runTargets([target.id]); } } : null,
              [{ label: t('scr.details'), onclick: function () { openTarget(target); } }]),
          },
        };
      }

      function drawBody() {
        var shown = catalog.filter(function (x) { return !filter || sevOf(x) === filter; });
        if (!shown.length) {
          bodyHost.replaceChildren(ui.panel({ children: [ui.emptyState({
            title: filter ? t('scr.noneInFilter', { sev: sevLabel(filter) }) : t('scr.none'),
            body: filter ? t('scr.noneInFilterHint') : t('scr.noneHint'),
            action: filter
              ? ui.button('secondary', t('scr.clearFilter'), { onclick: function () { filter = null; drawStrip(); drawBody(); } })
              : null,
          })] }));
          return;
        }
        var byGroup = new Map();
        shown.forEach(function (x) {
          if (!byGroup.has(x.group)) byGroup.set(x.group, []);
          byGroup.get(x.group).push(x);
        });
        var order = groupOrder.length
          ? groupOrder.map(function (g) { return g.label; })
          : Array.from(byGroup.keys());
        var panels = [];
        order.forEach(function (label) {
          var items = byGroup.get(label);
          if (!items || !items.length) return;
          panels.push(ui.panel({
            title: label,
            children: [ui.dataTable({
              columns: [
                { key: 'status', label: t('scr.col.status'), width: '116px' },
                { key: 'name', label: t('scr.col.target'), width: '262px' },
                // Which host this actually talks to. Two webhook targets are
                // the same row without it.
                { key: 'where', label: t('scr.col.where'), width: '244px' },
                { key: 'result', label: t('scr.col.result') },
                { key: 'act', label: '', width: '104px' },
              ],
              rows: items.map(rowFor),
              onOpen: function (r) { openTarget(r.target); },
            })],
          }));
        });
        bodyHost.replaceChildren.apply(bodyHost, panels);
      }

      function setRunning(on) {
        running = on;
        if (on) runBtn.setAttribute('disabled', 'disabled');
        else runBtn.removeAttribute('disabled');
        runBtn.textContent = on ? t('scr.running') : t('scr.runAll');
      }

      function runTargets(ids) {
        return deps.run(ids).then(function (data) {
          (data.targets || []).forEach(function (x) { results.set(x.id, x.result); });
          drawStrip();
          drawBody();
          return data;
        }).catch(function (e) { deps.toast(deps.errText(e), true); });
      }

      function runAll() {
        if (running) return;
        setRunning(true);
        return runTargets(null).then(function (data) {
          setRunning(false);
          if (!data || !data.summary) return;
          var bad = data.summary.bad || 0;
          var warn = data.summary.warn || 0;
          deps.toast(t('scr.done', { bad: bad, warn: warn }), bad > 0);
        }).catch(function () { setRunning(false); });
      }

      bodyHost.replaceChildren(ui.panel({ children: [ui.loadingState(6)] }));
      return deps.fetchAll().then(function (data) {
        catalog = data.targets || [];
        groupOrder = data.groups || [];
        drawStrip();
        drawBody();
        return page;
      }).catch(function (e) {
        stripHost.replaceChildren();
        bodyHost.replaceChildren(ui.panel({ children: [ui.errorState({
          title: t('scr.err.title'),
          body: deps.errText(e),
          detail: 'GET /api/diagnostics/targets',
          onRetry: function () { return deps.rerender(); },
        })] }));
        return page;
      });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.ScreeningPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
