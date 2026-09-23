// public/views/coverage.js — Coverage gaps, as a DashboardPage (template B).
//
// "Which parts of the network do I NOT see?" Every gap comes from GET
// /api/coverage (src/coverage/), with the numbers it was decided on and a
// suggested next step; this screen only says it in the reader's language.
//
// Layout: a StatStrip of counts (clicking a scope narrows the list to it),
// one Panel per gap kind with a DataTable of what / evidence / next step, and
// a "What was checked" panel that is ALWAYS drawn. The last one is the point:
// "no gaps" means nothing more than "none of the checks that could run found
// one", and a check whose source could not be read is shown as not checked
// rather than folded into a reassuring empty state.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var SCOPES = ['site', 'agent', 'device', 'subnet'];
    var CHECK_TONE = { ok: 'ok', partial: 'warn', skipped: 'neutral' };
    // Evidence fields that are timestamps, shown as "4 min ago".
    var TIME_FIELDS = ['lastSeen', 'lastReportAt', 'lastFlowAt', 'lastOkAt', 'lastPolledAt'];

    // A key this build has no string for falls back to the raw value rather
    // than rendering the key itself.
    function tr(key, params, fallback) {
      var v = t(key, params || {});
      return v === key ? (fallback == null ? '' : String(fallback)) : v;
    }

    // The server's evidence, made readable: times relative, lists joined,
    // unknowns as a dash. The catalogue string decides which of them to show.
    function evidenceParams(ev) {
      var out = {};
      var src = ev || {};
      Object.keys(src).forEach(function (k) {
        var v = src[k];
        if (TIME_FIELDS.indexOf(k) >= 0) out[k] = v ? ui.fmt.rel(v) : t('coverage.never');
        else if (k === 'topPorts') {
          out[k] = (v || []).map(function (p) { return p.ifName + ' (' + p.macs + ')'; }).join(', ') || '—';
        } else if (k === 'seenBy') {
          out[k] = (v || []).map(function (s) { return s.port ? s.label + ' ' + s.port : s.label; }).join(', ') || '—';
        } else if (v == null || v === '') out[k] = '—';
        else out[k] = String(v);
      });
      return out;
    }

    function view() {
      var state = deps.state;
      if (!state.scope) state.scope = '';

      var page = ui.page();
      var stripHost = el('div', {});
      var noteHost = el('div', {});
      var listHost = el('div', {});
      var checksHost = el('div', {});
      var report = null;

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('coverage.title'),
        lead: t('coverage.lead'),
        help: { title: info.title, body: info.body },
        actions: [ui.button('secondary', t('coverage.refresh'), { onclick: function () { load(); } })],
      }), stripHost, noteHost, listHost, checksHost);

      function drawStrip() {
        var s = report.summary || {};
        var byScope = s.byScope || {};
        var cards = [
          {
            value: s.total || 0, label: t('coverage.stat.total'), active: !state.scope,
            onclick: function () { state.scope = ''; drawAll(); },
          },
          // Not a filter: warnings sit inside every scope, so this card just
          // shows the whole list again, warnings first in each group.
          {
            value: s.warn || 0, label: t('coverage.stat.warn'), tone: s.warn ? 'warn' : undefined,
            onclick: function () { state.scope = ''; drawAll(); },
          },
        ].concat(SCOPES.map(function (scope) {
          return {
            value: byScope[scope] || 0,
            label: t('coverage.scope.' + scope),
            active: state.scope === scope,
            title: t('coverage.stat.filterHint'),
            onclick: function () {
              state.scope = state.scope === scope ? '' : scope;
              drawAll();
            },
          };
        }));
        stripHost.replaceChildren(ui.statStrip(cards));
      }

      function subjectCell(g) {
        var label = String(g.subject && g.subject.label != null ? g.subject.label : '—');
        var id = g.subject && g.subject.id;
        if (g.scope === 'site' && id != null && typeof id === 'number') {
          return ui.hostLink(label, function () { deps.go({ view: 'location', id: id }); });
        }
        if (g.scope === 'agent') return ui.hostLink(label, function () { deps.go({ view: 'agent', id: id }); });
        if (g.scope === 'device' && g.link && g.link.view === 'snmpDevice') {
          return ui.hostLink(label, function () { deps.go(g.link); });
        }
        return el('span', {}, label);
      }

      function kindPanel(kind, rows) {
        var s = report.summary || {};
        var total = (s.byKind || {})[kind] || rows.length;
        var hidden = (report.truncated || {})[kind] || 0;
        var warn = rows.some(function (g) { return g.severity === 'warn'; });
        var table = ui.dataTable({
          columns: [
            { key: 'subject', label: t('coverage.col.subject'), width: '22%' },
            { key: 'evidence', label: t('coverage.col.evidence') },
            { key: 'suggestion', label: t('coverage.col.suggestion') },
            { key: 'act', label: '', width: '120px' },
          ],
          rows: rows.map(function (g) {
            var params = evidenceParams(g.evidence);
            return {
              key: g.kind + ':' + (g.subject && g.subject.id),
              cells: {
                subject: el('div', {}, subjectCell(g),
                  g.severity === 'warn' ? el('div', {}, ui.badge('warn', t('coverage.sev.warn'))) : null),
                evidence: el('span', {}, tr('coverage.ev.' + g.kind, params)),
                suggestion: ui.metaXs(tr('coverage.suggest.' + g.suggestion, params)),
                act: g.link ? ui.rowActions({ label: t('coverage.fix'), onclick: function () { deps.go(g.link); } }) : null,
              },
            };
          }),
        });
        return ui.panel({
          title: tr('coverage.kind.' + kind, {}, kind),
          note: hidden ? t('coverage.truncated', { shown: rows.length, total: total }) : String(total),
          actions: [ui.badge(warn ? 'warn' : 'info', warn ? t('coverage.sev.warn') : t('coverage.sev.info'))],
          children: [table],
        });
      }

      function drawList() {
        var gaps = (report.gaps || []).filter(function (g) { return !state.scope || g.scope === state.scope; });
        var checks = report.checks || [];
        var ran = checks.filter(function (c) { return c.status !== 'skipped'; }).length;
        var skipped = checks.length - ran;

        noteHost.replaceChildren(skipped
          ? ui.inlineNote(t('coverage.note.skipped', { n: skipped }), 'warn')
          : null);

        if (!gaps.length) {
          listHost.replaceChildren(ui.panel({
            children: [ui.emptyState({
              kind: state.scope ? 'nodata' : 'ok',
              title: state.scope ? t('coverage.empty.filtered') : t('coverage.empty.title'),
              // Never an unqualified all-clear: the body names how many checks
              // it rests on, and the table below lists them.
              body: t('coverage.empty.body', { ran: ran, total: checks.length }),
            })],
          }));
          return;
        }
        // Grouped per kind, in the order the server sorted them.
        var order = [];
        var byKind = {};
        gaps.forEach(function (g) {
          if (!byKind[g.kind]) { byKind[g.kind] = []; order.push(g.kind); }
          byKind[g.kind].push(g);
        });
        listHost.replaceChildren.apply(listHost, order.map(function (k) { return kindPanel(k, byKind[k]); }));
      }

      function checkDetail(c) {
        var parts = [];
        if (c.missing && c.missing.length) {
          parts.push(t('coverage.check.missing', {
            sources: c.missing.map(function (s) { return tr('coverage.source.' + s, {}, s); }).join(', '),
          }));
        }
        if (c.capped && c.capped.length) {
          parts.push(t('coverage.check.capped', {
            sources: c.capped.map(function (s) { return tr('coverage.source.' + s, {}, s); }).join(', '),
          }));
        }
        if (c.agentsWithoutIps) parts.push(t('coverage.check.noIps', { n: c.agentsWithoutIps }));
        return parts.join(' · ') || '—';
      }

      function drawChecks() {
        var checks = report.checks || [];
        checksHost.replaceChildren(ui.panel({
          title: t('coverage.checks.title'),
          note: t('coverage.checks.note'),
          children: [ui.dataTable({
            dense: true,
            columns: [
              { key: 'check', label: t('coverage.col.check') },
              { key: 'state', label: t('coverage.col.state'), width: '140px' },
              { key: 'detail', label: t('coverage.col.detail') },
            ],
            rows: checks.map(function (c) {
              return {
                key: c.key,
                cells: {
                  check: el('span', {}, tr('coverage.check.' + c.key, {}, c.key)),
                  state: ui.badge(CHECK_TONE[c.status] || 'neutral', tr('coverage.check.state.' + c.status, {}, c.status)),
                  detail: ui.metaXs(checkDetail(c)),
                },
              };
            }),
          })],
        }));
      }

      function drawAll() {
        drawStrip();
        drawList();
        drawChecks();
      }

      function load() {
        listHost.replaceChildren(ui.panel({ children: [ui.loadingState(5)] }));
        return Promise.resolve()
          .then(function () { return deps.fetchReport(); })
          .then(function (data) {
            report = data || {};
            drawAll();
          })
          .catch(function (e) {
            stripHost.replaceChildren();
            noteHost.replaceChildren();
            checksHost.replaceChildren();
            listHost.replaceChildren(ui.panel({
              children: [ui.errorState({
                title: t('coverage.err.title'),
                body: deps.errText(e),
                detail: 'GET /api/coverage',
                onRetry: load,
              })],
            }));
          });
      }

      load();
      return Promise.resolve(page);
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.CoveragePage = apiObj;
})(typeof window !== 'undefined' ? window : null);
