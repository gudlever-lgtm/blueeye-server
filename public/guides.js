// BlueEye — the in-app guides.
//
//   From an empty screen to a dashboard you know how to read.
//
// Five next-next walkthroughs, one per section of the product: Monitoring,
// Fleet, Diagnostics, Service Assurance and Insights. Each is one step per
// thing you actually do, in the order the product needs them done, and — the
// part a handbook never gets right — the VALUES to put in.
//
// Every number a guide quotes about the running system is read from that
// system (the settings endpoints return the effective values AND the
// defaults), so a default that moves cannot leave these screens lying about
// it.
//
// Loaded as its own classic script (no build step, repo convention) and
// mounted by views.guide in app.js, which passes the shared helpers in rather
// than this file reaching into app.js globals — the same seam
// views.serviceAssurance uses.
//
// It reads and never writes. Every probe it makes is wrapped: a 403 (no
// licence or not an admin), a 404 (an endpoint that moved) or a 500 must not
// take the guidance down with it, because the guidance is the point and the
// live state is the garnish.

(function (root) {
  'use strict';

  var API = '/api/service-tests';
  // The five guides, in the order the nav lists them — which is the order
  // somebody meets the product in: what changed, the machines behind it, the
  // tools for when one misbehaves, the services on top, and what all of it
  // adds up to.
  var TRACKS = ['monitoring', 'fleet', 'diagnostics', 'assurance', 'insights'];
  // Where the reader got to in EACH guide, remembered per browser. One key per
  // track: somebody halfway through Diagnostics who opens Insights should not
  // find it starting at step 5.
  var STORAGE_KEY = 'blueeye.guide.step.';

  // The health score's weights. Hardcoded here because nothing serves them, and
  // pinned to src/serviceTests/health/serviceHealth.js by
  // test/guides.test.js — so this table cannot drift from the
  // arithmetic it describes without failing the build.
  var HEALTH_WEIGHTS = [
    ['functional', '45%'],
    ['availability', '25%'],
    ['api', '20%'],
    ['performance', '10%'],
  ];

  // The settings worth a line in step "The values, in one place". Curated on
  // purpose: the full catalogue is in Settings, and a table of 40 rows is read
  // by nobody. [section, field, why-key].
  var VALUE_ROWS = [
    ['assurance', 'enabled', 'guide.values.row.enabled'],
    ['assurance', 'notify', 'guide.values.row.notify'],
    ['assurance', 'groupAlerts', 'guide.values.row.groupAlerts'],
    ['assurance', 'failureStreak', 'guide.values.row.failureStreak'],
    ['assurance', 'sweepIntervalMs', 'guide.values.row.sweepIntervalMs'],
    ['assurance', 'certificateWarnDays', 'guide.values.row.certWarn'],
    ['assurance', 'certificateCriticalDays', 'guide.values.row.certCrit'],
    ['assurance', 'incidentRetentionDays', 'guide.values.row.incidentRetention'],
    ['monitors', 'minIntervalSec', 'guide.values.row.minInterval'],
    ['monitors', 'mailRecipientDomains', 'guide.values.row.mailDomains'],
    ['monitors', 'resultRetentionDays', 'guide.values.row.monitorRetention'],
    ['runner', 'concurrency', 'guide.values.row.concurrency'],
    ['runner', 'browser', 'guide.values.row.browser'],
    ['runner', 'accessibility', 'guide.values.row.accessibility'],
    ['runner', 'stepTimeoutMs', 'guide.values.row.stepTimeout'],
    ['discovery', 'maxPages', 'guide.values.row.maxPages'],
    ['discovery', 'maxDepth', 'guide.values.row.maxDepth'],
    ['discovery', 'maxRequests', 'guide.values.row.maxRequests'],
    ['allowlist', 'maxAddressesPerApplication', 'guide.values.row.maxAddresses'],
    ['allowlist', 'minCidrPrefix', 'guide.values.row.minCidrPrefix'],
    ['artifacts', 'retentionDays', 'guide.values.row.artifactRetention'],
  ];

  // The analysis + retention settings the Insights guide prints. The default
  // column is written here and pinned to ANALYSIS_DEFAULTS / RETENTION_DEFAULTS
  // (src/services/settings.js) by test/guides.test.js — the live column is read
  // from GET /api/settings, which only an administrator may call.
  var ANALYSIS_VALUES = [
    ['warnSigma', '3', 'guide.ins.row.warnSigma'],
    ['critSigma', '4', 'guide.ins.row.critSigma'],
    ['baselineDays', '7', 'guide.ins.row.baselineDays'],
    ['minSamples', '200', 'guide.ins.row.minSamples'],
    ['verifySettleMinutes', '5', 'guide.ins.row.verifySettle'],
  ];
  var RETENTION_VALUES = [
    ['rawRetentionDays', '7', 'guide.ins.row.rawRetention'],
    ['rollupRetentionDays', '90', 'guide.ins.row.rollupRetention'],
    ['findingRetentionDays', '365', 'guide.ins.row.findingRetention'],
    ['rollupIntervalMinutes', '60', 'guide.ins.row.rollupInterval'],
  ];

  // Fleet health verdicts come from src/health/probeHealth.js THRESHOLDS, and
  // interface verdicts from src/health/interfaceHealth.js. Both are quoted by the
  // Monitoring and Fleet guides and pinned by test/guides.test.js.
  var HEALTH_THRESHOLDS = {
    LOSS_WARN: '2', LOSS_BAD: '20', JITTER_WARN: '30', JITTER_BAD: '100',
    Z_WARN: '3', Z_BAD: '6', MIN_BASELINE: '8', STALE_MIN: '15',
    IFACE_UTIL_WARN: '75', IFACE_UTIL_BAD: '90',
  };

  function create(ctx) {
    var el = ctx.el;
    var api = ctx.api;
    var t = ctx.t;
    // Counted lines ("one agent" vs "3 agents") go through plural(), which picks
    // the .one/.other catalogue entry. A host that does not supply it falls back
    // to t(), which then renders the plural form — wrong for exactly one item,
    // rather than broken.
    var plural = typeof ctx.plural === 'function' ? ctx.plural : function (key, n, params) {
      var merged = { count: String(n) };
      if (params) for (var k in params) merged[k] = params[k];
      return t(key, merged);
    };
    var isOperator = typeof ctx.isOperator === 'function' ? ctx.isOperator : function () { return false; };
    var isAdmin = typeof ctx.isAdmin === 'function' ? ctx.isAdmin : function () { return false; };
    // Which guide the nav entry asked for; an unknown name opens the first
    // rather than rendering an empty page.
    var track = TRACKS.indexOf(ctx.track) >= 0 ? ctx.track : TRACKS[0];
    // Deep links into the dashboard's own screens, Settings and the handbook.
    // All optional: a host that does not supply one simply gets no button,
    // which is better than a button that does nothing.
    var openView = typeof ctx.openView === 'function' ? ctx.openView : null;
    var openTab = typeof ctx.openTab === 'function' ? ctx.openTab : null;
    var openSettings = typeof ctx.openSettings === 'function' ? ctx.openSettings : null;
    var openDocs = typeof ctx.openDocs === 'function' ? ctx.openDocs : null;

    var host = el('div', { class: 'guide guide-' + track });
    // Everything the live checks need, loaded once when the view is mounted.
    // `null` on any member means "we could not read this" — never "it is empty".
    var data = null;
    var loadError = null;
    var step = readStep();

    // ------------------------------------------------------------- utilities
    function readStep() {
      try {
        var raw = root.localStorage.getItem(STORAGE_KEY + track);
        var n = parseInt(raw, 10);
        return isFinite(n) && n >= 0 ? n : 0;
      } catch (e) { return 0; }
    }
    function writeStep(n) {
      try { root.localStorage.setItem(STORAGE_KEY + track, String(n)); } catch (e) { /* private mode */ }
    }
    function errText(e) { return (e && (e.message || e.error)) || String(e); }
    // Every probe is optional. One endpoint answering 403/404/500 costs its own
    // status line, nothing else.
    function probe(path) {
      return api(path).catch(function (e) { loadError = loadError || errText(e); return null; });
    }
    function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
    function ms(value) {
      var n = num(value);
      if (n === null) return String(value);
      if (n % 60000 === 0) return t('guide.unit.min', { n: String(n / 60000) });
      if (n % 1000 === 0) return t('guide.unit.sec', { n: String(n / 1000) });
      return t('guide.unit.ms', { n: String(n) });
    }
    // Renders a settings value the way the reader will see it in Settings:
    // booleans as on/off, durations as seconds/minutes, everything else as is.
    function settingText(field, value) {
      if (value === true) return t('guide.on');
      if (value === false) return t('guide.off');
      if (/Ms$/.test(field)) return ms(value);
      if (field === 'minCidrPrefix') return '/' + String(value);
      if (value === null || value === undefined || value === '') return '—';
      return String(value);
    }
    function sectionOf(bag, section) {
      return (bag && bag[section] && typeof bag[section] === 'object') ? bag[section] : null;
    }
    // The effective value of one setting, with its default. Falls back to the
    // default alone when the settings endpoint was unreachable.
    function setting(section, field) {
      var s = data && data.settings;
      var live = s ? sectionOf(s.settings, section) : null;
      var def = s ? sectionOf(s.defaults, section) : null;
      return {
        value: live && Object.prototype.hasOwnProperty.call(live, field) ? live[field] : undefined,
        def: def && Object.prototype.hasOwnProperty.call(def, field) ? def[field] : undefined,
      };
    }
    // A number to quote in prose ("the crawl stops at 100 pages"): the live
    // value when we have it, the default when we do not, and null when neither —
    // in which case the sentence that needs it is left out rather than guessed.
    function quote(section, field) {
      var s = setting(section, field);
      var v = s.value !== undefined ? s.value : s.def;
      return v === undefined ? null : v;
    }

    // ------------------------------------------------------------- DOM pieces
    function lead(text) { return el('p', { class: 'guide-lead' }, text); }
    function para() {
      var kids = Array.prototype.slice.call(arguments);
      return el('p', { class: 'guide-p' }, kids);
    }
    function todo(items) {
      return el('ol', { class: 'docs-steps guide-todo' }, items.filter(Boolean).map(function (item) {
        return el('li', {}, Array.isArray(item) ? item : [item]);
      }));
    }
    function note(text) {
      return el('div', { class: 'callout guide-note' }, el('strong', {}, t('guide.note') + ' '), text);
    }
    function watch(text) {
      return el('div', { class: 'callout guide-watch' }, el('strong', {}, t('guide.watch') + ' '), text);
    }
    function code(text) { return el('pre', { class: 'docs-code guide-code' }, text); }
    function table(head, rows) {
      return el('div', { class: 'docs-tablewrap' }, el('table', { class: 'docs-table guide-table' },
        el('thead', {}, el('tr', {}, head.map(function (h) { return el('th', {}, h); }))),
        el('tbody', {}, rows.filter(Boolean).map(function (r) {
          return el('tr', {}, r.map(function (c) {
            return el('td', {}, Array.isArray(c) ? c : [c]);
          }));
        }))));
    }
    // "What to put in" — the table this guide exists for.
    function values(rows) {
      return el('div', { class: 'guide-values' },
        el('h4', { class: 'guide-h4' }, t('guide.values.title')),
        table([t('guide.col.field'), t('guide.col.value'), t('guide.col.why')], rows));
    }
    function mono(text) { return el('code', {}, text); }

    // The four parts of the score, spelled out for the same reason as
    // statusLabel below: a catalogue key is always a literal in a t() call.
    function healthPart(id) {
      if (id === 'functional') return [t('guide.health.part.functional'), t('guide.health.part.functional.w')];
      if (id === 'availability') return [t('guide.health.part.availability'), t('guide.health.part.availability.w')];
      if (id === 'api') return [t('guide.health.part.api'), t('guide.health.part.api.w')];
      return [t('guide.health.part.performance'), t('guide.health.part.performance.w')];
    }
    // One live-state line: a pill and a sentence. `state` is one of
    // done / todo / warn / unknown.
    // The four states, spelled out rather than composed: every catalogue key in
    // this dashboard is a literal in a t() call, because that is what the gate
    // sweep can check (test/gate/ui.test.js). A built key is an untranslated
    // string nobody notices until a customer does.
    function statusLabel(state) {
      if (state === 'done') return t('guide.status.done');
      if (state === 'todo') return t('guide.status.todo');
      if (state === 'warn') return t('guide.status.warn');
      return t('guide.status.unknown');
    }
    function status(state, text) {
      return el('div', { class: 'guide-status guide-status-' + state },
        el('span', { class: 'guide-pill guide-pill-' + state }, statusLabel(state)),
        el('span', { class: 'guide-status-text' }, text));
    }

    // The module's own screen names, reused from its catalogue so the button and
    // the tab it opens can never read differently.
    function tabLabel(tab) {
      if (tab === 'applications') return t('sa.tab.applications');
      if (tab === 'journeys') return t('sa.tab.journeys');
      if (tab === 'tests') return t('sa.tab.tests');
      if (tab === 'runs') return t('sa.tab.runs');
      if (tab === 'schedules') return t('sa.tab.schedules');
      if (tab === 'monitors') return t('sa.tab.monitors');
      return t('sa.tab.health');
    }
    function tabButton(tab) {
      if (!openTab) return null;
      return el('button', {
        class: 'ghost small',
        onclick: function () { openTab(tab); },
      }, t('guide.openTab', { tab: tabLabel(tab) }));
    }
    // A screen the reader's role or licence hides. Shown, greyed, with the
    // reason — the same manners as the help drawers' viewLink, which degrades
    // to plain text rather than offering a dead end. Saying nothing would be
    // worse: the guide would describe a screen and quietly omit the way to it.
    function unavailable(label, reason) {
      return el('span', { class: 'guide-unavailable', title: reason }, label + ' · ' + reason);
    }
    // A button that opens one of the dashboard's own screens. The label is passed
    // in rather than built from the view key, so every string stays a literal.
    function viewButton(viewKey, label) {
      if (!openView) return null;
      // canOpenView mirrors the nav: hidden by role, or locked by licence.
      var why = typeof ctx.viewBlockedReason === 'function' ? ctx.viewBlockedReason(viewKey) : null;
      if (why === 'role') return unavailable(label, t('guide.needsOperator'));
      if (why === 'licence') return unavailable(label, t('guide.needsLicence'));
      return el('button', { class: 'ghost small', onclick: function () { openView(viewKey); } },
        t('guide.openTab', { tab: label }));
    }
    // Every Settings tab a guide links to is administrator-only, so for anybody
    // else the button is a promise the app cannot keep — Settings would open on
    // whichever tab their role can see instead.
    function settingsTabButton(tab, label) {
      if (!openSettings) return null;
      if (!isAdmin()) return unavailable(label, t('guide.needsAdmin'));
      return el('button', { class: 'ghost small', onclick: function () { openSettings(tab); } }, label);
    }
    function settingsButton() { return settingsTabButton('assurance', t('guide.openSettings')); }
    function alertingButton() { return settingsTabButton('alerting', t('guide.openAlerting')); }
    function docsButton(topic) {
      if (!openDocs) return null;
      return el('button', { class: 'ghost small', onclick: function () { openDocs(topic); } },
        t('guide.openDocs'));
    }
    function actions() {
      var kids = Array.prototype.slice.call(arguments).filter(Boolean);
      if (!kids.length) return null;
      return el('div', { class: 'guide-actions' }, kids);
    }


    // ------------------------------------------------------------------ doing
    // A step can DO the thing it describes. "Click here →" rather than "go to
    // Applications, press New, fill in two fields and come back".
    //
    // The rules this follows, because a guide that writes to a production system
    // has to be more careful than one that only talks:
    //
    //   * it writes ONLY when the reader presses the button, and the button says
    //     exactly what it will create;
    //   * it calls the same endpoint the real screen calls, so the same
    //     validation, the same RBAC and the same audit entry apply — there is no
    //     second, laxer way in through the guide;
    //   * a 400 comes back on the field that caused it. The server's message is
    //     shown verbatim rather than replaced by a friendlier guess;
    //   * a reader whose role cannot do it is told so instead of being given a
    //     button that answers 403;
    //   * on success the live state is re-read, so the step's own status line
    //     stops saying "not yet" while the thing sits there created.
    function canDo(role) {
      if (role === 'admin') return isAdmin();
      return isOperator();
    }
    function actionField(spec) {
      var input;
      if (spec.type === 'select') {
        input = el('select', { class: 'guide-action-input', name: spec.name },
          (spec.options || []).map(function (opt) {
            return el('option', { value: String(opt.value) }, opt.label);
          }));
      } else {
        input = el('input', {
          class: 'guide-action-input',
          type: spec.type === 'url' ? 'url' : 'text',
          name: spec.name,
          placeholder: spec.placeholder || '',
        });
      }
      var error = el('p', { class: 'guide-action-error', hidden: 'hidden' });
      var row = el('label', { class: 'guide-action-field' },
        el('span', { class: 'guide-action-label' }, spec.label),
        input, error);
      return { spec: spec, node: row, input: input, error: error };
    }

    // opts: { id, role, title, help, fields, submit(values) → Promise, success(result) → string }
    function actionCard(opts) {
      if (!canDo(opts.role)) {
        return el('div', { class: 'guide-action guide-action-blocked' },
          el('h4', { class: 'guide-h4' }, opts.title),
          el('p', { class: 'guide-p' }, opts.help),
          unavailable(t('guide.do.cannot'), opts.role === 'admin' ? t('guide.needsAdmin') : t('guide.needsOperator')));
      }
      var fields = (opts.fields || []).map(actionField);
      var result = el('p', { class: 'guide-action-result', hidden: 'hidden' });
      var failure = el('p', { class: 'guide-action-failure', hidden: 'hidden' });
      var button = el('button', { class: 'primary guide-action-go', type: 'button' }, opts.button || t('guide.do.go'));

      function clearErrors() {
        fields.forEach(function (f) { f.error.textContent = ''; f.error.hidden = true; });
        failure.textContent = ''; failure.hidden = true;
      }
      // A 400 from any of these routes is { error, details: { field: why } }.
      // Put each message on its own field; anything unattributed goes on the
      // card, because a validation error nobody can see is a button that
      // silently does nothing.
      function showErrors(e) {
        var details = e && e.data && e.data.details;
        var shown = false;
        if (details && typeof details === 'object') {
          fields.forEach(function (f) {
            var msg = details[f.spec.name];
            if (msg) { f.error.textContent = String(msg); f.error.hidden = false; shown = true; }
          });
          var rest = Object.keys(details).filter(function (k) {
            return !fields.some(function (f) { return f.spec.name === k; });
          });
          if (rest.length) {
            failure.textContent = rest.map(function (k) { return details[k]; }).join(' · ');
            failure.hidden = false; shown = true;
          }
        }
        if (!shown) { failure.textContent = errText(e); failure.hidden = false; }
      }

      button.addEventListener('click', function () {
        clearErrors();
        result.hidden = true;
        var values = {};
        fields.forEach(function (f) { values[f.spec.name] = f.input.value; });
        button.disabled = true;
        Promise.resolve()
          .then(function () { return opts.submit(values); })
          .then(function (created) {
            result.textContent = opts.success ? opts.success(created) : t('guide.do.done');
            result.hidden = false;
            fields.forEach(function (f) { if (f.spec.type !== 'select') f.input.value = ''; });
            // The status line above this card is now out of date.
            return load();
          })
          .catch(showErrors)
          .then(function () { button.disabled = false; });
      });

      return el('div', { class: 'guide-action' },
        el('h4', { class: 'guide-h4' }, opts.title),
        el('p', { class: 'guide-p' }, opts.help),
        el('div', { class: 'guide-action-fields' }, fields.map(function (f) { return f.node; })),
        el('div', { class: 'guide-action-foot' }, button, result, failure));
    }

    // The applications a Service Assurance action can target. Empty until the
    // reader has created one, which is why the card says so rather than
    // rendering a picker with nothing in it.
    function applicationOptions() {
      var apps = Array.isArray(data && data.apps) ? data.apps : [];
      return apps.map(function (a) { return { value: a.id, label: a.name }; });
    }
    function agentOptions() {
      var agents = agentList() || [];
      return agents.map(function (a) {
        return { value: a.id, label: a.display_name || a.hostname || ('#' + a.id) };
      });
    }

    // ---- the five actions ---------------------------------------------------
    function createSiteAction() {
      return actionCard({
        role: 'operator',
        title: t('guide.do.site.title'),
        help: t('guide.do.site.help'),
        button: t('guide.do.site.go'),
        fields: [
          { name: 'name', label: t('guide.do.site.name'), placeholder: t('guide.do.site.namePh') },
          { name: 'address', label: t('guide.do.site.address'), placeholder: t('guide.do.site.addressPh') },
        ],
        submit: function (v) {
          return api('/locations', {
            method: 'POST',
            body: { name: v.name, address: v.address ? v.address : null },
          });
        },
        success: function (created) { return t('guide.do.site.ok', { name: (created && created.name) || '' }); },
      });
    }

    function enrollmentCodeAction() {
      return actionCard({
        role: 'operator',
        title: t('guide.do.code.title'),
        help: t('guide.do.code.help'),
        button: t('guide.do.code.go'),
        fields: [],
        submit: function () { return api('/enrollment-codes', { method: 'POST', body: {} }); },
        success: function (created) { return t('guide.do.code.ok', { code: (created && created.code) || '' }); },
      });
    }

    function runProbeAction() {
      var agents = agentOptions();
      if (!agents.length) {
        return el('div', { class: 'guide-action guide-action-blocked' },
          el('h4', { class: 'guide-h4' }, t('guide.do.probe.title')),
          el('p', { class: 'guide-p' }, t('guide.do.probe.noAgents')));
      }
      return actionCard({
        role: 'operator',
        title: t('guide.do.probe.title'),
        help: t('guide.do.probe.help'),
        button: t('guide.do.probe.go'),
        fields: [
          { name: 'agent', label: t('guide.do.probe.agent'), type: 'select', options: agents },
          { name: 'host', label: t('guide.do.probe.host'), placeholder: '1.1.1.1' },
        ],
        submit: function (v) {
          return api('/agents/' + encodeURIComponent(v.agent) + '/probe', {
            method: 'POST', body: { type: 'ping', host: v.host },
          });
        },
        success: function () { return t('guide.do.probe.ok'); },
      });
    }

    function createApplicationAction() {
      return actionCard({
        role: 'admin',
        title: t('guide.do.app.title'),
        help: t('guide.do.app.help'),
        button: t('guide.do.app.go'),
        fields: [
          { name: 'name', label: t('guide.do.app.name'), placeholder: t('guide.do.app.namePh') },
          { name: 'base_url', label: t('guide.do.app.url'), type: 'url', placeholder: 'https://app.example.dk' },
        ],
        submit: function (v) {
          return api(API + '/applications', { method: 'POST', body: { name: v.name, base_url: v.base_url } });
        },
        success: function (created) { return t('guide.do.app.ok', { name: (created && created.name) || '' }); },
      });
    }

    // The first monitor somebody should have: does our mail actually arrive.
    //
    // Deliberately the send-only depth — it needs one server and one account,
    // and it is the half that works without a second mailbox. The round trip is
    // a checkbox on the monitor afterwards, and the step says so.
    function createMonitorAction() {
      return actionCard({
        role: 'operator',
        title: t('guide.do.monitor.title'),
        help: t('guide.do.monitor.help'),
        button: t('guide.do.monitor.go'),
        fields: [
          { name: 'name', label: t('guide.do.monitor.name'), placeholder: t('guide.do.monitor.namePh') },
          { name: 'smtp_host', label: t('guide.do.monitor.host'), placeholder: 'smtp.example.dk' },
          { name: 'from_address', label: t('guide.do.monitor.from'), placeholder: 'assurance@example.dk' },
          { name: 'to_address', label: t('guide.do.monitor.to'), placeholder: 'mailprobe@example.dk' },
        ],
        // The field names are the CONFIG's, so a 400 from the server lands on
        // the box that caused it: the card matches `details` by field name, and
        // the server answers `config.smtp_host`.
        submit: function (v) {
          return api(API + '/monitors', {
            method: 'POST',
            body: {
              name: v.name,
              type: 'mail',
              config: {
                smtp_host: v.smtp_host,
                from_address: v.from_address,
                to_address: v.to_address,
              },
            },
          });
        },
        success: function (created) { return t('guide.do.monitor.ok', { name: (created && created.name) || '' }); },
      });
    }

    // The first test somebody should have: open the front page and check the
    // title. Two steps, which is a real test rather than a placeholder — and it
    // is built through the same POST the designer uses, so the same DSL
    // validation applies. Everything past this is the designer's job; a guide
    // that tried to be a step editor would be a worse step editor.
    function createTestAction() {
      var apps = applicationOptions();
      if (!apps.length) {
        return el('div', { class: 'guide-action guide-action-blocked' },
          el('h4', { class: 'guide-h4' }, t('guide.do.test.title')),
          el('p', { class: 'guide-p' }, t('guide.do.test.noApps')));
      }
      return actionCard({
        role: 'operator',
        title: t('guide.do.test.title'),
        help: t('guide.do.test.help'),
        button: t('guide.do.test.go'),
        fields: [
          { name: 'application', label: t('guide.do.test.app'), type: 'select', options: apps },
          { name: 'name', label: t('guide.do.test.name'), placeholder: t('guide.do.test.namePh') },
          { name: 'path', label: t('guide.do.test.path'), placeholder: '/' },
          { name: 'title', label: t('guide.do.test.title_contains'), placeholder: t('guide.do.test.titlePh') },
        ],
        submit: function (v) {
          var steps = [{ type: 'open', url: v.path ? v.path : '/' }];
          // The assertion is optional: opening the page IS a test (it fails on a
          // 5xx, a TLS error or a timeout), and a reader who has not decided what
          // the title should say must not be forced to invent one.
          if (v.title) steps.push({ type: 'assert_title_contains', value: v.title });
          return api(API + '/tests', {
            method: 'POST',
            body: {
              application_id: Number(v.application),
              name: v.name,
              definition: { version: 1, name: v.name, steps: steps },
            },
          });
        },
        success: function (created) { return t('guide.do.test.ok', { name: (created && created.name) || '' }); },
      });
    }

    function allowHostAction() {
      var apps = applicationOptions();
      if (!apps.length) {
        return el('div', { class: 'guide-action guide-action-blocked' },
          el('h4', { class: 'guide-h4' }, t('guide.do.allow.title')),
          el('p', { class: 'guide-p' }, t('guide.do.allow.noApps')));
      }
      return actionCard({
        role: 'admin',
        title: t('guide.do.allow.title'),
        help: t('guide.do.allow.help'),
        button: t('guide.do.allow.go'),
        fields: [
          { name: 'application', label: t('guide.do.allow.app'), type: 'select', options: apps },
          { name: 'value', label: t('guide.do.allow.value'), placeholder: 'api.example.dk' },
        ],
        submit: function (v) {
          return api(API + '/applications/' + encodeURIComponent(v.application) + '/allowed-hosts', {
            method: 'POST', body: { value: v.value },
          });
        },
        success: function (created) {
          return t('guide.do.allow.ok', { value: (created && created.value) || '' });
        },
      });
    }

    // ------------------------------------------------------------ live checks
    // Each returns a node or null. They read `data`, which may be half-empty.
    function workerStatus() {
      var w = data && data.worker;
      if (!w) return status('unknown', t('guide.prereq.unknown'));
      if (w.connected) {
        return status('done', t('guide.prereq.ok', {
          workers: String(num(w.worker_count) === null ? 1 : w.worker_count),
          queued: String(num(w.queued) === null ? 0 : w.queued),
        }));
      }
      return status('warn', t('guide.prereq.none', { queued: String(num(w.queued) === null ? 0 : w.queued) }));
    }
    function roleStatus() {
      return isOperator()
        ? status('done', t('guide.prereq.role.ok'))
        : status('warn', t('guide.prereq.role.no'));
    }
    function countStatus(list, doneKey, noneKey) {
      if (!Array.isArray(list)) return status('unknown', t('guide.state.unknown'));
      if (!list.length) return status('todo', t(noneKey));
      return status('done', plural(doneKey, list.length));
    }

    // ------------------------------------------------------------- the steps
    // Each step: { id, icon, title(), body() }. `id` is stable — it is what the
    // stepper and the remembered position are keyed on.
    // ------------------------------------------------- live state (general)
    // The four non-assurance guides share one small bundle: the agents, the
    // locations, and (for an admin) the server settings. Every line below says
    // what was read — never what it assumed.
    function agentList() { return Array.isArray(data && data.agents) ? data.agents : null; }
    function locationList() { return Array.isArray(data && data.locations) ? data.locations : null; }
    function serverSetting(section, field) {
      var s = data && data.serverSettings;
      var sec = s && s[section] && typeof s[section] === 'object' ? s[section] : null;
      return sec && Object.prototype.hasOwnProperty.call(sec, field) ? sec[field] : undefined;
    }
    function agentsStatus() {
      var agents = agentList();
      if (!agents) return status('unknown', t('guide.state.unknown'));
      if (!agents.length) return status('todo', t('guide.mon.noAgents'));
      var offline = agents.filter(function (a) { return a && a.status !== 'online'; });
      if (offline.length) {
        return status('warn', plural('guide.mon.agentsOffline', offline.length, { total: String(agents.length) }));
      }
      return status('done', plural('guide.mon.agentsOnline', agents.length));
    }
    function locationsStatus() {
      var locations = locationList();
      var agents = agentList();
      if (!locations) return status('unknown', t('guide.state.unknown'));
      if (!locations.length) return status('todo', t('guide.mon.noLocations'));
      var placed = locations.filter(function (l) { return l && l.latitude != null && l.longitude != null; });
      var homeless = (agents || []).filter(function (a) { return a && !a.location_id; });
      if (placed.length < locations.length) {
        return status('warn', plural('guide.mon.locationsUnplaced', locations.length - placed.length,
          { total: String(locations.length) }));
      }
      if (homeless.length) return status('warn', plural('guide.mon.agentsNoSite', homeless.length));
      return status('done', plural('guide.mon.locationsOk', locations.length));
    }
    // Which traffic source each agent is on — the setting that decides whether
    // Flows and Topology have anything to draw at all.
    function trafficSourceStatus() {
      var agents = agentList();
      if (!agents) return status('unknown', t('guide.state.unknown'));
      if (!agents.length) return status('todo', t('guide.mon.noAgents'));
      var flowCapable = agents.filter(function (a) {
        var src = a && a.monitor_config && a.monitor_config.source;
        return src === 'netflow' || src === 'sflow';
      });
      if (!flowCapable.length) return status('todo', plural('guide.mon.noFlowSource', agents.length, { total: String(agents.length) }));
      return status('done', plural('guide.mon.flowSource', flowCapable.length, { total: String(agents.length) }));
    }
    function versionStatus() {
      var agents = agentList();
      if (!agents) return status('unknown', t('guide.state.unknown'));
      var versions = {};
      // The version an agent reports lives in its capabilities payload
      // (`capabilities.agentVersion`) — the agents row itself has no version
      // column, so reading `a.version` finds nothing on every install.
      agents.forEach(function (a) {
        var v = a && a.capabilities && a.capabilities.agentVersion;
        if (v) versions[v] = true;
      });
      var list = Object.keys(versions);
      if (!list.length) return status('todo', t('guide.fleet.noVersions'));
      if (list.length === 1) return status('done', t('guide.fleet.oneVersion', { version: list[0] }));
      return status('warn', t('guide.fleet.manyVersions', { count: String(list.length), versions: list.join(', ') }));
    }
    // The analysis + retention tables, live where the reader may read them.
    function serverValuesTable(section, rows) {
      var admin = isAdmin();
      var readable = !!(data && data.serverSettings && data.serverSettings[section]);
      return table([t('guide.col.setting'), t('guide.col.default'), t('guide.col.current'), t('guide.col.meaning')],
        rows.map(function (row) {
          var live = serverSetting(section, row[0]);
          var changed = live !== undefined && String(live) !== row[1];
          return [
            mono(section + '.' + row[0]),
            row[1],
            admin && readable
              ? el('span', { class: changed ? 'guide-changed' : '' }, String(live))
              : el('span', { class: 'guide-muted' }, t('guide.ins.adminOnly')),
            t(row[2]),
          ];
        }));
    }

    // ------------------------------------------------------------- Monitoring
    function monitoringSteps() { return [
      {
        id: 'intro',
        title: function () { return t('guide.mon.step.intro'); },
        body: function () {
          return [
            lead(t('guide.mon.intro.lead')),
            para(t('guide.mon.intro.order')),
            todo([t('guide.mon.intro.do1'), t('guide.mon.intro.do2'), t('guide.mon.intro.do3')]),
            note(t('guide.mon.intro.note')),
            actions(viewButton('changes', t('nav.view.changes'))),
          ];
        },
      },
      {
        id: 'changes',
        title: function () { return t('guide.mon.step.changes'); },
        body: function () {
          return [
            lead(t('guide.mon.changes.lead')),
            todo([t('guide.mon.changes.do1'), t('guide.mon.changes.do2'), t('guide.mon.changes.do3')]),
            values([
              [t('guide.mon.changes.r1.f'), t('guide.mon.changes.r1.v'), t('guide.mon.changes.r1.w')],
              [t('guide.mon.changes.r2.f'), t('guide.mon.changes.r2.v'), t('guide.mon.changes.r2.w')],
              [t('guide.mon.changes.r3.f'), t('guide.mon.changes.r3.v'), t('guide.mon.changes.r3.w')],
            ]),
            watch(t('guide.mon.changes.watch')),
            actions(viewButton('changes', t('nav.view.changes'))),
          ];
        },
      },
      {
        id: 'fleet',
        title: function () { return t('guide.mon.step.fleet'); },
        body: function () {
          return [
            lead(t('guide.mon.fleet.lead')),
            el('h4', { class: 'guide-h4' }, t('guide.mon.fleet.verdictTitle')),
            table([t('guide.col.verdict'), t('guide.col.means')], [
              [mono('ok'), t('guide.mon.fleet.v.ok')],
              [mono('warn'), t('guide.mon.fleet.v.warn', { loss: HEALTH_THRESHOLDS.LOSS_WARN, jitter: HEALTH_THRESHOLDS.JITTER_WARN, z: HEALTH_THRESHOLDS.Z_WARN })],
              [mono('bad'), t('guide.mon.fleet.v.bad', { loss: HEALTH_THRESHOLDS.LOSS_BAD, jitter: HEALTH_THRESHOLDS.JITTER_BAD, z: HEALTH_THRESHOLDS.Z_BAD })],
              [mono('down'), t('guide.mon.fleet.v.down')],
              [mono('stale'), t('guide.mon.fleet.v.stale', { minutes: HEALTH_THRESHOLDS.STALE_MIN })],
              [mono('unknown'), t('guide.mon.fleet.v.unknown')],
            ]),
            values([
              [t('guide.mon.fleet.r0.f'), t('guide.mon.fleet.r0.v', { samples: HEALTH_THRESHOLDS.MIN_BASELINE }), t('guide.mon.fleet.r0.w')],
              [t('guide.mon.fleet.r1.f'), t('guide.mon.fleet.r1.v'), t('guide.mon.fleet.r1.w')],
              [t('guide.mon.fleet.r2.f'), t('guide.mon.fleet.r2.v'), t('guide.mon.fleet.r2.w')],
            ]),
            agentsStatus(),
            note(t('guide.mon.fleet.note')),
            actions(viewButton('fleet', t('nav.view.fleet'))),
          ];
        },
      },
      {
        id: 'traffic',
        title: function () { return t('guide.mon.step.traffic'); },
        body: function () {
          return [
            lead(t('guide.mon.traffic.lead')),
            todo([t('guide.mon.traffic.do1'), t('guide.mon.traffic.do2'), t('guide.mon.traffic.do3')]),
            el('h4', { class: 'guide-h4' }, t('guide.mon.traffic.sourceTitle')),
            table([t('guide.col.source'), t('guide.col.means')], [
              [mono('proc'), t('guide.mon.traffic.src.proc')],
              [mono('snmp'), t('guide.mon.traffic.src.snmp')],
              [mono('netflow'), t('guide.mon.traffic.src.netflow')],
              [mono('sflow'), t('guide.mon.traffic.src.sflow')],
            ]),
            trafficSourceStatus(),
            note(t('guide.mon.traffic.note')),
            actions(viewButton('overview', t('nav.view.overview')),
              settingsTabButton('agents', t('guide.mon.traffic.settingsBtn'))),
          ];
        },
      },
      {
        id: 'sites',
        title: function () { return t('guide.mon.step.sites'); },
        body: function () {
          return [
            lead(t('guide.mon.sites.lead')),
            todo([t('guide.mon.sites.do1'), t('guide.mon.sites.do2'), t('guide.mon.sites.do3')]),
            values([
              [t('guide.mon.sites.r1.f'), t('guide.mon.sites.r1.v'), t('guide.mon.sites.r1.w')],
              [t('guide.mon.sites.r2.f'), t('guide.mon.sites.r2.v'), t('guide.mon.sites.r2.w')],
              [t('guide.mon.sites.r3.f'), t('guide.mon.sites.r3.v'), t('guide.mon.sites.r3.w')],
            ]),
            locationsStatus(),
            createSiteAction(),
            note(t('guide.mon.sites.note')),
            actions(viewButton('locations', t('nav.view.locations')), viewButton('map', t('nav.view.map'))),
          ];
        },
      },
      {
        id: 'destinations',
        title: function () { return t('guide.mon.step.destinations'); },
        body: function () {
          return [
            lead(t('guide.mon.dest.lead')),
            values([
              [t('guide.mon.dest.r1.f'), t('guide.mon.dest.r1.v'), t('guide.mon.dest.r1.w')],
              [t('guide.mon.dest.r2.f'), t('guide.mon.dest.r2.v'), t('guide.mon.dest.r2.w')],
              [t('guide.mon.dest.r3.f'), t('guide.mon.dest.r3.v'), t('guide.mon.dest.r3.w')],
            ]),
            watch(t('guide.mon.dest.watch')),
            note(t('guide.mon.dest.note')),
            actions(viewButton('geo', t('nav.view.geo')),
              settingsTabButton('map', t('guide.mon.dest.settingsBtn'))),
          ];
        },
      },
      {
        id: 'done',
        title: function () { return t('guide.mon.step.done'); },
        body: function () {
          return [
            lead(t('guide.mon.done.lead')),
            el('h4', { class: 'guide-h4' }, t('guide.mon.done.listTitle')),
            todo([t('guide.mon.done.w1'), t('guide.mon.done.w2'), t('guide.mon.done.w3')]),
            note(t('guide.mon.done.note')),
            actions(viewButton('changes', t('nav.view.changes')), docsButton('tour')),
          ];
        },
      },
    ]; }

    // ------------------------------------------------------------------ Fleet
    function fleetSteps() { return [
      {
        id: 'intro',
        title: function () { return t('guide.fleet.step.intro'); },
        body: function () {
          return [
            lead(t('guide.fleet.intro.lead')),
            para(t('guide.fleet.intro.order')),
            agentsStatus(),
            note(t('guide.fleet.intro.note')),
            actions(viewButton('agents', t('nav.view.agents'))),
          ];
        },
      },
      {
        id: 'enroll',
        title: function () { return t('guide.fleet.step.enroll'); },
        body: function () {
          return [
            lead(t('guide.fleet.enroll.lead')),
            todo([t('guide.fleet.enroll.do1'), t('guide.fleet.enroll.do2'), t('guide.fleet.enroll.do3'), t('guide.fleet.enroll.do4')]),
            values([
              [t('guide.fleet.enroll.r1.f'), t('guide.fleet.enroll.r1.v'), t('guide.fleet.enroll.r1.w')],
              [t('guide.fleet.enroll.r2.f'), t('guide.fleet.enroll.r2.v'), t('guide.fleet.enroll.r2.w')],
              [t('guide.fleet.enroll.r3.f'), t('guide.fleet.enroll.r3.v'), t('guide.fleet.enroll.r3.w')],
            ]),
            watch(t('guide.fleet.enroll.watch')),
            enrollmentCodeAction(),
            actions(viewButton('enrollment', t('nav.view.enrollment')),
              settingsTabButton('agentkey', t('guide.fleet.enroll.keyBtn'))),
          ];
        },
      },
      {
        id: 'agents',
        title: function () { return t('guide.fleet.step.agents'); },
        body: function () {
          return [
            lead(t('guide.fleet.agents.lead')),
            todo([t('guide.fleet.agents.do1'), t('guide.fleet.agents.do2'), t('guide.fleet.agents.do3')]),
            values([
              [t('guide.fleet.agents.r1.f'), t('guide.fleet.agents.r1.v'), t('guide.fleet.agents.r1.w')],
              [t('guide.fleet.agents.r2.f'), t('guide.fleet.agents.r2.v'), t('guide.fleet.agents.r2.w')],
              [t('guide.fleet.agents.r3.f'), t('guide.fleet.agents.r3.v'), t('guide.fleet.agents.r3.w')],
            ]),
            agentsStatus(),
            note(t('guide.fleet.agents.note')),
            actions(viewButton('agents', t('nav.view.agents'))),
          ];
        },
      },
      {
        id: 'interfaces',
        title: function () { return t('guide.fleet.step.interfaces'); },
        body: function () {
          return [
            lead(t('guide.fleet.iface.lead')),
            el('h4', { class: 'guide-h4' }, t('guide.fleet.iface.verdictTitle')),
            table([t('guide.col.verdict'), t('guide.col.means')], [
              [mono('down'), t('guide.fleet.iface.v.down')],
              [mono('bad'), t('guide.fleet.iface.v.bad', { util: HEALTH_THRESHOLDS.IFACE_UTIL_BAD })],
              [mono('warn'), t('guide.fleet.iface.v.warn', { util: HEALTH_THRESHOLDS.IFACE_UTIL_WARN })],
              [mono('ok'), t('guide.fleet.iface.v.ok')],
            ]),
            values([
              [t('guide.fleet.iface.r1.f'), t('guide.fleet.iface.r1.v'), t('guide.fleet.iface.r1.w')],
              [t('guide.fleet.iface.r2.f'), t('guide.fleet.iface.r2.v'), t('guide.fleet.iface.r2.w')],
              [t('guide.fleet.iface.r3.f'), t('guide.fleet.iface.r3.v'), t('guide.fleet.iface.r3.w')],
            ]),
            note(t('guide.fleet.iface.note')),
            actions(viewButton('interfaces', t('nav.view.interfaces')), viewButton('delta', t('nav.view.delta'))),
          ];
        },
      },
      {
        id: 'nics',
        title: function () { return t('guide.fleet.step.nics'); },
        body: function () {
          return [
            lead(t('guide.fleet.nics.lead')),
            values([
              [t('guide.fleet.nics.r1.f'), t('guide.fleet.nics.r1.v'), t('guide.fleet.nics.r1.w')],
              [t('guide.fleet.nics.r2.f'), t('guide.fleet.nics.r2.v'), t('guide.fleet.nics.r2.w')],
            ]),
            note(t('guide.fleet.nics.note')),
            actions(viewButton('nics', t('nav.view.nics'))),
          ];
        },
      },
      {
        id: 'updates',
        title: function () { return t('guide.fleet.step.updates'); },
        body: function () {
          return [
            lead(t('guide.fleet.updates.lead')),
            todo([t('guide.fleet.updates.do1'), t('guide.fleet.updates.do2'), t('guide.fleet.updates.do3')]),
            versionStatus(),
            watch(t('guide.fleet.updates.watch')),
            actions(settingsTabButton('updates', t('guide.fleet.updates.btn')), viewButton('agents', t('nav.view.agents'))),
          ];
        },
      },
      {
        id: 'done',
        title: function () { return t('guide.fleet.step.done'); },
        body: function () {
          return [
            lead(t('guide.fleet.done.lead')),
            el('h4', { class: 'guide-h4' }, t('guide.done.weeklyTitle')),
            todo([t('guide.fleet.done.w1'), t('guide.fleet.done.w2'), t('guide.fleet.done.w3')]),
            note(t('guide.fleet.done.note')),
            actions(viewButton('fleet', t('nav.view.fleet'))),
          ];
        },
      },
    ]; }

    // ------------------------------------------------------------ Diagnostics
    function diagnosticsSteps() { return [
      {
        id: 'intro',
        title: function () { return t('guide.diag.step.intro'); },
        body: function () {
          return [
            lead(t('guide.diag.intro.lead')),
            table([t('guide.diag.intro.toolCol'), t('guide.diag.intro.qCol')], [
              [t('guide.diag.intro.t1.f'), t('guide.diag.intro.t1.v')],
              [t('guide.diag.intro.t2.f'), t('guide.diag.intro.t2.v')],
              [t('guide.diag.intro.t3.f'), t('guide.diag.intro.t3.v')],
              [t('guide.diag.intro.t4.f'), t('guide.diag.intro.t4.v')],
            ]),
            note(t('guide.diag.intro.note')),
            actions(viewButton('probes', t('nav.view.probes'))),
          ];
        },
      },
      {
        id: 'probes',
        title: function () { return t('guide.diag.step.probes'); },
        body: function () {
          return [
            lead(t('guide.diag.probes.lead')),
            todo([t('guide.diag.probes.do1'), t('guide.diag.probes.do2'), t('guide.diag.probes.do3')]),
            el('h4', { class: 'guide-h4' }, t('guide.diag.probes.pickTitle')),
            table([t('guide.diag.probes.symptomCol'), t('guide.diag.probes.probeCol'), t('guide.col.why')], [
              [t('guide.diag.probes.s1.f'), mono('ping'), t('guide.diag.probes.s1.w')],
              [t('guide.diag.probes.s2.f'), mono('tcp'), t('guide.diag.probes.s2.w')],
              [t('guide.diag.probes.s3.f'), mono('dns'), t('guide.diag.probes.s3.w')],
              [t('guide.diag.probes.s4.f'), mono('traceroute'), t('guide.diag.probes.s4.w')],
              [t('guide.diag.probes.s5.f'), mono('curl'), t('guide.diag.probes.s5.w')],
              [t('guide.diag.probes.s6.f'), mono('pageload'), t('guide.diag.probes.s6.w')],
            ]),
            runProbeAction(),
            note(t('guide.diag.probes.note')),
            actions(viewButton('probes', t('nav.view.probes'))),
          ];
        },
      },
      {
        id: 'tests',
        title: function () { return t('guide.diag.step.tests'); },
        body: function () {
          return [
            lead(t('guide.diag.tests.lead')),
            todo([t('guide.diag.tests.do1'), t('guide.diag.tests.do2'), t('guide.diag.tests.do3'), t('guide.diag.tests.do4')]),
            values([
              [t('guide.diag.tests.r1.f'), t('guide.diag.tests.r1.v'), t('guide.diag.tests.r1.w')],
              [t('guide.diag.tests.r2.f'), t('guide.diag.tests.r2.v'), t('guide.diag.tests.r2.w')],
              [t('guide.diag.tests.r3.f'), t('guide.diag.tests.r3.v'), t('guide.diag.tests.r3.w')],
              [t('guide.diag.tests.r4.f'), t('guide.diag.tests.r4.v'), t('guide.diag.tests.r4.w')],
            ]),
            note(t('guide.diag.tests.note')),
            actions(viewButton('tests', t('nav.view.tests')), viewButton('transactions', t('nav.view.transactions'))),
          ];
        },
      },
      {
        id: 'flows',
        title: function () { return t('guide.diag.step.flows'); },
        body: function () {
          return [
            lead(t('guide.diag.flows.lead')),
            todo([t('guide.diag.flows.do1'), t('guide.diag.flows.do2'), t('guide.diag.flows.do3')]),
            values([
              [t('guide.diag.flows.r1.f'), t('guide.diag.flows.r1.v'), t('guide.diag.flows.r1.w')],
              [t('guide.diag.flows.r2.f'), t('guide.diag.flows.r2.v'), t('guide.diag.flows.r2.w')],
            ]),
            trafficSourceStatus(),
            watch(t('guide.diag.flows.watch')),
            actions(viewButton('flows', t('nav.view.flows')), viewButton('topology', t('nav.view.topology'))),
          ];
        },
      },
      {
        id: 'outage',
        title: function () { return t('guide.diag.step.outage'); },
        body: function () {
          return [
            lead(t('guide.diag.outage.lead')),
            todo([t('guide.diag.outage.do1'), t('guide.diag.outage.do2'), t('guide.diag.outage.do3'), t('guide.diag.outage.do4')]),
            el('h4', { class: 'guide-h4' }, t('guide.diag.outage.colourTitle')),
            table([t('guide.col.colour'), t('guide.col.means')], [
              [t('guide.diag.outage.c1.f'), t('guide.diag.outage.c1.v')],
              [t('guide.diag.outage.c2.f'), t('guide.diag.outage.c2.v')],
              [t('guide.diag.outage.c3.f'), t('guide.diag.outage.c3.v')],
            ]),
            note(t('guide.diag.outage.note')),
            actions(viewButton('troubleshooting', t('nav.view.troubleshooting')),
              viewButton('investigation', t('nav.view.investigation'))),
          ];
        },
      },
      {
        id: 'done',
        title: function () { return t('guide.diag.step.done'); },
        body: function () {
          return [
            lead(t('guide.diag.done.lead')),
            table([t('guide.col.see'), t('guide.col.means')], [
              [t('guide.diag.done.p1.f'), t('guide.diag.done.p1.v')],
              [t('guide.diag.done.p2.f'), t('guide.diag.done.p2.v')],
              [t('guide.diag.done.p3.f'), t('guide.diag.done.p3.v')],
              [t('guide.diag.done.p4.f'), t('guide.diag.done.p4.v')],
            ]),
            note(t('guide.diag.done.note')),
            actions(viewButton('troubleshooting', t('nav.view.troubleshooting')), docsButton('assurance')),
          ];
        },
      },
    ]; }

    // --------------------------------------------------------------- Insights
    function insightsSteps() { return [
      {
        id: 'intro',
        title: function () { return t('guide.ins.step.intro'); },
        body: function () {
          return [
            lead(t('guide.ins.intro.lead')),
            el('h4', { class: 'guide-h4' }, t('guide.ins.intro.vocabTitle')),
            table([t('guide.col.word'), t('guide.col.means')], [
              [t('guide.ins.intro.v1.f'), t('guide.ins.intro.v1.v')],
              [t('guide.ins.intro.v2.f'), t('guide.ins.intro.v2.v')],
              [t('guide.ins.intro.v3.f'), t('guide.ins.intro.v3.v')],
              [t('guide.ins.intro.v4.f'), t('guide.ins.intro.v4.v')],
            ]),
            note(t('guide.ins.intro.note')),
            actions(viewButton('findings', t('nav.view.findings'))),
          ];
        },
      },
      {
        id: 'analysis',
        title: function () { return t('guide.ins.step.analysis'); },
        body: function () {
          return [
            lead(t('guide.ins.analysis.lead')),
            para(t('guide.ins.analysis.how')),
            serverValuesTable('analysis', ANALYSIS_VALUES),
            note(t('guide.ins.analysis.note')),
            actions(viewButton('findings', t('nav.view.findings')),
              settingsTabButton('analyse', t('guide.ins.analysis.btn'))),
          ];
        },
      },
      {
        id: 'events',
        title: function () { return t('guide.ins.step.events'); },
        body: function () {
          return [
            lead(t('guide.ins.events.lead')),
            todo([t('guide.ins.events.do1'), t('guide.ins.events.do2'), t('guide.ins.events.do3')]),
            values([
              [t('guide.ins.events.r1.f'), t('guide.ins.events.r1.v'), t('guide.ins.events.r1.w')],
              [t('guide.ins.events.r2.f'), t('guide.ins.events.r2.v'), t('guide.ins.events.r2.w')],
              [t('guide.ins.events.r3.f'), t('guide.ins.events.r3.v'), t('guide.ins.events.r3.w')],
            ]),
            note(t('guide.ins.events.note')),
            actions(viewButton('events', t('nav.view.events')), viewButton('clusters', t('nav.view.clusters'))),
          ];
        },
      },
      {
        id: 'alerting',
        title: function () { return t('guide.ins.step.alerting'); },
        body: function () {
          return [
            lead(t('guide.ins.alerting.lead')),
            todo([t('guide.ins.alerting.do1'), t('guide.ins.alerting.do2'), t('guide.ins.alerting.do3')]),
            values([
              [t('guide.ins.alerting.r1.f'), t('guide.ins.alerting.r1.v'), t('guide.ins.alerting.r1.w')],
              [t('guide.ins.alerting.r2.f'), t('guide.ins.alerting.r2.v'), t('guide.ins.alerting.r2.w')],
              [t('guide.ins.alerting.r3.f'), t('guide.ins.alerting.r3.v'), t('guide.ins.alerting.r3.w')],
            ]),
            note(t('guide.ins.alerting.note')),
            actions(settingsTabButton('alerting', t('guide.openAlerting')),
              settingsTabButton('severity', t('guide.ins.alerting.sevBtn')),
              settingsTabButton('maintenance', t('guide.ins.alerting.maintBtn'))),
          ];
        },
      },
      {
        id: 'retention',
        title: function () { return t('guide.ins.step.retention'); },
        body: function () {
          return [
            lead(t('guide.ins.retention.lead')),
            serverValuesTable('retention', RETENTION_VALUES),
            watch(t('guide.ins.retention.watch')),
            actions(settingsTabButton('retention', t('guide.ins.retention.btn')),
              settingsTabButton('database', t('guide.ins.retention.dbBtn'))),
          ];
        },
      },
      {
        id: 'reporting',
        title: function () { return t('guide.ins.step.reporting'); },
        body: function () {
          return [
            lead(t('guide.ins.reporting.lead')),
            todo([t('guide.ins.reporting.do1'), t('guide.ins.reporting.do2'), t('guide.ins.reporting.do3')]),
            values([
              [t('guide.ins.reporting.r1.f'), t('guide.ins.reporting.r1.v'), t('guide.ins.reporting.r1.w')],
              [t('guide.ins.reporting.r2.f'), t('guide.ins.reporting.r2.v'), t('guide.ins.reporting.r2.w')],
            ]),
            note(t('guide.ins.reporting.note')),
            actions(viewButton('reporting', t('nav.view.reporting'))),
          ];
        },
      },
      {
        id: 'done',
        title: function () { return t('guide.ins.step.done'); },
        body: function () {
          return [
            lead(t('guide.ins.done.lead')),
            el('h4', { class: 'guide-h4' }, t('guide.done.weeklyTitle')),
            todo([t('guide.ins.done.w1'), t('guide.ins.done.w2'), t('guide.ins.done.w3')]),
            note(t('guide.ins.done.note')),
            actions(viewButton('findings', t('nav.view.findings')), docsButton('what-is')),
          ];
        },
      },
    ]; }

    // ---------------------------------------------------------------- tracks
    // One array per guide. A step is { id, title(), body() } — it carries its
    // own title so adding a step never means editing a lookup somewhere else.
    function assuranceSteps() { return [
      {
        id: 'intro',
        title: function () { return t('guide.step.intro'); },
        body: function () {
          return [
            lead(t('guide.intro.lead')),
            para(t('guide.intro.order')),
            todo([t('guide.intro.do1'), t('guide.intro.do2'), t('guide.intro.do3')]),
            note(t('guide.intro.note')),
            actions(tabButton('health'), docsButton('assurance')),
          ];
        },
      },
      {
        id: 'prereq',
        title: function () { return t('guide.step.prereq'); },
        body: function () {
          return [
            lead(t('guide.prereq.lead')),
            values([
              [t('guide.prereq.r1.f'), mono('service_tests'), t('guide.prereq.r1.w')],
              [t('guide.prereq.r2.f'), mono('npm run service-test-worker'), t('guide.prereq.r2.w')],
              [t('guide.prereq.r3.f'), t('guide.prereq.r3.v'), t('guide.prereq.r3.w')],
            ]),
            workerStatus(),
            roleStatus(),
            note(t('guide.prereq.note')),
            actions(tabButton('runs'), docsButton('assurance-worker')),
          ];
        },
      },
      {
        id: 'application',
        title: function () { return t('guide.step.application'); },
        body: function () {
          return [
            lead(t('guide.app.lead')),
            todo([t('guide.app.do1'), t('guide.app.do2'), t('guide.app.do3'), t('guide.app.do4')]),
            values([
              [t('guide.app.r1.f'), t('guide.app.r1.v'), t('guide.app.r1.w')],
              [t('guide.app.r2.f'), mono('https://app.example.dk'), t('guide.app.r2.w')],
              [t('guide.app.r3.f'), t('guide.app.r3.v'), t('guide.app.r3.w')],
              [t('guide.app.r4.f'), t('guide.app.r4.v'), t('guide.app.r4.w')],
            ]),
            countStatus(data && data.apps, 'guide.app.count', 'guide.app.none'),
            createApplicationAction(),
            note(t('guide.app.note')),
            actions(tabButton('applications')),
          ];
        },
      },
      {
        id: 'allowlist',
        title: function () { return t('guide.step.allowlist'); },
        body: function () {
          var cap = quote('allowlist', 'maxAddressesPerApplication');
          var prefix = quote('allowlist', 'minCidrPrefix');
          return [
            lead(t('guide.allow.lead')),
            watch(t('guide.allow.watch')),
            todo([t('guide.allow.do1'), t('guide.allow.do2'), t('guide.allow.do3'), t('guide.allow.do4')]),
            values([
              [mono('host'), mono('api.example.dk'), t('guide.allow.r1.w')],
              [mono('ip'), mono('10.20.30.40'), t('guide.allow.r2.w')],
              [mono('cidr'), mono('10.20.30.0/24'), t('guide.allow.r3.w')],
              cap === null ? null : [mono('allowlist.maxAddressesPerApplication'), String(cap), t('guide.allow.r4.w')],
              prefix === null ? null : [mono('allowlist.minCidrPrefix'), '/' + String(prefix), t('guide.allow.r5.w')],
            ]),
            el('h4', { class: 'guide-h4' }, t('guide.allow.denyTitle')),
            table([t('guide.col.range'), t('guide.col.why')], [
              [mono('127.0.0.0/8'), t('guide.allow.deny.loopback')],
              [mono('169.254.0.0/16'), t('guide.allow.deny.linklocal')],
              [mono('0.0.0.0/8'), t('guide.allow.deny.unspecified')],
              [t('guide.allow.deny.broadcast.f'), t('guide.allow.deny.broadcast')],
            ]),
            allowlistStatus(),
            allowHostAction(),
            note(t('guide.allow.note')),
            actions(tabButton('applications')),
          ];
        },
      },
      {
        id: 'discovery',
        title: function () { return t('guide.step.discovery'); },
        body: function () {
          var pages = quote('discovery', 'maxPages');
          var depth = quote('discovery', 'maxDepth');
          var requests = quote('discovery', 'maxRequests');
          var navMs = quote('discovery', 'navigationTimeoutMs');
          var maxMs = quote('discovery', 'maxDurationMs');
          return [
            lead(t('guide.discovery.lead')),
            todo([t('guide.discovery.do1'), t('guide.discovery.do2'), t('guide.discovery.do3'), t('guide.discovery.do4')]),
            values([
              pages === null ? null : [mono('discovery.maxPages'), String(pages), t('guide.discovery.r1.w')],
              depth === null ? null : [mono('discovery.maxDepth'), String(depth), t('guide.discovery.r2.w')],
              requests === null ? null : [mono('discovery.maxRequests'), String(requests), t('guide.discovery.r3.w')],
              navMs === null ? null : [mono('discovery.navigationTimeoutMs'), ms(navMs), t('guide.discovery.r4.w')],
              maxMs === null ? null : [mono('discovery.maxDurationMs'), ms(maxMs), t('guide.discovery.r5.w')],
            ]),
            discoveryStatus(),
            watch(t('guide.discovery.watch')),
            note(t('guide.discovery.note')),
            actions(tabButton('applications'), settingsButton()),
          ];
        },
      },
      {
        id: 'tests',
        title: function () { return t('guide.step.tests'); },
        body: function () {
          var stepMs = quote('runner', 'stepTimeoutMs');
          var runMs = quote('runner', 'maxRunDurationMs');
          var maxSteps = quote('runner', 'maxStepsPerTest');
          var browser = quote('runner', 'browser');
          return [
            lead(t('guide.tests.lead')),
            stepTypeLine(),
            todo([t('guide.tests.do1'), t('guide.tests.do2'), t('guide.tests.do3'), t('guide.tests.do4')]),
            values([
              [t('guide.tests.r0.f'), t('guide.tests.r0.v'), t('guide.tests.r0.w')],
              stepMs === null ? null : [mono('runner.stepTimeoutMs'), ms(stepMs), t('guide.tests.r1.w')],
              runMs === null ? null : [mono('runner.maxRunDurationMs'), ms(runMs), t('guide.tests.r2.w')],
              maxSteps === null ? null : [mono('runner.maxStepsPerTest'), String(maxSteps), t('guide.tests.r3.w')],
              browser === null ? null : [mono('runner.browser'), String(browser), t('guide.tests.r4.w')],
            ]),
            countStatus(data && data.tests, 'guide.tests.count', 'guide.tests.none'),
            createTestAction(),
            note(t('guide.tests.note')),
            actions(tabButton('tests')),
          ];
        },
      },
      {
        id: 'journeys',
        title: function () { return t('guide.step.journeys'); },
        body: function () {
          return [
            lead(t('guide.journeys.lead')),
            todo([t('guide.journeys.do1'), t('guide.journeys.do2'), t('guide.journeys.do3'), t('guide.journeys.do4')]),
            values([
              [mono('critical'), t('guide.journeys.crit.critical.v'), t('guide.journeys.crit.critical.w')],
              [mono('high'), t('guide.journeys.crit.high.v'), t('guide.journeys.crit.high.w')],
              [mono('normal'), t('guide.journeys.crit.normal.v'), t('guide.journeys.crit.normal.w')],
              [mono('low'), t('guide.journeys.crit.low.v'), t('guide.journeys.crit.low.w')],
              [t('guide.journeys.req.f'), t('guide.journeys.req.v'), t('guide.journeys.req.w')],
            ]),
            el('h4', { class: 'guide-h4' }, t('guide.journeys.verdictTitle')),
            table([t('guide.col.fails'), t('guide.col.verdict')], [
              [t('guide.journeys.v1.f'), t('guide.journeys.v1.v')],
              [t('guide.journeys.v2.f'), t('guide.journeys.v2.v')],
              [t('guide.journeys.v3.f'), t('guide.journeys.v3.v')],
            ]),
            journeyStatus(),
            note(t('guide.journeys.note')),
            actions(tabButton('journeys')),
          ];
        },
      },
      {
        id: 'schedules',
        title: function () { return t('guide.step.schedules'); },
        body: function () {
          return [
            lead(t('guide.schedules.lead')),
            todo([t('guide.schedules.do1'), t('guide.schedules.do2'), t('guide.schedules.do3')]),
            values([
              [t('guide.schedules.r1.f'), t('guide.schedules.r1.v'), t('guide.schedules.r1.w')],
              [t('guide.schedules.r2.f'), t('guide.schedules.r2.v'), t('guide.schedules.r2.w')],
              [t('guide.schedules.r3.f'), t('guide.schedules.r3.v'), t('guide.schedules.r3.w')],
              [t('guide.schedules.r4.f'), t('guide.schedules.r4.v'), t('guide.schedules.r4.w')],
              [t('guide.schedules.r5.f'), t('guide.schedules.r5.v'), t('guide.schedules.r5.w')],
            ]),
            scheduleStatus(),
            note(t('guide.schedules.note')),
            actions(tabButton('schedules')),
          ];
        },
      },
      {
        id: 'run',
        title: function () { return t('guide.step.run'); },
        body: function () {
          var streakFloor = quote('assurance', 'failureStreak');
          return [
            lead(t('guide.run.lead')),
            el('h4', { class: 'guide-h4' }, t('guide.run.chainTitle')),
            code(t('guide.run.chain')),
            para(t('guide.run.chainRead')),
            el('h4', { class: 'guide-h4' }, t('guide.run.basisTitle')),
            table([t('guide.col.basis'), t('guide.col.meaning')], [
              [t('guide.run.basis.seen.f'), t('guide.run.basis.seen.w')],
              [t('guide.run.basis.deduced.f'), t('guide.run.basis.deduced.w')],
              [t('guide.run.basis.invisible.f'), t('guide.run.basis.invisible.w')],
            ]),
            values([
              [t('guide.run.r1.f'), t('guide.run.r1.v'), t('guide.run.r1.w')],
              [t('guide.run.r2.f'), t('guide.run.r2.v'), t('guide.run.r2.w')],
              streakFloor === null ? null : [mono('assurance.failureStreak'), String(streakFloor), t('guide.run.r3.w')],
            ]),
            runStatus(),
            note(t('guide.run.note')),
            actions(tabButton('runs')),
          ];
        },
      },
      {
        id: 'health',
        title: function () { return t('guide.step.health'); },
        body: function () {
          return [
            lead(t('guide.health.lead')),
            table([t('guide.col.part'), t('guide.col.weight'), t('guide.col.meaning')], HEALTH_WEIGHTS.map(function (pair) {
              var text = healthPart(pair[0]);
              return [text[0], pair[1], text[1]];
            })),
            values([
              [t('guide.health.r1.f'), t('guide.health.r1.v'), t('guide.health.r1.w')],
              [t('guide.health.r2.f'), t('guide.health.r2.v'), t('guide.health.r2.w')],
              [t('guide.health.r3.f'), t('guide.health.r3.v'), t('guide.health.r3.w')],
            ]),
            note(t('guide.health.note')),
            actions(tabButton('health')),
          ];
        },
      },
      {
        id: 'incidents',
        title: function () { return t('guide.step.incidents'); },
        body: function () {
          var streak = quote('assurance', 'failureStreak');
          var warnDays = quote('assurance', 'certificateWarnDays');
          var critDays = quote('assurance', 'certificateCriticalDays');
          var retention = quote('assurance', 'incidentRetentionDays');
          return [
            lead(t('guide.incidents.lead')),
            code('open → investigating → identified → resolved → closed'),
            para(t('guide.incidents.lifecycle')),
            values([
              streak === null ? null : [mono('assurance.failureStreak'), String(streak), t('guide.incidents.r1.w')],
              warnDays === null ? null : [mono('assurance.certificateWarnDays'), t('guide.unit.days', { n: String(warnDays) }), t('guide.incidents.r2.w')],
              critDays === null ? null : [mono('assurance.certificateCriticalDays'), t('guide.unit.days', { n: String(critDays) }), t('guide.incidents.r3.w')],
              retention === null ? null : [mono('assurance.incidentRetentionDays'), t('guide.unit.days', { n: String(retention) }), t('guide.incidents.r4.w')],
              [t('guide.incidents.r5.f'), t('guide.incidents.r5.v'), t('guide.incidents.r5.w')],
            ]),
            incidentStatus(),
            note(t('guide.incidents.note')),
            actions(tabButton('health')),
          ];
        },
      },
      {
        id: 'monitors',
        title: function () { return t('guide.step.monitors'); },
        body: function () {
          var types = Array.isArray(data && data.monitorTypes) ? data.monitorTypes : [];
          var floor = quote('monitors', 'minIntervalSec');
          var domains = setting('monitors', 'mailRecipientDomains');
          return [
            lead(t('guide.monitors.lead')),
            para(t('guide.monitors.what')),
            todo([t('guide.monitors.do1'), t('guide.monitors.do2'), t('guide.monitors.do3'), t('guide.monitors.do4'), t('guide.monitors.do5'), t('guide.monitors.do6')]),
            // The catalogue is read from the server rather than listed here, so
            // a check type that ships later appears in the guide without an
            // edit — and the guide can never name one the server does not have.
            types.length
              ? table([t('guide.monitors.col.check'), t('guide.monitors.col.measures')],
                types.map(function (x) { return [x.label, x.measures ? x.measures.label : '—']; }))
              : null,
            values([
              [t('guide.monitors.r1.f'), t('guide.monitors.r1.v'), t('guide.monitors.r1.w')],
              [t('guide.monitors.r2.f'), t('guide.monitors.r2.v'), t('guide.monitors.r2.w')],
              floor === null ? null : [mono('monitors.minIntervalSec'), t('guide.unit.seconds', { n: String(floor) }), t('guide.monitors.r3.w')],
            ]),
            countStatus(data && data.monitors, 'guide.monitors.count', 'guide.monitors.none'),
            // Empty means "any address", which is worth saying out loud on a
            // screen that sends real mail.
            domains.value === undefined ? null : status(domains.value ? 'done' : 'warn',
              domains.value ? t('guide.monitors.domainsSet', { domains: String(domains.value) }) : t('guide.monitors.domainsOpen')),
            createMonitorAction(),
            watch(t('guide.monitors.watch')),
            note(t('guide.monitors.note')),
            actions(tabButton('monitors'), docsButton('assurance-monitors'), settingsButton()),
          ];
        },
      },
      {
        id: 'alerts',
        title: function () { return t('guide.step.alerts'); },
        body: function () {
          var notify = setting('assurance', 'notify');
          var group = setting('assurance', 'groupAlerts');
          return [
            lead(t('guide.alerts.lead')),
            table([t('guide.col.transition'), t('guide.col.alert')], [
              [t('guide.alerts.t1.f'), t('guide.alerts.t1.v')],
              [t('guide.alerts.t2.f'), t('guide.alerts.t2.v')],
              [t('guide.alerts.t3.f'), t('guide.alerts.t3.v')],
              [t('guide.alerts.t4.f'), t('guide.alerts.t4.v')],
            ]),
            values([
              [mono('assurance.notify'), t('guide.alerts.r1.v'), t('guide.alerts.r1.w')],
              [mono('assurance.groupAlerts'), t('guide.on'), t('guide.alerts.r2.w')],
              [t('guide.alerts.r3.f'), t('guide.alerts.r3.v'), t('guide.alerts.r3.w')],
            ]),
            notify.value === undefined ? null : status(notify.value ? 'done' : 'warn',
              notify.value ? t('guide.alerts.notifyOn') : t('guide.alerts.notifyOff')),
            group.value === false ? status('warn', t('guide.alerts.groupOff')) : null,
            note(t('guide.alerts.note')),
            actions(alertingButton(), settingsButton()),
          ];
        },
      },
      {
        id: 'values',
        title: function () { return t('guide.step.values'); },
        body: function () {
          return [
            lead(t('guide.values.lead')),
            settingsTable(),
            changedStatus(),
            note(t('guide.values.note')),
            actions(settingsButton()),
          ];
        },
      },
      {
        id: 'done',
        title: function () { return t('guide.step.done'); },
        body: function () {
          return [
            lead(t('guide.done.lead')),
            el('h4', { class: 'guide-h4' }, t('guide.done.weeklyTitle')),
            todo([t('guide.done.w1'), t('guide.done.w2'), t('guide.done.w3'), t('guide.done.w4')]),
            el('h4', { class: 'guide-h4' }, t('guide.done.troubleTitle')),
            table([t('guide.col.see'), t('guide.col.means')], [
              [t('guide.done.p1.f'), t('guide.done.p1.v')],
              [t('guide.done.p2.f'), t('guide.done.p2.v')],
              [t('guide.done.p3.f'), t('guide.done.p3.v')],
              [t('guide.done.p4.f'), t('guide.done.p4.v')],
              [t('guide.done.p5.f'), t('guide.done.p5.v')],
              [t('guide.done.p6.f'), t('guide.done.p6.v')],
              [t('guide.done.p7.f'), t('guide.done.p7.v')],
            ]),
            note(t('guide.done.note')),
            actions(tabButton('health'), docsButton('assurance'),
              el('button', { class: 'ghost small', onclick: function () { go(0); } }, t('guide.restart'))),
          ];
        },
      },
    ]; }

    // --------------------------------------------------- step-specific checks
    function allowlistStatus() {
      var apps = data && data.apps;
      var details = data && data.appDetails;
      if (!Array.isArray(apps) || !apps.length) return status('todo', t('guide.allow.noApps'));
      if (!Array.isArray(details) || !details.length) return status('unknown', t('guide.state.unknown'));
      var bare = details.filter(function (d) {
        return d && (!Array.isArray(d.allowed_hosts) || d.allowed_hosts.length === 0);
      });
      if (!bare.length) return status('done', plural('guide.allow.ok', details.length));
      return status('warn', plural('guide.allow.bare', bare.length,
        { names: bare.map(function (d) { return d.name; }).join(', ') }));
    }
    function discoveryStatus() {
      var apps = data && data.apps;
      if (!Array.isArray(apps)) return status('unknown', t('guide.state.unknown'));
      if (!apps.length) return status('todo', t('guide.allow.noApps'));
      var done = apps.filter(function (a) { return a && a.last_discovery; });
      if (!done.length) return status('todo', t('guide.discovery.none'));
      return status('done', plural('guide.discovery.count', done.length, { total: String(apps.length) }));
    }
    function stepTypeLine() {
      var cat = data && data.stepTypes && data.stepTypes.categories;
      if (!Array.isArray(cat) || !cat.length) return null;
      var count = cat.reduce(function (sum, c) {
        return sum + ((c && Array.isArray(c.steps)) ? c.steps.length : 0);
      }, 0);
      if (!count) return null;
      return para(t('guide.tests.stepTypes', { count: String(count), groups: String(cat.length) }));
    }
    function journeyStatus() {
      var j = data && data.journeys;
      if (!j || !Array.isArray(j.journeys)) return status('unknown', t('guide.state.unknown'));
      if (!j.journeys.length) return status('todo', t('guide.journeys.none'));
      return status('done', plural('guide.journeys.count', j.journeys.length));
    }
    function scheduleStatus() {
      var list = data && data.schedules;
      if (!Array.isArray(list)) return status('unknown', t('guide.state.unknown'));
      if (!list.length) return status('todo', t('guide.schedules.none'));
      var on = list.filter(function (s) { return s && s.enabled !== false; });
      if (!on.length) return status('warn', plural('guide.schedules.allOff', list.length));
      return status('done', plural('guide.schedules.count', on.length));
    }
    function runStatus() {
      var runs = data && data.runs;
      if (!Array.isArray(runs)) return status('unknown', t('guide.state.unknown'));
      if (!runs.length) return status('todo', t('guide.run.none'));
      var last = runs[0];
      return status('done', plural('guide.run.count', runs.length,
        { status: String((last && (last.status || last.verdict)) || '—') }));
    }
    function incidentStatus() {
      var sum = data && data.summary;
      if (!sum || !sum.open) return status('unknown', t('guide.state.unknown'));
      var open = num(sum.open.total);
      if (open === null) {
        // openCounts() is a map; total the numbers it does carry rather than
        // inventing a shape for it.
        open = Object.keys(sum.open).reduce(function (acc, k) {
          var v = num(sum.open[k]);
          return acc + (v === null ? 0 : v);
        }, 0);
      }
      if (!open) return status('done', t('guide.incidents.clear'));
      return status('warn', plural('guide.incidents.open', open));
    }
    function settingsTable() {
      var s = data && data.settings;
      if (!s || !s.settings) return el('div', { class: 'guide-empty' }, t('guide.values.unavailable'));
      var rows = VALUE_ROWS.map(function (row) {
        var pair = setting(row[0], row[1]);
        if (pair.def === undefined && pair.value === undefined) return null;
        var changed = pair.value !== undefined && pair.def !== undefined && pair.value !== pair.def;
        return [
          mono(row[0] + '.' + row[1]),
          settingText(row[1], pair.def),
          el('span', { class: changed ? 'guide-changed' : '' },
            settingText(row[1], pair.value !== undefined ? pair.value : pair.def)),
          t(row[2]),
        ];
      });
      return table([t('guide.col.setting'), t('guide.col.default'), t('guide.col.current'), t('guide.col.meaning')], rows);
    }
    function changedStatus() {
      var s = data && data.settings;
      if (!s || !s.settings) return status('unknown', t('guide.state.unknown'));
      var changed = VALUE_ROWS.filter(function (row) {
        var pair = setting(row[0], row[1]);
        return pair.value !== undefined && pair.def !== undefined && pair.value !== pair.def;
      });
      if (!changed.length) return status('done', t('guide.values.allDefault'));
      return status('done', plural('guide.values.changed', changed.length,
        { names: changed.map(function (row) { return row[0] + '.' + row[1]; }).join(', ') }));
    }

    // ------------------------------------------------------------------ shell
    // Which steps, and what the guide calls itself. Five literal branches
    // rather than a built key, for the reason statusLabel gives.
    function stepsForTrack() {
      if (track === 'monitoring') return monitoringSteps();
      if (track === 'fleet') return fleetSteps();
      if (track === 'diagnostics') return diagnosticsSteps();
      if (track === 'insights') return insightsSteps();
      return assuranceSteps();
    }
    function trackTitle() {
      if (track === 'monitoring') return t('guide.title.monitoring');
      if (track === 'fleet') return t('guide.title.fleet');
      if (track === 'diagnostics') return t('guide.title.diagnostics');
      if (track === 'insights') return t('guide.title.insights');
      return t('guide.title.assurance');
    }
    function trackSubtitle() {
      if (track === 'monitoring') return t('guide.sub.monitoring');
      if (track === 'fleet') return t('guide.sub.fleet');
      if (track === 'diagnostics') return t('guide.sub.diagnostics');
      if (track === 'insights') return t('guide.sub.insights');
      return t('guide.sub.assurance');
    }
    var STEPS = stepsForTrack();

    function clamp(n) { return Math.max(0, Math.min(STEPS.length - 1, n)); }
    function go(n) {
      step = clamp(n);
      writeStep(step);
      draw();
      // The reader pressed Next to read the next thing, not to stay looking at
      // the bottom of the last one.
      if (typeof host.scrollIntoView === 'function') {
        try { host.scrollIntoView({ block: 'start' }); } catch (e) { host.scrollIntoView(); }
      }
    }

    function stepper() {
      return el('ol', { class: 'guide-stepper', 'aria-label': t('guide.progress') }, STEPS.map(function (s, i) {
        return el('li', { class: 'guide-stepper-item' }, el('button', {
          class: 'guide-stepper-btn' + (i === step ? ' active' : '') + (i < step ? ' seen' : ''),
          'aria-current': i === step ? 'step' : null,
          onclick: function () { go(i); },
        }, el('span', { class: 'guide-stepper-n' }, String(i + 1)),
        el('span', { class: 'guide-stepper-label' }, s.title())));
      }));
    }

    function footer() {
      var last = step === STEPS.length - 1;
      return el('div', { class: 'guide-foot' },
        el('button', {
          class: 'ghost', disabled: step === 0 ? 'disabled' : null,
          onclick: function () { go(step - 1); },
        }, '← ' + t('guide.back')),
        el('span', { class: 'guide-count' }, t('guide.stepOf', { n: String(step + 1), total: String(STEPS.length) })),
        last
          ? el('button', { class: 'primary', onclick: function () { go(0); } }, t('guide.restart'))
          : el('button', { class: 'primary', onclick: function () { go(step + 1); } }, t('guide.next') + ' →'));
    }

    function draw() {
      var current = STEPS[clamp(step)];
      var body = el('div', { class: 'guide-step' });
      body.append(el('div', { class: 'guide-step-head' },
        el('span', { class: 'guide-step-num' }, String(step + 1) + '/' + String(STEPS.length)),
        el('h3', { class: 'guide-step-title' }, current.title())));
      var kids;
      try { kids = current.body(); } catch (e) { kids = [el('div', { class: 'guide-empty' }, errText(e))]; }
      kids.filter(Boolean).forEach(function (node) { body.append(node); });

      // replaceChildren() stringifies a null child into the literal text "null",
      // so the conditional banner is filtered out rather than handed over.
      host.replaceChildren.apply(host, [
        el('div', { class: 'guide-head' },
          el('h2', { class: 'guide-title' }, trackTitle()),
          el('p', { class: 'guide-sub' }, trackSubtitle()),
          el('p', { class: 'guide-sub guide-sub-count' }, t('guide.subtitle', { total: String(STEPS.length) }))),
        loadError ? el('div', { class: 'callout guide-stale' }, t('guide.stateUnavailable', { message: loadError })) : null,
        el('div', { class: 'guide-layout' }, stepper(), body),
        footer(),
      ].filter(Boolean));
      return host;
    }

    // A first paint before the probes answer: the guidance does not depend on
    // them, and a spinner in front of a document is a document nobody reads.
    draw();
    load();

    // Each guide reads only what its own steps can show. A guide that fetches
    // the whole product to colour one line is a guide that is slow for no
    // reason — and every probe below is one the reader's role can already make.
    function load() {
      if (track !== 'assurance') return loadGeneral();
      return loadAssurance();
    }

    // Monitoring / Fleet / Diagnostics / Insights. `GET /api/settings` is
    // admin-only, so it is asked for only by an admin: a 403 nobody could have
    // avoided is noise in the banner.
    function loadGeneral() {
      return Promise.all([
        probe('/agents'),
        probe('/locations'),
        isAdmin() ? probe('/api/settings') : Promise.resolve(null),
      ]).then(function (res) {
        data = { agents: res[0], locations: res[1], serverSettings: res[2] };
        draw();
      }).catch(function (e) {
        loadError = loadError || errText(e);
        draw();
      });
    }

    function loadAssurance() {
      return Promise.all([
        probe(API + '/runs/worker-status'),
        probe(API + '/applications'),
        probe(API + '/tests'),
        probe(API + '/journeys'),
        probe(API + '/schedules'),
        probe(API + '/runs'),
        probe(API + '/settings'),
        probe(API + '/assurance/summary'),
        probe(API + '/tests/step-types'),
        probe(API + '/monitors'),
        probe(API + '/monitors/types'),
      ]).then(function (res) {
        data = {
          worker: res[0], apps: res[1], tests: res[2], journeys: res[3], schedules: res[4],
          runs: res[5], settings: res[6], summary: res[7], stepTypes: res[8], appDetails: null,
          monitors: res[9], monitorTypes: res[10] && res[10].types,
        };
        // The allowlist check needs the per-application detail, and only for a
        // handful — a fleet of fifty applications is not worth fifty calls to
        // colour one status line.
        var apps = Array.isArray(data.apps) ? data.apps.slice(0, 5) : [];
        if (!apps.length) return draw();
        return Promise.all(apps.map(function (a) { return probe(API + '/applications/' + a.id); }))
          .then(function (details) {
            data.appDetails = details.filter(Boolean);
            draw();
          });
      }).catch(function (e) {
        // Nothing here should throw — probe() already swallows. Belt and braces:
        // a broken state read must never blank the page.
        loadError = loadError || errText(e);
        draw();
      });
      return host;
    }

    return host;
  }

  root.Guides = {
    create: create, TRACKS: TRACKS, HEALTH_WEIGHTS: HEALTH_WEIGHTS, VALUE_ROWS: VALUE_ROWS,
    ANALYSIS_VALUES: ANALYSIS_VALUES, RETENTION_VALUES: RETENTION_VALUES,
    HEALTH_THRESHOLDS: HEALTH_THRESHOLDS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
