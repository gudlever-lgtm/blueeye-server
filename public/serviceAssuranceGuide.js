// BlueEye Service Assurance — the user guide.
//
//   From an empty screen to a service that tells you when it breaks.
//
// A next-next walkthrough: one step per thing you actually do, in the order the
// module needs them done, and — the part a handbook never gets right — the
// VALUES to put in. Every number it quotes about the running system is read from
// that system (GET /settings returns the effective values AND the defaults), so
// a default that moves cannot leave this screen lying about it.
//
// Loaded as its own classic script (no build step, repo convention) and mounted
// by views.guide in app.js, which passes the shared helpers in rather than this
// file reaching into app.js globals — the same seam views.serviceAssurance uses.
//
// It reads and never writes. Every probe it makes is wrapped: a 403 (no
// licence), a 404 (an endpoint that moved) or a 500 must not take the guidance
// down with it, because the guidance is the point and the live state is the
// garnish.

(function (root) {
  'use strict';

  var API = '/api/service-tests';
  // Where the reader got to, remembered per browser. A guide that starts from
  // the top every time you come back is one nobody finishes.
  var STORAGE_KEY = 'blueeye.sa.guide.step';

  // The health score's weights. Hardcoded here because nothing serves them, and
  // pinned to src/serviceTests/health/serviceHealth.js by
  // test/serviceAssuranceGuide.test.js — so this table cannot drift from the
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

  function create(ctx) {
    var el = ctx.el;
    var api = ctx.api;
    var t = ctx.t;
    var isOperator = typeof ctx.isOperator === 'function' ? ctx.isOperator : function () { return false; };
    // Deep links into the module's own screens, Settings and the handbook. All
    // optional: a host that does not supply one simply gets no button, which is
    // better than a button that does nothing.
    var openTab = typeof ctx.openTab === 'function' ? ctx.openTab : null;
    var openSettings = typeof ctx.openSettings === 'function' ? ctx.openSettings : null;
    var openDocs = typeof ctx.openDocs === 'function' ? ctx.openDocs : null;

    var host = el('div', { class: 'guide' });
    // Everything the live checks need, loaded once when the view is mounted.
    // `null` on any member means "we could not read this" — never "it is empty".
    var data = null;
    var loadError = null;
    var step = readStep();

    // ------------------------------------------------------------- utilities
    function readStep() {
      try {
        var raw = root.localStorage.getItem(STORAGE_KEY);
        var n = parseInt(raw, 10);
        return isFinite(n) && n >= 0 ? n : 0;
      } catch (e) { return 0; }
    }
    function writeStep(n) {
      try { root.localStorage.setItem(STORAGE_KEY, String(n)); } catch (e) { /* private mode */ }
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

    // The four parts of the score, and the fourteen step titles. Both spelled out
    // for the same reason as statusLabel above.
    function healthPart(id) {
      if (id === 'functional') return [t('guide.health.part.functional'), t('guide.health.part.functional.w')];
      if (id === 'availability') return [t('guide.health.part.availability'), t('guide.health.part.availability.w')];
      if (id === 'api') return [t('guide.health.part.api'), t('guide.health.part.api.w')];
      return [t('guide.health.part.performance'), t('guide.health.part.performance.w')];
    }
    function stepTitle(id) {
      if (id === 'intro') return t('guide.step.intro');
      if (id === 'prereq') return t('guide.step.prereq');
      if (id === 'application') return t('guide.step.application');
      if (id === 'allowlist') return t('guide.step.allowlist');
      if (id === 'discovery') return t('guide.step.discovery');
      if (id === 'tests') return t('guide.step.tests');
      if (id === 'journeys') return t('guide.step.journeys');
      if (id === 'schedules') return t('guide.step.schedules');
      if (id === 'run') return t('guide.step.run');
      if (id === 'health') return t('guide.step.health');
      if (id === 'incidents') return t('guide.step.incidents');
      if (id === 'alerts') return t('guide.step.alerts');
      if (id === 'values') return t('guide.step.values');
      return t('guide.step.done');
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
      return t('sa.tab.health');
    }
    function tabButton(tab) {
      if (!openTab) return null;
      return el('button', {
        class: 'ghost small',
        onclick: function () { openTab(tab); },
      }, t('guide.openTab', { tab: tabLabel(tab) }));
    }
    function settingsButton() {
      if (!openSettings) return null;
      return el('button', { class: 'ghost small', onclick: function () { openSettings('assurance'); } },
        t('guide.openSettings'));
    }
    function alertingButton() {
      if (!openSettings) return null;
      return el('button', { class: 'ghost small', onclick: function () { openSettings('alerting'); } },
        t('guide.openAlerting'));
    }
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
      return status('done', t(doneKey, { count: String(list.length) }));
    }

    // ------------------------------------------------------------- the steps
    // Each step: { id, icon, title(), body() }. `id` is stable — it is what the
    // stepper and the remembered position are keyed on.
    var STEPS = [
      {
        id: 'intro',
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
            note(t('guide.app.note')),
            actions(tabButton('applications')),
          ];
        },
      },
      {
        id: 'allowlist',
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
            note(t('guide.allow.note')),
            actions(tabButton('applications')),
          ];
        },
      },
      {
        id: 'discovery',
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
            note(t('guide.tests.note')),
            actions(tabButton('tests')),
          ];
        },
      },
      {
        id: 'journeys',
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
        id: 'alerts',
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
    ];

    // --------------------------------------------------- step-specific checks
    function allowlistStatus() {
      var apps = data && data.apps;
      var details = data && data.appDetails;
      if (!Array.isArray(apps) || !apps.length) return status('todo', t('guide.allow.noApps'));
      if (!Array.isArray(details) || !details.length) return status('unknown', t('guide.state.unknown'));
      var bare = details.filter(function (d) {
        return d && (!Array.isArray(d.allowed_hosts) || d.allowed_hosts.length === 0);
      });
      if (!bare.length) return status('done', t('guide.allow.ok', { count: String(details.length) }));
      return status('warn', t('guide.allow.bare', {
        count: String(bare.length),
        names: bare.map(function (d) { return d.name; }).join(', '),
      }));
    }
    function discoveryStatus() {
      var apps = data && data.apps;
      if (!Array.isArray(apps)) return status('unknown', t('guide.state.unknown'));
      if (!apps.length) return status('todo', t('guide.allow.noApps'));
      var done = apps.filter(function (a) { return a && a.last_discovery; });
      if (!done.length) return status('todo', t('guide.discovery.none'));
      return status('done', t('guide.discovery.count', { count: String(done.length), total: String(apps.length) }));
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
      return status('done', t('guide.journeys.count', { count: String(j.journeys.length) }));
    }
    function scheduleStatus() {
      var list = data && data.schedules;
      if (!Array.isArray(list)) return status('unknown', t('guide.state.unknown'));
      if (!list.length) return status('todo', t('guide.schedules.none'));
      var on = list.filter(function (s) { return s && s.enabled !== false; });
      if (!on.length) return status('warn', t('guide.schedules.allOff', { count: String(list.length) }));
      return status('done', t('guide.schedules.count', { count: String(on.length) }));
    }
    function runStatus() {
      var runs = data && data.runs;
      if (!Array.isArray(runs)) return status('unknown', t('guide.state.unknown'));
      if (!runs.length) return status('todo', t('guide.run.none'));
      var last = runs[0];
      return status('done', t('guide.run.count', {
        count: String(runs.length),
        status: String((last && (last.status || last.verdict)) || '—'),
      }));
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
      return status('warn', t('guide.incidents.open', { count: String(open) }));
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
      return status('done', t('guide.values.changed', {
        count: String(changed.length),
        names: changed.map(function (row) { return row[0] + '.' + row[1]; }).join(', '),
      }));
    }

    // ------------------------------------------------------------------ shell
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
        el('span', { class: 'guide-stepper-label' }, stepTitle(s.id))));
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
        el('h3', { class: 'guide-step-title' }, stepTitle(current.id))));
      var kids;
      try { kids = current.body(); } catch (e) { kids = [el('div', { class: 'guide-empty' }, errText(e))]; }
      kids.filter(Boolean).forEach(function (node) { body.append(node); });

      // replaceChildren() stringifies a null child into the literal text "null",
      // so the conditional banner is filtered out rather than handed over.
      host.replaceChildren.apply(host, [
        el('div', { class: 'guide-head' },
          el('h2', { class: 'guide-title' }, t('guide.title')),
          el('p', { class: 'guide-sub' }, t('guide.subtitle', { total: String(STEPS.length) }))),
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

    function load() {
      Promise.all([
        probe(API + '/runs/worker-status'),
        probe(API + '/applications'),
        probe(API + '/tests'),
        probe(API + '/journeys'),
        probe(API + '/schedules'),
        probe(API + '/runs'),
        probe(API + '/settings'),
        probe(API + '/assurance/summary'),
        probe(API + '/tests/step-types'),
      ]).then(function (res) {
        data = {
          worker: res[0], apps: res[1], tests: res[2], journeys: res[3], schedules: res[4],
          runs: res[5], settings: res[6], summary: res[7], stepTypes: res[8], appDetails: null,
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

  root.ServiceAssuranceGuide = { create: create, HEALTH_WEIGHTS: HEALTH_WEIGHTS, VALUE_ROWS: VALUE_ROWS };
})(typeof window !== 'undefined' ? window : globalThis);
