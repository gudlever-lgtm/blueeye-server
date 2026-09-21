// public/views/discovery.js — Discovery, as a DashboardPage (template B).
//
// What is on the network that is not an agent: the scan scope, a manual sweep,
// the candidates a sweep found, and the sweep log. Built from the contract's
// components (public/ui.js, docs/ui-contract.md).
//
// What this migration changes:
//   * the scope form was `.discovery-form` + `.discovery-form-row` + a local
//     `field()` — a page-local copy of FormSection, three classes deep. It is a
//     FormSection now, and those classes are gone;
//   * the candidate counts were a grey sentence ("discovered 4 · promoted 1 ·
//     ignored 9") beside a status <select> that did the filtering. The counts
//     ARE the filter: a StatStrip, the same move Events and Situations made;
//   * Promote and Dismiss were two buttons in every candidate row. Promote is
//     the row's action; Dismiss is the ⋯ menu, since dismissing something you
//     have not looked at is not a thing to do by reflex;
//   * every status was `.badge <word>` — `online` for a promoted candidate,
//     `muted` for an ignored one, styled by the server's vocabulary. They are
//     contract Badges on tones;
//   * three separate "Loading…"/error greys (scope, candidates, sweeps) become
//     skeletons and ErrorStates that name the call they made. One panel failing
//     no longer decides what the others show.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var STATUS_TONE = { discovered: 'warn', promoted: 'ok', ignored: 'neutral' };
    function statusLabel(s) {
      var k = 'disc.status.' + s;
      var v = t(k);
      return v === k ? String(s || '') : v;
    }

    function view() {
      var state = deps.state;
      if (!state.status) state.status = '';

      var page = ui.page();
      var scopeHost = el('div', {});
      var sweepHost = el('div', {});
      var candHost = el('div', {});
      var histHost = el('div', {});
      var agents = [];
      var agentName = {};

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('disc.title'),
        lead: t('disc.lead'),
        help: { title: info.title, body: info.body },
      }), scopeHost, sweepHost, candHost, histHost);

      // ---- scope ------------------------------------------------------------
      function drawScope(cfg) {
        var head = [
          ui.badge(cfg.enabled ? 'ok' : 'neutral', cfg.enabled ? t('disc.scheduleOn') : t('disc.scheduleOff')),
          cfg.scopeConfigured ? null : ui.badge('warn', t('disc.noScope')),
        ].filter(Boolean);

        if (cfg.editable === false) {
          // Env-managed: the values are worth showing, the form is not.
          scopeHost.replaceChildren(ui.panel({
            title: t('disc.scope'), actions: head,
            children: [el('div', { class: 'panel-body' },
              ui.inlineNote(t('disc.readOnly'), 'info'),
              ui.keyValues([
                [t('disc.f.cidrs'), el('code', {}, (cfg.cidrs || []).join(', ') || '—')],
                [t('disc.f.ports'), el('code', {}, (cfg.ports || []).join(', ') || '—')],
              ]))],
          }));
          return;
        }

        var cidrs = el('textarea', { rows: '4', placeholder: '10.0.0.0/24\n192.168.1.0/24' }, (cfg.cidrs || []).join('\n'));
        var ports = el('input', { type: 'text', value: (cfg.ports || []).join(', '), placeholder: '22, 80, 161, 443, 3389' });
        var rate = el('input', { type: 'number', min: '1', max: '10000', value: String(cfg.rateLimit == null ? 50 : cfg.rateLimit) });
        var cap = el('input', { type: 'number', min: '1', max: '16777216', value: String(cfg.addressCap == null ? 65536 : cfg.addressCap) });
        var interval = el('input', { type: 'number', min: '1', max: '10080', value: String(cfg.intervalMinutes == null ? 360 : cfg.intervalMinutes) });
        // The server validates per field; the slot is owned here so a failed
        // save writes into it instead of rebuilding the form under the cursor.
        var errSlot = el('span', { class: 'field-error' });
        var save = ui.button('primary', t('disc.save'), { onclick: function () { return doSave(); } });

        function doSave() {
          save.disabled = true;
          errSlot.textContent = '';
          return deps.saveConfig({
            cidrs: cidrs.value.split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean),
            ports: ports.value.split(/[\s,]+/).map(Number).filter(function (n) { return Number.isInteger(n) && n > 0; }),
            rateLimit: Number(rate.value),
            addressCap: Number(cap.value),
            intervalMinutes: Number(interval.value),
          }).then(function (r) {
            ui.toast(t('disc.scope'), t('disc.saved'));
            drawScope(r.config);
          }).catch(function (e) {
            errSlot.textContent = deps.fieldErrors(e) || deps.errText(e);
            save.disabled = false;
          });
        }

        scopeHost.replaceChildren(ui.panel({
          title: t('disc.scope'), actions: head,
          children: [el('div', { class: 'panel-body' },
            ui.formSection({
              fields: [
                ui.field({ label: t('disc.f.cidrs'), control: cidrs, hint: t('disc.f.cidrsHint') }),
                ui.field({ label: t('disc.f.ports'), control: ports, hint: t('disc.f.portsHint') }),
                ui.field({ label: t('disc.f.rate'), control: rate, hint: t('disc.f.rateHint') }),
                ui.field({ label: t('disc.f.cap'), control: cap, hint: t('disc.f.capHint') }),
                ui.field({ label: t('disc.f.interval'), control: interval, hint: t('disc.f.intervalHint') }),
              ],
            }),
            ui.formActions([save, errSlot]))],
        }));
      }

      // ---- manual sweep -----------------------------------------------------
      function drawSweep() {
        // Only a connected agent can be sent a command, so only those are
        // offered — an option that answers 409 is not an option.
        var online = agents.filter(function (a) { return a.status === 'online'; });
        // MULTI-SELECT, because a sweep only reaches the segments the machine
        // running it is on. On a routed site "scan the network" is one sweep per
        // agent, and doing that one dropdown at a time is how a segment gets
        // forgotten. The server stays in the same list — it is just another
        // vantage point — and picking it alongside agents is allowed.
        // A token picker rather than a native <select multiple>: the chosen
        // vantage points are readable as removable pills, and the list is
        // filterable — on a fleet where the answer is "these four of forty",
        // a three-row scrolling box is where a segment gets forgotten.
        var from = ui.multiSelect({
          label: t('disc.from'),
          values: [''],
          options: [['', t('disc.fromServer')]].concat(online.map(function (a) {
            return [String(a.id), t('disc.fromAgent', { name: a.display_name || a.hostname })];
          })),
          searchPlaceholder: t('disc.fromFilter'),
          emptyText: t('disc.fromNone'),
          noMatchText: t('disc.fromNoMatch'),
          removeTitle: t('disc.fromRemove'),
        });
        var note = el('span', { class: 'meta' });
        var go = ui.button('primary', t('disc.run'), { onclick: function () { return run(); } });

        function say(text, tone) {
          note.className = tone ? 'inline-note is-' + tone : 'meta';
          note.textContent = text;
        }

        // One agent-run sweep per selected agent, plus the server's own if it
        // was selected. They are genuinely different: the server sweep answers
        // with its result, an agent sweep is a request that lands later.
        function run() {
          var picked = ui.selected(from);
          if (!picked.length) return say(t('disc.pickOne'), 'warn');
          var agentIds = picked.filter(function (v) { return v !== ''; }).map(Number);
          var alsoServer = picked.indexOf('') !== -1;

          go.disabled = true;
          say(t('disc.running'));

          var jobs = [];
          if (agentIds.length) jobs.push(deps.scanMany(agentIds));
          if (alsoServer) jobs.push(deps.scan(null));

          return Promise.all(jobs.map(function (p) {
            // settled, not all-or-nothing: the server sweep failing must not
            // hide that eleven agents accepted theirs.
            return p.then(function (r) { return { ok: true, r: r }; },
              function (e) { return { ok: false, e: e }; });
          })).then(function (outcomes) {
            var lines = [];
            var worst = null;
            outcomes.forEach(function (o) {
              if (!o.ok) {
                worst = 'crit';
                lines.push(o.e && o.e.status === 409 ? t('disc.notConnected') : deps.errText(o.e));
                return;
              }
              var r = o.r;
              if (r.mode === 'agent' && r.results) {
                // The fan-out: say how many took it, and name the ones that did not.
                lines.push(t('disc.requestedMany', { delivered: r.delivered, requested: r.requested }));
                var missed = r.results.filter(function (x) { return !x.delivered; });
                if (missed.length) {
                  worst = worst || 'warn';
                  lines.push(t('disc.notDelivered', {
                    names: missed.map(function (x) { return x.hostname || ('#' + x.agentId); }).join(', '),
                  }));
                }
              } else if (r.mode === 'agent') {
                lines.push(t('disc.requested'));
              } else if (r.refused) {
                worst = worst || 'warn';
                lines.push(t('disc.refused', { reason: r.reason || '' }));
              } else {
                lines.push(t('disc.swept', {
                  addresses: r.addresses == null ? '?' : r.addresses,
                  found: r.found == null ? 0 : r.found,
                }));
              }
            });
            say(lines.join(' · '), worst);
            loadCandidates(); loadSweeps();
            // An agent sweeps on its own clock, so its result arrives later.
            if (agentIds.length) deps.later(function () { loadCandidates(); loadSweeps(); });
          }).then(function () { go.disabled = false; });
        }

        sweepHost.replaceChildren(ui.panel({
          title: t('disc.manual'),
          children: [el('div', { class: 'panel-body' },
            ui.toolbar({ filters: [ui.filter(t('disc.from'), from)], actions: [go] }),
            ui.inlineNote(t('disc.manualHint'), 'info'),
            note)],
        }));
      }

      // ---- candidates -------------------------------------------------------
      function candToolbar(counts) {
        function card(key, label, tone) {
          return {
            value: counts[key] || 0, label: label, tone: tone,
            active: state.status === key,
            title: t('disc.statusHint'),
            onclick: function () {
              state.status = state.status === key ? '' : key;
              loadCandidates();
            },
          };
        }
        return ui.statStrip([
          card('discovered', t('disc.status.discovered'), 'warn'),
          card('promoted', t('disc.status.promoted'), 'ok'),
          card('ignored', t('disc.status.ignored'), undefined),
        ]);
      }

      function foundBy(c) {
        if (!c.foundByAgentId) return ui.meta(t('disc.byServer'));
        return ui.hostLink(agentName[c.foundByAgentId] || t('disc.agentN', { id: c.foundByAgentId }),
          function () { deps.openAgent(c.foundByAgentId); });
      }

      function candRow(c) {
        return {
          c: c,
          cells: {
            ip: el('code', {}, c.ip),
            hostname: c.hostname ? c.hostname : ui.meta('—'),
            ports: el('code', {}, (c.openPorts || c.open_ports || []).join(', ') || '—'),
            found: foundBy(c),
            status: ui.badge(STATUS_TONE[c.status] || 'neutral', statusLabel(c.status)),
            act: c.status === 'discovered'
              ? ui.rowActions(
                { label: t('disc.promote'), onclick: function () { doPromote(c); } },
                [{ label: t('disc.dismiss'), onclick: function () { doIgnore(c); } }])
              : (c.status === 'promoted' && c.promotedAgentId
                ? ui.hostLink(t('disc.agentN', { id: c.promotedAgentId }), function () { deps.openAgent(c.promotedAgentId); })
                : ui.meta('—')),
          },
        };
      }

      function doPromote(c) {
        if (!deps.confirm(t('disc.promoteConfirm', { ip: c.ip }))) return;
        deps.promote(c)
          .then(function (r) { ui.toast(t('disc.promoted', { id: r.agentId }), c.ip); loadCandidates(); })
          .catch(function (e) { ui.toast(t('disc.promote'), deps.errText(e), { bad: true }); });
      }
      function doIgnore(c) {
        deps.ignore(c)
          .then(function () { ui.toast(t('disc.dismissed'), c.ip); loadCandidates(); })
          .catch(function (e) { ui.toast(t('disc.dismiss'), deps.errText(e), { bad: true }); });
      }

      function drawCandidates(data) {
        var list = data.candidates || [];
        var body = [el('div', { class: 'panel-body' }, candToolbar(data.counts || {}))];
        if (!list.length) {
          body.push(state.status
            ? ui.emptyState({
              title: t('disc.noMatch', { status: statusLabel(state.status) }),
              body: t('disc.noMatchHint'),
              action: ui.button('secondary', t('disc.clear'), {
                onclick: function () { state.status = ''; loadCandidates(); },
              }),
            })
            : ui.emptyState({
              icon: '◎',
              title: t('disc.noCandidates'),
              body: t('disc.noCandidatesHint'),
            }));
        } else {
          body.push(ui.dataTable({
            columns: [
              { key: 'ip', label: t('disc.col.ip'), width: '150px' },
              { key: 'hostname', label: t('disc.col.hostname'), width: '200px' },
              { key: 'ports', label: t('disc.col.ports') },
              { key: 'found', label: t('disc.col.found'), width: '170px' },
              // "Discovered" is the longest label the badge carries; at 120px
              // it clipped, and the clipped half looked like the next column.
              { key: 'status', label: t('disc.col.status'), width: '148px' },
              { key: 'act', label: '', width: '132px' },
            ],
            rows: list.map(candRow),
          }));
        }
        candHost.replaceChildren(ui.panel({ title: t('disc.candidates'), children: body }));
      }

      function loadCandidates() {
        return deps.fetchCandidates(state.status)
          .then(drawCandidates)
          .catch(function (e) {
            candHost.replaceChildren(ui.panel({
              title: t('disc.candidates'),
              children: [ui.errorState({
                title: t('disc.err.candidates'), body: deps.errText(e),
                detail: 'GET /api/discovery/candidates', onRetry: loadCandidates,
              })],
            }));
          });
      }

      // ---- sweep history ----------------------------------------------------
      function loadSweeps() {
        return deps.fetchSweeps()
          .then(function (data) {
            var list = data.sweeps || [];
            if (!list.length) {
              histHost.replaceChildren(ui.panel({
                title: t('disc.history'),
                children: [ui.emptyState({ title: t('disc.noSweeps'), body: t('disc.noSweepsHint') })],
              }));
              return;
            }
            histHost.replaceChildren(ui.panel({
              title: t('disc.history'),
              note: t('disc.sweepCount', { n: list.length }),
              // COLUMNS, not the raw `addresses=256 probed=256 found=0 start=…`
              // line the audit log stores. Those are five facts, and a reader
              // scanning the history for the sweep that found nothing should
              // not have to parse a string to spot it. The server does the
              // parsing now (GET /api/discovery/sweeps).
              children: [ui.dataTable({
                columns: [
                  { key: 'time', label: t('disc.col.time'), width: '160px', time: true },
                  { key: 'result', label: t('disc.col.result'), width: '110px' },
                  { key: 'ranBy', label: t('disc.col.ranBy'), width: '170px' },
                  { key: 'scope', label: t('disc.col.scope') },
                  { key: 'addresses', label: t('disc.col.addresses'), width: '100px', num: true },
                  { key: 'found', label: t('disc.col.foundCount'), width: '90px', num: true },
                  { key: 'duration', label: t('disc.col.duration'), width: '100px', num: true },
                ],
                rows: list.map(function (s) {
                  var refused = s.refused || s.action === 'discovery_sweep_refused';
                  var by = s.ranBy || {};
                  // An agent whose row was deleted since the sweep has no name
                  // left. Say which id it was rather than inventing one.
                  var whoRan = by.kind === 'agent'
                    ? (by.hostname || t('disc.agentGone', { id: by.agentId }))
                    : t('disc.fromServerShort');
                  return {
                    cells: {
                      time: ui.meta(ui.fmt.short(s.createdAt)),
                      result: ui.badge(refused ? 'warn' : 'ok', refused ? t('disc.refusedShort') : t('disc.sweptShort')),
                      ranBy: ui.meta(whoRan),
                      // A refusal has a reason and no numbers; a sweep has
                      // numbers and no reason. One column each, never both.
                      scope: ui.meta(refused
                        ? (s.reason ? t('disc.refused', { reason: s.reason }) : (s.detail || '—'))
                        : (s.scope || t('disc.scopeSelf'))),
                      // `found=0` is a MEASUREMENT — a clean network — so it
                      // prints as 0. Only a genuinely absent number is a dash.
                      addresses: ui.meta(s.addresses == null ? '—' : String(s.addresses)),
                      found: ui.meta(s.found == null ? '—' : String(s.found)),
                      duration: ui.meta(s.durationMs == null ? '—' : ui.fmt.duration(s.durationMs)),
                    },
                  };
                }),
              })],
            }));
          })
          .catch(function (e) {
            histHost.replaceChildren(ui.panel({
              title: t('disc.history'),
              children: [ui.errorState({
                title: t('disc.err.sweeps'), body: deps.errText(e),
                detail: 'GET /api/discovery/sweeps', onRetry: loadSweeps,
              })],
            }));
          });
      }

      // ---- boot -------------------------------------------------------------
      function load() {
        scopeHost.replaceChildren(ui.panel({ title: t('disc.scope'), children: [ui.loadingState(4)] }));
        candHost.replaceChildren(ui.panel({ title: t('disc.candidates'), children: [ui.loadingState(4)] }));
        histHost.replaceChildren(ui.panel({ title: t('disc.history'), children: [ui.loadingState(3)] }));
        return deps.fetchBoot()
          .then(function (d) {
            agents = d.agents || [];
            agentName = {};
            agents.forEach(function (a) {
              agentName[a.id] = a.display_name || a.hostname || t('disc.agentN', { id: a.id });
            });
            drawScope(d.cfg);
            drawSweep();
            loadCandidates();
            loadSweeps();
          })
          .catch(function (e) {
            sweepHost.replaceChildren();
            candHost.replaceChildren();
            histHost.replaceChildren();
            // 403 is not a failure to report — the nav hides this screen, so a
            // reader who gets here typed the address.
            scopeHost.replaceChildren(ui.panel({
              title: t('disc.scope'),
              children: [e && e.status === 403
                ? ui.emptyState({ icon: '🔒', title: t('disc.forbidden'), body: t('disc.forbiddenHint') })
                : ui.errorState({
                  title: t('disc.err.config'), body: deps.errText(e),
                  detail: 'GET /api/discovery/config', onRetry: load,
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
  if (root) root.DiscoveryPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
