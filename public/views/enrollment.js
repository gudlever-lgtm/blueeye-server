// public/views/enrollment.js — Enrollment, as a FormPage (template C).
//
// How an agent gets onto the server: pick a platform, generate a one-time code,
// run the command on the machine. The codes already issued are listed under it.
// Built from the contract's components (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * the wizard was four loose `<label>`s in a row of its own markup. It is a
//     FormSection with one primary — the same form shape as Investigate and
//     Diagnose;
//   * "no agent signing key is set" was a red box in the document flow that
//     said what was wrong but not where to go. It is an ErrorState with the
//     link, and — for a reader who cannot fix it themselves — it says who can;
//   * the codes table's status column was a `.badge <status>` styled by the raw
//     server word. It is a contract Badge on a tone, so "expired" is not the
//     same colour as "active" on a theme that never heard of either;
//   * Delete was a red button in every row. It is the ⋯ menu's destructive
//     entry, and the row opens nothing — a code is not a page.
//
// The generated code + command block (`renderEnrollResult`) is NOT migrated: it
// carries the live "waiting for agent" socket state, the Windows two-step
// variant and the manual checksum block.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var STATUS_TONE = { active: 'ok', used: 'neutral', expired: 'warn', revoked: 'crit' };
    function statusLabel(s) {
      var k = 'enroll.status.' + s;
      var v = t(k);
      return v === k ? String(s || '') : v;
    }

    function view() {
      var page = ui.page();
      var keyHost = el('div', {});
      var wizardHost = el('div', {});
      var codesHost = el('div', {});

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('enroll.title'),
        lead: t('enroll.lead'),
        help: { title: info.title, body: info.body },
      }), keyHost, wizardHost, codesHost);

      // ---- the wizard -------------------------------------------------------
      function drawWizard(cfg, locations) {
        if (!deps.canWrite()) return;
        if (!cfg.releasePublicKey) {
          // Without the agent signing key the server refuses to mint a code, so
          // a wizard here would only ever produce an error. Say what is missing
          // and, when the reader can fix it, take them there.
          keyHost.replaceChildren(ui.panel({
            title: t('enroll.add'),
            children: [ui.emptyState({
              icon: '⚠',
              title: t('enroll.noKey'),
              body: deps.isAdmin() ? t('enroll.noKeyAdmin') : t('enroll.noKeyOther'),
              action: deps.isAdmin()
                ? ui.button('primary', t('enroll.noKeyGo'), { onclick: function () { deps.openSettings('agentkey'); } })
                : null,
            })],
          }));
          return;
        }

        var platform = ui.select({ label: t('enroll.f.platform'), options: deps.platforms() });
        var count = el('input', { type: 'number', min: '1', max: '1000', value: '1' });
        var ttl = el('input', { type: 'number', min: '1', value: '60' });
        var loc = ui.select({
          label: t('enroll.f.location'),
          options: [['', t('enroll.noLocation')]].concat(locations.map(function (l) { return [String(l.id), l.name]; })),
        });
        // renderEnrollResult() unhides this and fills it in; the dashed rule
        // above it is what separates the generated command from the form.
        var result = el('div', { class: 'enroll-result hidden' });
        var go = ui.button('primary', t('enroll.generate'), { onclick: function () { return generate(); } });

        function generate() {
          go.disabled = true;
          return deps.generate({
            platform: platform.value,
            maxUses: Math.max(1, Number(count.value) || 1),
            ttlMinutes: Math.max(1, Number(ttl.value) || 60),
            locationId: loc.value || null,
          }).then(function (data) {
            deps.renderResult(result, data, cfg, generate);
          }).catch(function (e) {
            deps.toast(deps.errText(e), true);
          }).then(function () { go.disabled = false; });
        }

        wizardHost.replaceChildren(ui.panel({
          title: t('enroll.add'),
          children: [el('div', { class: 'panel-body' },
            ui.formSection({
              hint: t('enroll.addHint'),
              fields: [
                ui.field({ label: t('enroll.f.platform'), control: platform }),
                ui.field({ label: t('enroll.f.count'), control: count, hint: t('enroll.f.countHint') }),
                ui.field({ label: t('enroll.f.ttl'), control: ttl, hint: t('enroll.f.ttlHint') }),
                ui.field({ label: t('enroll.f.location'), control: loc }),
              ],
            }),
            ui.formActions([go]),
            result)],
        }));
      }

      // ---- the codes --------------------------------------------------------
      function usesCell(c) {
        if (c.max_uses > 1) return c.uses_remaining + '/' + c.max_uses;
        return c.uses_remaining === 0 ? t('enroll.used') : '1';
      }
      function agentsCell(agents) {
        if (!agents || !agents.length) return ui.meta('–');
        return el('div', { class: 'code-agents' }, agents.map(function (a) {
          return el('span', { class: 'code-agent' },
            ui.badge(a.online ? 'ok' : 'neutral', a.online ? t('enroll.online') : t('enroll.offline')),
            ui.hostLink(a.name, function () { deps.openAgent(a.id); }));
        }));
      }

      function drawCodes(codes) {
        var expired = codes.filter(function (c) { return c.status === 'expired'; }).length;
        var actions = [
          // Only offered when there is something to clear, and it can never
          // sweep up a code an agent is listed beside.
          (deps.canDelete() && expired)
            ? ui.button('ghost', t('enroll.codes.deleteExpired') + ' (' + expired + ')', {
              title: t('enroll.codes.deleteExpiredTitle', { n: expired }),
              onclick: function () { deps.deleteExpired(expired); },
            })
            : null,
          deps.canWrite()
            ? ui.button('secondary', t('enroll.newCode'), { onclick: function () { deps.createCode(); } })
            : null,
        ];

        if (!codes.length) {
          codesHost.replaceChildren(ui.panel({
            title: t('enroll.codes.title'), actions: actions,
            children: [ui.emptyState({ icon: '🎟', title: t('enroll.codes.none'), body: t('enroll.codes.noneHint') })],
          }));
          return;
        }

        codesHost.replaceChildren(ui.panel({
          title: t('enroll.codes.title'),
          note: t('enroll.codes.count', { n: codes.length }),
          actions: actions,
          // What "used" and "expired" mean for the agent beside them — an
          // advisory about the data, above the table rather than in the head,
          // where it would push the two actions off the end of the line.
          children: [el('div', { class: 'panel-body' }, ui.inlineNote(t('enroll.codes.note'), 'info')), ui.dataTable({
            columns: [
              { key: 'id', label: t('enroll.col.id'), width: '64px', num: true },
              { key: 'status', label: t('enroll.col.status'), width: '104px' },
              { key: 'uses', label: t('enroll.col.uses'), width: '80px', num: true },
              { key: 'agents', label: t('enroll.col.agents') },
              { key: 'location', label: t('enroll.col.location'), width: '160px' },
              { key: 'expires', label: t('enroll.col.expires'), width: '140px', time: true },
              { key: 'created', label: t('enroll.col.created'), width: '140px', time: true },
              { key: 'act', label: '', width: '56px' },
            ],
            rows: codes.map(function (c) {
              return {
                c: c,
                cells: {
                  id: ui.meta(String(c.id)),
                  status: ui.badge(STATUS_TONE[c.status] || 'neutral', statusLabel(c.status)),
                  uses: usesCell(c),
                  agents: agentsCell(c.agents),
                  location: c.location_name ? c.location_name : ui.meta('–'),
                  expires: ui.meta(ui.fmt.short(c.expires_at)),
                  created: ui.meta(ui.fmt.short(c.created_at)),
                  act: deps.canDelete()
                    ? ui.rowActions(null, [{ label: t('enroll.deleteCode'), danger: true, onclick: function () { deps.deleteCode(c); } }])
                    : null,
                },
              };
            }),
          })],
        }));
      }

      function load() {
        codesHost.replaceChildren(ui.panel({ title: t('enroll.codes.title'), children: [ui.loadingState(4)] }));
        return deps.fetchAll()
          .then(function (d) {
            keyHost.replaceChildren();
            wizardHost.replaceChildren();
            drawWizard(d.cfg, d.locations || []);
            drawCodes(d.codes || []);
          })
          .catch(function (e) {
            keyHost.replaceChildren();
            wizardHost.replaceChildren();
            codesHost.replaceChildren(ui.panel({
              title: t('enroll.codes.title'),
              children: [ui.errorState({
                title: t('enroll.err.title'),
                body: deps.errText(e),
                detail: 'GET /enrollment-codes',
                onRetry: load,
              })],
            }));
          });
      }

      return load().then(function () { return page; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.EnrollmentPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
