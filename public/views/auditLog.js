// public/views/auditLog.js — the tamper-evident audit log, as a ListPage
// (template A) (docs/ui-contract.md).
//
// `audit_log` is the hash-chained trail (migration 041): every row carries the
// hash of the row before it, so an edited or deleted row breaks the chain from
// that point on. GET /api/audit-log lists it, /categories feeds the filter, and
// /verify walks the chain. Until this screen none of the three had a caller, so
// the one property the table exists for — that you can PROVE nobody rewrote it
// — could not be checked by anybody who does not use curl.
//
// Distinct from Reporting → Audit trail (the `audit_events` activity trail with
// recurrence folding): that one answers "who did what", this one answers "has
// the record of who did what been tampered with".
//
// The verdict is explained, not just coloured. "Broken at entry 812" is a row
// number; what an admin needs is which check failed — the row's own fields no
// longer hash to what was stored (it was edited), or it no longer points at the
// row before it (one was removed) — and what that means for the entries
// around it.
//
// Admin only, licence feature `audit_log`. A 403 from the plan gate is shown as
// "not in your plan", not as an error.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var LIMITS = ['100', '250', '500'];

    function outcomeBadge(outcome) {
      if (!outcome) return ui.meta('—');
      var o = String(outcome).toLowerCase();
      var tone = o === 'success' || o === 'ok' ? 'ok' : (o === 'failure' || o === 'denied' || o === 'error' ? 'crit' : 'neutral');
      return ui.badge(tone, String(outcome));
    }

    function actorOf(row) {
      if (row.actor_email) return row.actor_email;
      if (row.actor_user_id != null) return '#' + row.actor_user_id;
      return t('auditlog.system');
    }

    // The verdict, in words. `v` is the /verify answer.
    function verdictPanel(v, onShow) {
      if (v.ok) {
        return ui.panel({
          title: t('auditlog.verify.title'),
          children: [
            el('p', {}, ui.badge('ok', t('auditlog.verify.intact')), ' ',
              t('auditlog.verify.intactBody', { n: v.checked })),
            v.checked === 0 ? ui.inlineNote(t('auditlog.verify.empty')) : null,
            ui.inlineNote(t('auditlog.verify.legacy')),
          ],
        });
      }
      var why = v.reason === 'unlinked' ? t('auditlog.verify.unlinked', { id: v.brokenAt })
        : v.reason === 'altered' ? t('auditlog.verify.altered', { id: v.brokenAt })
          : t('auditlog.verify.unknownReason', { id: v.brokenAt });
      return ui.panel({
        title: t('auditlog.verify.title'),
        actions: [onShow ? ui.button('secondary', t('auditlog.verify.show', { id: v.brokenAt }), { size: 'xs', onclick: onShow }) : null],
        children: [
          el('p', {}, ui.badge('crit', t('auditlog.verify.broken', { id: v.brokenAt }))),
          el('p', {}, why),
          el('p', {}, t('auditlog.verify.meaning', { id: v.brokenAt, n: v.checked })),
          ui.inlineNote(t('auditlog.verify.next'), 'warn'),
        ],
      });
    }

    function openRow(row, tr) {
      ui.openDrawer({
        title: t('auditlog.entry', { id: row.id }),
        status: outcomeBadge(row.outcome),
        meta: ui.fmt.abs(row.created_at),
        row: tr,
        sections: [
          ui.drawerSection(t('auditlog.drawer.what'), ui.keyValues([
            [t('auditlog.col.category'), row.category || '—'],
            [t('auditlog.col.action'), row.action || '—'],
            [t('auditlog.col.target'), row.target || '—'],
            [t('auditlog.col.detail'), row.detail || '—'],
          ])),
          ui.drawerSection(t('auditlog.drawer.who'), ui.keyValues([
            [t('auditlog.col.actor'), actorOf(row)],
            [t('auditlog.drawer.role'), row.actor_role || '—'],
            [t('auditlog.drawer.ip'), row.ip || '—'],
            [t('auditlog.col.when'), ui.fmt.abs(row.created_at)],
          ])),
        ],
      });
    }

    function view() {
      var state = deps.state;
      if (state.category == null) state.category = '';
      if (!state.limit) state.limit = '100';

      var page = ui.page();
      var verdictHost = el('div', {});
      var toolbarHost = el('div', {});
      var bodyHost = el('div', {});
      var verifyBtn = ui.button('primary', t('auditlog.verify.run'), { onclick: verify });

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('auditlog.title'),
        lead: t('auditlog.lead'),
        help: { title: info.title, body: info.body },
        actions: [verifyBtn],
      }), verdictHost, toolbarHost, bodyHost);

      function notInPlan() {
        return ui.panel({
          children: [ui.emptyState({ title: t('auditlog.notInPlan'), body: t('auditlog.notInPlanHint') })],
        });
      }

      // Drawn with no categories first, refilled once /categories answers.
      function drawToolbar(categories) {
        var catSel = ui.select({
          label: t('auditlog.col.category'),
          value: state.category,
          options: [['', t('auditlog.allCategories')]].concat((categories || []).map(function (c) { return [c, c]; })),
          onchange: function (e) { state.category = e.target.value; load(); },
        });
        var limitSel = ui.select({
          label: t('auditlog.limit'),
          value: state.limit,
          options: LIMITS.map(function (n) { return [n, n]; }),
          onchange: function (e) { state.limit = e.target.value; load(); },
        });
        toolbarHost.replaceChildren(ui.toolbar({
          filters: [ui.filter(t('auditlog.col.category'), catSel), ui.filter(t('auditlog.limit'), limitSel)],
          actions: [ui.button('secondary', t('auditlog.refresh'), { onclick: load })],
        }));
      }

      function load() {
        bodyHost.replaceChildren(ui.panel({ children: [ui.loadingState(6)] }));
        return deps.fetchEntries({ category: state.category, limit: state.limit }).then(function (rows) {
          var list = Array.isArray(rows) ? rows : [];
          if (!list.length) {
            bodyHost.replaceChildren(ui.panel({
              children: [ui.emptyState({
                kind: state.category ? 'nodata' : 'none',
                title: t('auditlog.empty'),
                body: state.category ? null : t('auditlog.emptyHint'),
              })],
            }));
            return;
          }
          bodyHost.replaceChildren(ui.panel({
            title: t('auditlog.entries'),
            note: t('auditlog.shown', { n: list.length }),
            children: [ui.dataTable({
              columns: [
                { key: 'id', label: '#', width: '72px', num: true },
                { key: 'when', label: t('auditlog.col.when'), width: '130px', time: true },
                { key: 'category', label: t('auditlog.col.category'), width: '120px' },
                { key: 'action', label: t('auditlog.col.action') },
                { key: 'outcome', label: t('auditlog.col.outcome'), width: '110px' },
                { key: 'actor', label: t('auditlog.col.actor') },
                { key: 'target', label: t('auditlog.col.target') },
              ],
              rows: list.map(function (r) {
                return {
                  key: r.id,
                  data: r,
                  cells: {
                    id: String(r.id),
                    when: ui.fmt.short(r.created_at),
                    category: r.category || '—',
                    action: r.action || '—',
                    outcome: outcomeBadge(r.outcome),
                    actor: actorOf(r),
                    target: r.target ? ui.meta(r.target) : ui.meta('—'),
                  },
                };
              }),
              onOpen: function (row, tr) { openRow(row.data, tr); },
            })],
          }));
        }).catch(function (e) {
          if (e && e.status === 403) { bodyHost.replaceChildren(notInPlan()); return; }
          bodyHost.replaceChildren(ui.panel({
            children: [ui.errorState({
              title: t('auditlog.err.title'), body: deps.errText(e),
              detail: 'GET /api/audit-log', onRetry: load,
            })],
          }));
        });
      }

      function verify() {
        verifyBtn.disabled = true;
        verdictHost.replaceChildren(ui.panel({
          title: t('auditlog.verify.title'),
          children: [ui.inlineNote(t('auditlog.verify.running'))],
        }));
        return deps.verify().then(function (v) {
          // The row that broke is most likely outside the newest page, so
          // "show" widens to the category it is in by clearing the filter and
          // taking the largest page; the # column names it.
          verdictHost.replaceChildren(verdictPanel(v || {}, v && !v.ok ? function () {
            state.category = '';
            state.limit = LIMITS[LIMITS.length - 1];
            drawToolbar(state.categories);
            load();
          } : null));
        }).catch(function (e) {
          if (e && e.status === 403) { verdictHost.replaceChildren(notInPlan()); return; }
          verdictHost.replaceChildren(ui.panel({
            children: [ui.errorState({
              title: t('auditlog.verify.err'), body: deps.errText(e),
              detail: 'GET /api/audit-log/verify', onRetry: verify,
            })],
          }));
        }).then(function () { verifyBtn.disabled = false; });
      }

      drawToolbar(state.categories || []);
      deps.fetchCategories().then(function (cats) {
        state.categories = Array.isArray(cats) ? cats : [];
        drawToolbar(state.categories);
      }).catch(function () { /* the filter stays "All categories" */ });
      load();
      return Promise.resolve(page);
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.AuditLogPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
