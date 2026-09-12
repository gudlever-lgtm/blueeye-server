// BlueEye Service Assurance — the dashboard module.
//
//   Know when your digital services stop working — before your users do.
//
// Loaded as its own classic script (no build step, repo convention) and mounted
// by views.serviceAssurance in app.js, which passes the shared helpers in rather
// than this file reaching into app.js globals. That keeps the module liftable
// with the rest of Service Assurance (docs/service-assurance.md §2).
//
// Everything a normal user does here is forms and drag & drop. Selectors,
// timeouts and raw engine errors live behind "Technical details" and are never
// needed to build or read a test.

(function (root) {
  'use strict';

  var API = '/api/service-tests';
  // The module's own screens, in the order they are shown. Also the set a host
  // may deep-link into, so an unknown tab name falls back rather than rendering
  // an empty page.
  var TABS = ['applications', 'journeys', 'tests', 'runs', 'health', 'schedules'];

  function create(ctx) {
    var el = ctx.el;
    var api = ctx.api;
    var t = ctx.t;
    var toast = ctx.toast;
    var isAdmin = ctx.isAdmin;
    var isOperator = ctx.isOperator;
    // Opens the Documentation article on starting a worker. Optional — a host
    // that does not supply it simply gets the message without the link.
    var openDocs = typeof ctx.openDocs === 'function' ? ctx.openDocs : null;
    // Fetches a binary endpoint WITH the session header and returns an object
    // URL. Optional: a host that does not supply it simply gets no screenshot,
    // which is better than a broken image.
    var apiBlob = typeof ctx.apiBlob === 'function' ? ctx.apiBlob : null;

    // ---------------------------------------------------------------- state
    var state = {
      // The host can deep-link into a screen (its nav has an entry per tab);
      // absent, the module opens where it always did.
      tab: TABS.indexOf(ctx.tab) >= 0 ? ctx.tab : 'applications',
      applicationId: null,
      testId: null,
      runId: null,
      discoveryId: null,
      journeyId: null,
    };

    var host = el('div', { class: 'sa' });

    // ---------------------------------------------------------------- utils
    function err(e) { return (e && (e.message || e.error)) || String(e); }

    // Replaces a node's children, dropping the blanks.
    //
    // Native replaceChildren() takes (Node | string), so a `null` from a
    // conditional child — `isAdmin() ? button : null` — is stringified and
    // renders the literal text "null" on the page. el() already filters those;
    // this gives replaceChildren the same manners, so a conditional child can be
    // written the obvious way anywhere.
    function mount(host, ...children) {
      host.replaceChildren(...children.filter(function (c) {
        return c !== null && c !== undefined && c !== false && c !== '';
      }));
      return host;
    }

    function fail(node, e) {
      mount(node, el('div', { class: 'sa-error' },
        el('p', {}, t('sa.error', { message: err(e) })),
        el('button', { class: 'ghost small', onclick: draw }, t('sa.retry'))));
    }

    function ms(value) {
      if (value === null || value === undefined) return '—';
      if (value < 1000) return value + ' ms';
      return (value / 1000).toFixed(1) + ' s';
    }

    function when(value) {
      if (!value) return '—';
      var d = new Date(value);
      return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
    }

    // "No worker is connected" told someone to see the documentation without
    // saying which documentation or where. This says it and takes them there.
    function noWorkerBanner() {
      // The article lives in the admin-only Documentation section, so the link
      // is offered only to someone who can actually open it. An operator is told
      // who can instead of being sent to a page that would silently show them a
      // different article.
      return el('div', { class: 'sa-warn-banner' },
        el('span', {}, t('sa.test.noWorkerBanner') + ' '),
        (openDocs && isAdmin())
          ? el('a', { href: '#', class: 'sa-link', onclick: function (e) { e.preventDefault(); openDocs(); } }, t('sa.test.showMeHow'))
          : el('span', {}, t('sa.test.askAdmin')));
    }

    // What the server currently sees. A worker writes a heartbeat every few
    // seconds, so this answers "is my worker running?" without queueing a test
    // first — which is how the question was asked in practice.
    function workerPanel(worker) {
      var count = worker && worker.worker_count ? worker.worker_count : 0;
      if (!count) {
        return el('div', { class: 'sa-panel' },
          section(t('sa.worker.title'), null), noWorkerBanner());
      }
      var rows = (worker.workers || []).map(function (w) {
        return el('tr', {},
          el('td', {}, w.worker_id || '—'),
          el('td', {}, w.hostname || '—'),
          el('td', {}, w.version || '—'),
          el('td', {}, when(w.last_seen_at)));
      });
      return el('div', { class: 'sa-panel' },
        section(t('sa.worker.title'), null),
        el('p', { class: 'sa-help' }, t('sa.worker.connected', { count: String(count) })),
        el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, t('sa.worker.id')), el('th', {}, t('sa.worker.host')),
            el('th', {}, t('sa.worker.version')), el('th', {}, t('sa.worker.lastSeen')))),
          el('tbody', {}, ...rows)));
    }

    // ---------------------------------------------------------------- icons
    // Inline SVG rather than the unicode glyphs these buttons used to carry.
    // A glyph is whatever the viewer's font decides — different weight per
    // platform, blurry at 12px, and "×" had drifted into meaning DELETE on the
    // step rows while meaning CLOSE on the modal two screens away.
    //
    // One vocabulary, site-wide: a red TRASH CAN deletes, a "×" only ever closes
    // or cancels. Stroked in currentColor at 16px, so the icon inherits the
    // button's colour (including .danger red) and stays sharp on any display.
    var ICON_PATHS = {
      edit: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
      // Enabled / skipped, said as "is this step watched or not".
      shown: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z'],
      hidden: ['M3 3l18 18', 'M10.6 6.2A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4', 'M6.3 8.3A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4-.9'],
      duplicate: ['M9 9h10v10H9z', 'M5 15V5h10'],
      trash: ['M4 7h16', 'M10 4h4', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
      // Recording: the universal filled dot, drawn as two rings so it reads at
      // 16px without a fill (every icon here is stroke-only).
      record: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'],
    };

    function icon(name) {
      var NS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('class', 'sa-icon');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      (ICON_PATHS[name] || []).forEach(function (d) {
        var path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        svg.append(path);
      });
      return svg;
    }

    function statusChip(status) {
      return el('span', { class: 'sa-status sa-status-' + status }, String(status || '').toUpperCase());
    }

    // A confirm that reads as a sentence rather than a technical warning.
    function confirmDelete(name) {
      return root.confirm(t('sa.confirmDelete', { name: name }));
    }

    // Tab-to-accept for a placeholder that is a real prefix rather than an
    // example — `https://` is something you WILL type, not a hint about shape.
    // Pressing Tab in the empty field writes it and leaves the caret at the end,
    // so the next keystroke continues the address.
    //
    // Deliberately narrow: only when the field is empty, and Tab keeps its
    // normal meaning the moment there is any text, so keyboard navigation is
    // never taken away from someone who is done with the field.
    function acceptPlaceholderOnTab(input) {
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
        if (input.value !== '' || !input.placeholder) return;
        e.preventDefault();
        input.value = input.placeholder;
        // Caret to the end. A `url` input rejects setSelectionRange in some
        // browsers, so this is best-effort and the value still lands.
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (err) { /* value is set either way */ }
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return input;
    }

    // A segmented control: one choice out of a few, shown as a track with the
    // chosen one raised.
    //
    // It LOOKED like a toggle group and announced itself as four unrelated
    // buttons — nothing said which one was on, so a screen reader heard "Day,
    // Week, Month, Year" and no answer to the only question that matters.
    // `aria-pressed` says it, and the group carries a name so the reader knows
    // what is being chosen.
    function segmented(options, selected, onPick, label) {
      var group = el('div', { class: 'sa-segmented', role: 'group' });
      if (label) group.setAttribute('aria-label', label);
      options.forEach(function (pair) {
        var on = selected === pair[0];
        var b = el('button', {
          type: 'button',
          class: 'sa-segment' + (on ? ' active' : ''),
          onclick: function () { onPick(pair[0]); },
        }, pair[1]);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        group.append(b);
      });
      return group;
    }

    function field(label, control, help) {
      return el('label', { class: 'sa-field' },
        el('span', { class: 'sa-field-label' }, label),
        control,
        help ? el('span', { class: 'sa-help' }, help) : null);
    }

    function section(title, actions) {
      return el('div', { class: 'sa-section-head' },
        el('h3', {}, title),
        actions ? el('div', { class: 'sa-actions' }, actions) : null);
    }

    // ---------------------------------------------------------------- shell
    function tabBar() {
      var tabs = [
        ['applications', t('sa.tab.applications')],
        ['journeys', t('sa.tab.journeys')],
        ['tests', t('sa.tab.tests')],
        ['runs', t('sa.tab.runs')],
        ['history', t('sa.tab.history')],
        ['health', t('sa.tab.health')],
        ['schedules', t('sa.tab.schedules')],
      ];
      return el('div', { class: 'sa-tabs' }, ...tabs.map(function (pair) {
        return el('button', {
          class: 'sa-tab' + (state.tab === pair[0] ? ' active' : ''),
          onclick: function () { state.tab = pair[0]; state.applicationId = null; state.testId = null; draw(); },
        }, pair[1]);
      }));
    }

    function draw() {
      var body = el('div', { class: 'sa-body' }, el('div', { class: 'sa-loading' }, t('sa.loading')));
      mount(host, tabBar(), body);
      var render = views[state.tab] || views.applications;
      Promise.resolve(render(body)).catch(function (e) { fail(body, e); });
    }

    var views = {};

    // ------------------------------------------------------- applications
    views.applications = function (body) {
      if (state.applicationId) return applicationDetail(body, state.applicationId);
      return api(API + '/applications').then(function (apps) {
        var head = section(t('sa.tab.applications'), isAdmin()
          ? el('button', { class: 'primary', onclick: function () { applicationForm(null); } }, '+ ' + t('sa.app.new'))
          : null);

        if (!apps.length) {
          mount(body, head, el('div', { class: 'sa-empty' }, t('sa.app.empty')));
          return;
        }
        var rows = apps.map(function (app) {
          return el('tr', {
            class: 'clickable',
            onclick: function () { state.applicationId = app.id; draw(); },
          },
          el('td', {}, el('strong', {}, app.name), app.description ? el('div', { class: 'muted' }, app.description) : null),
          el('td', {}, el('code', {}, app.base_url)),
          el('td', {}, String(app.environment_count)),
          el('td', {}, t('sa.app.tests', { count: app.test_count })),
          el('td', {}, app.last_discovery
            ? t('sa.app.lastDiscovery', { when: when(app.last_discovery.ended_at || app.last_discovery.created_at) })
            : t('sa.app.neverDiscovered')),
          el('td', {}, app.enabled ? '' : el('span', { class: 'sa-muted-chip' }, '—')));
        });
        mount(body, head, el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, t('sa.app.name')),
            el('th', {}, t('sa.app.url')),
            el('th', {}, t('sa.app.environments')),
            el('th', {}, t('sa.tab.tests')),
            el('th', {}, t('sa.tab.discovery')),
            el('th', {}, ''))),
          el('tbody', {}, ...rows)));
      });
    };

    function applicationForm(app) {
      var name = el('input', { type: 'text', value: (app && app.name) || '' });
      var url = acceptPlaceholderOnTab(el('input', { type: 'url', value: (app && app.base_url) || '', placeholder: 'https://' }));
      var desc = el('textarea', { rows: 2 }, (app && app.description) || '');
      var errors = el('div', { class: 'sa-form-errors' });

      var body = el('div', {},
        field(t('sa.app.name'), name),
        field(t('sa.app.url'), url, t('sa.app.urlHelp')),
        field(t('sa.app.description'), desc),
        errors);

      modal(app ? app.name : t('sa.app.new'), body, function () {
        var payload = { name: name.value.trim(), base_url: url.value.trim(), description: desc.value.trim() || null };
        var request = app
          ? api(API + '/applications/' + app.id, { method: 'PUT', body: payload })
          : api(API + '/applications', { method: 'POST', body: payload });
        return request.then(function () { toast(t('sa.settings.saved')); draw(); })
          .catch(function (e) { showErrors(errors, e); throw e; });
      });
    }

    function applicationDetail(body, id) {
      return api(API + '/applications/' + id).then(function (app) {
        var head = el('div', {},
          el('button', { class: 'ghost small', onclick: function () { state.applicationId = null; draw(); } }, '← ' + t('sa.back')),
          section(app.name, [
            isOperator() ? el('button', { class: 'primary', onclick: function () { startDiscovery(app); } }, t('sa.discovery.start')) : null,
            isAdmin() ? el('button', { class: 'ghost small', onclick: function () { applicationForm(app); } }, t('sa.edit')) : null,
            isAdmin() ? el('button', {
              class: 'ghost small danger',
              onclick: function () {
                if (!confirmDelete(app.name)) return;
                api(API + '/applications/' + app.id, { method: 'DELETE' })
                  .then(function () { state.applicationId = null; toast(t('sa.delete')); draw(); })
                  .catch(function (e) { toast(err(e), true); });
              },
            }, t('sa.delete')) : null,
          ]),
          el('p', { class: 'sa-url' }, el('code', {}, app.base_url)));

        mount(body, head,
          discoveryPanel(app),
          environmentsPanel(app),
          serviceMapPanel(app),
          credentialsPanel(app),
          allowedHostsPanel(app));
      });
    }

    // ------------------------------------------------------- environments
    function environmentsPanel(app) {
      var wrap = el('div', { class: 'sa-panel' });
      function render() {
        var rows = (app.environments || []).map(function (env) {
          return el('tr', {},
            el('td', {}, env.name),
            el('td', {}, el('span', { class: 'chip' }, env.type)),
            el('td', {}, el('code', {}, env.base_url)),
            el('td', {}, isAdmin() ? el('button', {
              class: 'ghost small danger',
              onclick: function () {
                if (!confirmDelete(env.name)) return;
                api(API + '/environments/' + env.id, { method: 'DELETE' }).then(reload).catch(function (e) { toast(err(e), true); });
              },
            }, t('sa.delete')) : null));
        });
        mount(wrap, 
          section(t('sa.app.environments'), isAdmin()
            ? el('button', { class: 'ghost small', onclick: environmentForm }, '+ ' + t('sa.env.new')) : null),
          rows.length
            ? el('table', { class: 'data-table' }, el('tbody', {}, ...rows))
            : el('div', { class: 'sa-empty' }, t('sa.none')));
      }
      function reload() { state.applicationId = app.id; draw(); }
      function environmentForm() {
        // "Production" alone reads as a value someone already typed. Prefixed,
        // it reads as the example it is.
        var name = el('input', { type: 'text', placeholder: t('sa.env.namePlaceholder') });
        var url = acceptPlaceholderOnTab(el('input', { type: 'url', value: app.base_url, placeholder: 'https://' }));
        var type = el('select', {}, ...['production', 'staging', 'development', 'test', 'custom'].map(function (v) {
          return el('option', { value: v }, v);
        }));
        var errors = el('div', { class: 'sa-form-errors' });
        modal(t('sa.env.new'), el('div', {},
          field(t('sa.app.name'), name), field(t('sa.env.type'), type), field(t('sa.app.url'), url), errors), function () {
          return api(API + '/environments', {
            method: 'POST',
            body: { application_id: app.id, name: name.value.trim(), base_url: url.value.trim(), type: type.value },
          }).then(reload).catch(function (e) { showErrors(errors, e); throw e; });
        });
      }
      render();
      return wrap;
    }

    // --------------------------------------------------------- service map
    //
    //     Application → Journey → Page → API → Endpoint
    //
    // Drawn as nested lists rather than a graph, deliberately. A force-directed
    // picture of forty endpoints looks impressive and answers nothing; a list
    // answers "which endpoints does this journey depend on, and which of them
    // have failed", which is the question people actually bring to a map.
    //
    // Everything shown was OBSERVED by a run. Nothing is inferred and nothing
    // can be added by hand — the moment it can, it is a CMDB.
    function serviceMapPanel(app) {
      var wrap = el('div', { class: 'sa-panel' });
      var body = el('div', {}, el('p', { class: 'muted' }, t('sa.map.loading')));
      mount(wrap, section(t('sa.map.title'), null), el('p', { class: 'sa-help' }, t('sa.map.help')), body);

      api(API + '/map?application_id=' + app.id).then(function (map) {
        if (!map.nodes.length) {
          mount(body, el('div', { class: 'sa-empty' }, t('sa.map.empty')));
          return;
        }
        var byId = {};
        map.nodes.forEach(function (n) { byId[n.id] = n; });
        var out = function (from, kind) {
          return map.edges.filter(function (e) { return e.from === from && (!kind || e.kind === kind); })
            .map(function (e) { return byId[e.to]; }).filter(Boolean);
        };
        var appNode = map.nodes.find(function (n) { return n.kind === 'application'; });

        mount(body,
          el('div', { class: 'sa-map-counts' },
            el('span', {}, t('sa.map.counts', {
              journeys: map.counts.journeys, tests: map.counts.tests,
              pages: map.counts.pages, endpoints: map.counts.endpoints,
            })),
            map.counts.failing_endpoints
              ? el('span', { class: 'sa-map-failing' }, t('sa.map.failing', { count: map.counts.failing_endpoints }))
              : null),
          el('div', { class: 'sa-map' }, ...(appNode ? out(appNode.id) : []).map(function (node) {
            return mapBranch(node, out);
          })));
      }).catch(function (e) { mount(body, el('div', { class: 'sa-form-error' }, err(e))); });
    }

    function mapBranch(node, out) {
      var children = out(node.id);
      return el('div', { class: 'sa-map-node sa-map-' + node.kind },
        el('div', { class: 'sa-map-label' },
          el('span', { class: 'sa-map-kind' }, mapKindLabel(node.kind)),
          el('strong', {}, node.label),
          node.criticality ? el('span', { class: 'sa-crit sa-crit-' + node.criticality }, criticalityLabel(node.criticality)) : null,
          node.health ? el('span', { class: 'sa-health-chip sa-health-' + node.health }, healthLabel(node.health)) : null,
          node.ungrouped ? el('span', { class: 'muted' }, ' \u00b7 ' + t('sa.map.ungrouped')) : null,
          (node.methods && node.methods.length) ? el('span', { class: 'muted' }, ' ' + node.methods.join(' ')) : null,
          node.failures ? el('span', { class: 'sa-map-failing' }, ' ' + t('sa.map.failedTimes', { count: node.failures })) : null),
        children.length ? el('div', { class: 'sa-map-children' }, ...children.map(function (c) { return mapBranch(c, out); })) : null);
    }

    function mapKindLabel(kind) {
      if (kind === 'journey') return t('sa.map.kind.journey');
      if (kind === 'test') return t('sa.map.kind.test');
      if (kind === 'page') return t('sa.map.kind.page');
      if (kind === 'endpoint') return t('sa.map.kind.endpoint');
      return t('sa.map.kind.application');
    }

    // -------------------------------------------------------- credentials
    function credentialsPanel(app) {
      if (!isAdmin()) return el('div', {});
      var wrap = el('div', { class: 'sa-panel' });
      function reload() { state.applicationId = app.id; draw(); }
      var rows = (app.credentials || []).map(function (cred) {
        return el('tr', {},
          el('td', {}, cred.label),
          el('td', {}, cred.username || '—'),
          el('td', {}, cred.has_secret ? el('span', { class: 'chip' }, '••••••') : el('span', { class: 'muted' }, '—')),
          el('td', {}, el('button', {
            class: 'ghost small danger',
            onclick: function () {
              if (!confirmDelete(cred.label)) return;
              api(API + '/credentials/' + cred.id, { method: 'DELETE' }).then(reload).catch(function (e) { toast(err(e), true); });
            },
          }, t('sa.delete'))));
      });
      function credentialForm() {
        var label = el('input', { type: 'text' });
        var username = el('input', { type: 'text', autocomplete: 'off' });
        var secret = el('input', { type: 'password', autocomplete: 'new-password' });
        var errors = el('div', { class: 'sa-form-errors' });
        modal(t('sa.cred.new'), el('div', {},
          field(t('sa.cred.label'), label),
          field(t('sa.cred.username'), username),
          field(t('sa.cred.password'), secret, t('sa.cred.help')),
          errors), function () {
          return api(API + '/credentials', {
            method: 'POST',
            body: { application_id: app.id, label: label.value.trim(), username: username.value.trim(), secret: secret.value },
          }).then(reload).catch(function (e) { showErrors(errors, e); throw e; });
        });
      }
      mount(wrap, 
        section(t('sa.app.credentials'), el('button', { class: 'ghost small', onclick: credentialForm }, '+ ' + t('sa.cred.new'))),
        rows.length ? el('table', { class: 'data-table' }, el('tbody', {}, ...rows)) : el('div', { class: 'sa-empty' }, t('sa.none')));
      return wrap;
    }

    // ------------------------------------------------------ allowed hosts
    function allowedHostsPanel(app) {
      if (!isAdmin()) return el('div', {});
      var wrap = el('div', { class: 'sa-panel' });
      function reload() { state.applicationId = app.id; draw(); }
      var entries = app.allowed_hosts || [];

      var rows = entries.map(function (entry) {
        return el('tr', {},
          el('td', {}, el('span', { class: 'chip' }, entry.entry_type)),
          el('td', {}, el('code', {}, entry.value)),
          el('td', {}, entry.note || ''),
          el('td', {}, el('button', {
            class: 'ghost small danger',
            onclick: function () {
              api(API + '/applications/' + app.id + '/allowed-hosts/' + entry.id, { method: 'DELETE' })
                .then(reload).catch(function (e) { toast(err(e), true); });
            },
          }, t('sa.delete'))));
      });

      function addForm() {
        var value = el('input', { type: 'text', placeholder: t('sa.hosts.valuePlaceholder') });
        var note = el('input', { type: 'text' });
        var errors = el('div', { class: 'sa-form-errors' });
        modal(t('sa.hosts.add'), el('div', {},
          el('p', { class: 'sa-help' }, t('sa.hosts.help')),
          field(t('sa.hosts.value'), value),
          field(t('sa.hosts.note'), note),
          errors), function () {
          return api(API + '/applications/' + app.id + '/allowed-hosts', {
            method: 'POST', body: { value: value.value.trim(), note: note.value.trim() || null },
          }).then(reload).catch(function (e) { showErrors(errors, e); throw e; });
        });
      }

      // Import with a dry run first: an operator pastes a list from the network
      // team and sees exactly what it would add before anything is written.
      function importForm() {
        var text = el('textarea', { rows: 8, placeholder: 'portal.kunde.dk\n10.20.0.0/16' });
        var errors = el('div', { class: 'sa-form-errors' });
        var preview = el('div', { class: 'sa-preview' });
        var body = el('div', {},
          el('p', { class: 'sa-help' }, t('sa.hosts.importHelp')),
          text,
          el('button', {
            class: 'ghost small',
            onclick: function () {
              mount(errors);
              api(API + '/applications/' + app.id + '/allowed-hosts/import?dry_run=1', { method: 'POST', body: { text: text.value } })
                .then(function (res) {
                  mount(preview, el('p', {}, t('sa.hosts.previewResult', { added: res.added, unchanged: res.unchanged })));
                })
                .catch(function (e) { mount(preview); showErrors(errors, e); });
            },
          }, t('sa.hosts.preview')),
          preview, errors);

        modal(t('sa.hosts.import'), body, function () {
          return api(API + '/applications/' + app.id + '/allowed-hosts/import', { method: 'POST', body: { text: text.value } })
            .then(reload).catch(function (e) { showErrors(errors, e); throw e; });
        });
      }

      mount(wrap, 
        section(t('sa.app.allowedHosts'), [
          el('button', { class: 'ghost small', onclick: addForm }, '+ ' + t('sa.hosts.add')),
          el('button', { class: 'ghost small', onclick: importForm }, t('sa.hosts.import')),
          // A download needs a real link, but `ghost small` is styled for
          // <button> — as an <a> it rendered as a bare blue link beside two
          // buttons. sa-btn gives it the same shape.
          el('a', {
            class: 'ghost small sa-btn',
            href: API + '/applications/' + app.id + '/allowed-hosts/export.csv',
          }, t('sa.hosts.export')),
        ]),
        el('p', { class: 'sa-help' }, t('sa.hosts.help')),
        rows.length ? el('table', { class: 'data-table' }, el('tbody', {}, ...rows))
          : el('div', { class: 'sa-empty' }, t('sa.hosts.empty')));
      return wrap;
    }

    // ----------------------------------------------------------- discovery
    function discoveryPanel(app) {
      var wrap = el('div', { class: 'sa-panel' });
      var last = app.last_discovery;
      mount(wrap, 
        section(t('sa.tab.discovery'), null),
        el('p', { class: 'sa-help' }, t('sa.discovery.help')),
        last
          ? el('div', { class: 'sa-stats' },
            stat(t('sa.discovery.pages', { count: last.page_count }), last.page_count),
            stat(t('sa.discovery.forms', { count: last.form_count }), last.form_count),
            stat(t('sa.discovery.logins', { count: last.login_count }), last.login_count),
            stat(t('sa.discovery.elements', { count: last.element_count }), last.element_count))
          : el('div', { class: 'sa-empty' },
            el('p', {}, t('sa.discovery.empty')),
            el('p', { class: 'muted' }, t('sa.discovery.neverHint'))),
        last ? el('button', {
          class: 'ghost small',
          onclick: function () { state.discoveryId = last.id; showSuggestions(last.id); },
        }, t('sa.suggest.title')) : null);
      return wrap;
    }

    function stat(label, value) {
      return el('div', { class: 'sa-stat' }, el('div', { class: 'sa-stat-value' }, String(value)), el('div', { class: 'sa-stat-label' }, label));
    }

    function startDiscovery(app) {
      api(API + '/discovery', { method: 'POST', body: { application_id: app.id } })
        .then(function (res) {
          toast(res.worker && res.worker.connected ? t('sa.discovery.running') : t('sa.test.noWorker'));
          draw();
        })
        .catch(function (e) { toast(err(e), true); });
    }

    // A suggested journey. It shows what accepting it will BUILD — the member
    // tests, in order, with the optional ones marked — because "accept" here
    // creates several things at once and the operator should see which.
    function journeySuggestionCard(s) {
      var plan = s.proposed_journey || { steps: [] };
      var accepted = s.status !== 'proposed';
      var crit = el('select', {}, ...['critical', 'high', 'normal', 'low'].map(function (c) {
        return el('option', { value: c }, criticalityLabel(c));
      }));
      crit.value = plan.criticality || 'normal';

      function landOn(res) {
        toast(res.merged
          ? t('sa.suggest.journeyMerged', { count: res.added_steps })
          : t('sa.suggest.journeyCreated', { count: res.tests.length }));
        state.tab = 'journeys';
        state.journeyId = res.journey.id;
        draw();
      }

      function send(extra) {
        var body = { criticality: crit.value };
        Object.keys(extra || {}).forEach(function (k) { body[k] = extra[k]; });
        return api(API + '/suggestions/' + s.id + '/accept', { method: 'POST', body })
          .then(landOn)
          .catch(function (e) {
            accept.disabled = false;
            // 409: this application already has a journey covering some of these
            // steps. Not an error — a question only the operator can answer,
            // which is why the server refuses once and says what it found
            // rather than picking for them.
            if (e && e.status === 409 && e.data && e.data.overlaps) overlapChoice(e.data.overlaps);
            else toast(err(e), true);
          });
      }

      // The choice, with the facts next to it: what each existing journey
      // already covers and what accepting would add. A "duplicate?" warning with
      // no detail is one people click past.
      function overlapChoice(overlaps) {
        modal(t('sa.suggest.overlapTitle'), el('div', {},
          el('p', { class: 'sa-help' }, t('sa.suggest.overlapHelp')),
          ...overlaps.map(function (o) {
            return el('div', { class: 'sa-suggestion' },
              el('div', { class: 'sa-journey-head' },
                el('strong', {}, o.name),
                el('span', { class: 'muted' }, t('sa.test.steps', { count: o.step_count }))),
              el('p', { class: 'muted' }, t('sa.suggest.overlapCovers', { steps: o.already_covers.join(', ') })),
              o.would_add.length
                ? el('p', {}, t('sa.suggest.overlapAdds', { steps: o.would_add.join(', ') }))
                : el('p', { class: 'muted' }, t('sa.suggest.overlapAddsNothing')),
              o.would_add.length
                ? el('button', {
                  class: 'primary small',
                  onclick: function () { send({ merge_into_journey_id: o.journey_id }); },
                }, t('sa.suggest.overlapMerge'))
                : null);
          }),
          el('p', { class: 'sa-help' }, t('sa.suggest.overlapAnywayHelp')),
          el('button', {
            class: 'ghost small',
            onclick: function () { send({ confirm: true }); },
          }, t('sa.suggest.overlapAnyway'))));
      }

      var accept = el('button', {
        class: 'primary small',
        onclick: function () { accept.disabled = true; send({}); },
      }, t('sa.suggest.acceptJourney'));

      return el('div', { class: 'sa-suggestion sa-suggest-journey' },
        el('div', { class: 'sa-journey-head' },
          el('strong', {}, s.name),
          el('span', { class: 'chip chip-' + s.confidence }, t('sa.suggest.confidence') + ': ' + s.confidence)),
        el('div', { class: 'muted' }, s.description || ''),
        // What it will build, before it builds it.
        el('ol', { class: 'sa-record-steps' }, ...(plan.steps || []).map(function (step) {
          return el('li', {}, step.suggestion_name,
            step.required === false ? el('span', { class: 'muted' }, ' \u00b7 ' + t('sa.suggest.optional')) : null);
        })),
        el('div', { class: 'sa-suggestion-meta' }, el('span', { class: 'muted' }, s.reason || '')),
        accepted
          ? el('span', { class: 'chip' }, t('sa.suggest.accepted'))
          : el('div', { class: 'sa-suggest-journey-actions' },
            // Criticality is the operator's call. The heuristic proposed one;
            // this is where they disagree with it, before anything is created.
            el('label', { class: 'sa-step-required' },
              el('span', {}, t('sa.journey.criticality')), crit),
            accept));
    }

    function showSuggestions(discoveryId) {
      api(API + '/suggestions?discovery_id=' + discoveryId).then(function (list) {
        if (!list.length) { toast(t('sa.suggest.empty')); return; }
        // Journeys are accepted ONE at a time, with their own button: accepting
        // one creates several tests and the journey that orders them, which is
        // not what a tick box in a "create the selected tests" list means.
        var journeys = list.filter(function (s) { return s.kind === 'journey'; });
        var tests = list.filter(function (s) { return s.kind !== 'journey'; });
        var checks = {};
        var body = el('div', { class: 'sa-suggestions' }, ...tests.map(function (s) {
          var box = el('input', { type: 'checkbox' });
          if (s.status === 'proposed') { box.checked = true; checks[s.id] = box; }
          return el('div', { class: 'sa-suggestion' },
            el('label', {}, s.status === 'proposed' ? box : el('span', { class: 'chip' }, t('sa.suggest.accepted')),
              el('strong', {}, s.name)),
            el('div', { class: 'muted' }, s.description || ''),
            el('div', { class: 'sa-suggestion-meta' },
              el('span', { class: 'chip chip-' + s.confidence }, t('sa.suggest.confidence') + ': ' + s.confidence),
              el('span', { class: 'muted' }, s.reason || '')),
            el('div', { class: 'muted' }, t('sa.test.steps', { count: (s.proposed_steps || []).length })));
        }));
        var content = el('div', {},
          journeys.length ? el('div', { class: 'sa-suggest-journeys' },
            el('h4', {}, t('sa.suggest.journeysTitle')),
            el('p', { class: 'sa-help' }, t('sa.suggest.journeysHelp')),
            ...journeys.map(journeySuggestionCard)) : null,
          tests.length ? el('div', {},
            el('h4', {}, t('sa.suggest.testsTitle')),
            body) : null);

        modal(t('sa.suggest.title'), content, tests.length ? function () {
          var ids = Object.keys(checks).filter(function (id) { return checks[id].checked; }).map(Number);
          if (!ids.length) return Promise.resolve();
          return api(API + '/suggestions/accept-many', { method: 'POST', body: { ids: ids } })
            .then(function (res) { toast(t('sa.suggest.create') + ': ' + res.created.length); state.tab = 'tests'; draw(); });
        } : null, t('sa.suggest.create'));
      }).catch(function (e) { toast(err(e), true); });
    }

    // --------------------------------------------------------------- tests
    views.tests = function (body) {
      if (state.testId) return testDetail(body, state.testId);
      return Promise.all([api(API + '/tests'), api(API + '/recordings')]).then(function (res) {
        var tests = res[0];
        var recordings = res[1];
        var head = section(t('sa.tab.tests'), isOperator()
          ? [el('button', { class: 'ghost small', onclick: startRecordingFlow }, icon('record'), t('sa.record.start'))]
          : null);
        if (!tests.length) {
          mount(body, head, recordingsPanel(recordings), el('div', { class: 'sa-empty' }, t('sa.test.empty')));
          return;
        }
        var rows = tests.map(function (test) {
          return el('tr', { class: 'clickable', onclick: function () { state.testId = test.id; draw(); } },
            el('td', {}, el('strong', {}, test.name)),
            // Which application this runs against. A test name is only unique
            // within its application — four of them can each have a "Login" —
            // so without this column the list is four identical rows.
            el('td', {}, test.application_name
              ? el('span', { class: 'sa-app-cell' }, test.application_name)
              : el('span', { class: 'muted' }, '—')),
            el('td', {}, t('sa.test.steps', { count: test.step_count })),
            el('td', {}, historyStrip(test.history)),
            el('td', {}, test.history && test.history.success_rate !== null
              ? Math.round(test.history.success_rate * 100) + '%' : '—'),
            el('td', {}, ms(test.history && test.history.avg_duration_ms)),
            el('td', {}, isOperator() ? el('button', {
              class: 'ghost small',
              onclick: function (e) { e.stopPropagation(); runTest(test); },
            }, t('sa.test.run')) : null));
        });
        mount(body, head, recordingsPanel(recordings), el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, t('sa.app.name')),
            el('th', {}, t('sa.test.application')),
            el('th', {}, t('sa.designer.title')),
            el('th', {}, t('sa.tab.runs')),
            el('th', {}, t('sa.run.successRate')),
            el('th', {}, t('sa.run.avgDuration')),
            el('th', {}, ''))),
          el('tbody', {}, ...rows)));
      });
    };

    // Both of these could be one line of string concatenation. They are not, on
    // purpose: the UI gate sweeps every translation key written as a literal and
    // checks it exists in both catalogues, and a key built at runtime is a key
    // the sweep cannot see. Spelling the variants out keeps all eight checked.
    function healthLabel(status) {
      if (status === 'failed') return t('sa.journey.health.failed');
      if (status === 'degraded') return t('sa.journey.health.degraded');
      if (status === 'healthy') return t('sa.journey.health.healthy');
      return t('sa.journey.health.unknown');
    }

    function criticalityLabel(level) {
      if (level === 'critical') return t('sa.journey.crit.critical');
      if (level === 'high') return t('sa.journey.crit.high');
      if (level === 'low') return t('sa.journey.crit.low');
      return t('sa.journey.crit.normal');
    }

    // ---------------------------------------------------------- journeys
    //
    // The screen the product principle is aimed at: not "the website is up" but
    // "can a caseworker do their job" — and when they cannot, which part broke.
    //
    // So a journey row never shows a colour alone. It shows the verdict, the
    // sentence explaining it, and the per-step outcomes underneath, because a
    // status nobody can check is a status nobody trusts.
    views.journeys = function (body) {
      if (state.journeyId) return journeyDetail(body, state.journeyId);
      return api(API + '/journeys').then(function (res) {
        var head = section(t('sa.tab.journeys'), isOperator()
          ? [el('button', { class: 'primary', onclick: newJourneyForm }, '+ ' + t('sa.journey.new'))]
          : null);
        if (!res.journeys.length) {
          mount(body, head, el('div', { class: 'sa-empty' },
            el('p', {}, t('sa.journey.empty')),
            el('p', { class: 'muted' }, t('sa.journey.emptyHint'))));
          return;
        }
        mount(body, head, summaryBar(res.summary), el('div', { class: 'sa-journeys' },
          ...res.journeys.map(journeyCard)));
      });
    };

    // The application's verdict, as counts. The worst journey decides the word;
    // the counts say how widespread it is.
    function summaryBar(summary) {
      if (!summary || !summary.total) return null;
      return el('div', { class: 'sa-journey-summary sa-health-' + summary.status },
        el('strong', {}, healthLabel(summary.status)),
        el('span', { class: 'muted' }, t('sa.journey.summaryCounts', {
          failed: summary.failed, degraded: summary.degraded, healthy: summary.healthy, total: summary.total,
        })));
    }

    function journeyCard(journey) {
      var h = journey.health;
      return el('div', {
        class: 'sa-journey clickable sa-health-' + h.status,
        onclick: function () { state.journeyId = journey.id; draw(); },
      },
        el('div', { class: 'sa-journey-head' },
          el('div', {},
            el('strong', {}, journey.name),
            el('span', { class: 'sa-crit sa-crit-' + journey.criticality }, criticalityLabel(journey.criticality))),
          el('span', { class: 'sa-health-chip sa-health-' + h.status }, healthLabel(h.status))),
        // The reason, always. A verdict without one is the thing this replaces.
        el('p', { class: 'sa-journey-reason' }, h.reason),
        journey.duration && journey.duration.slow
          ? el('p', { class: 'sa-journey-slow' }, t('sa.journey.slow', {
            duration: ms(journey.duration.duration_ms), expected: ms(journey.duration.expected_ms),
          }))
          : null,
        el('div', { class: 'sa-journey-steps' }, ...h.steps.map(function (step) {
          return el('span', {
            class: 'sa-journey-step sa-outcome-' + step.outcome + (step.required ? '' : ' sa-optional'),
            title: (step.label || '') + ' — ' + (step.status || t('sa.journey.neverRun')),
          }, step.label || ('#' + step.test_id));
        })),
        el('div', { class: 'muted sa-journey-meta' },
          journey.application_name || '',
          journey.environment_name ? ' · ' + journey.environment_name : '',
          ' · ' + t('sa.test.steps', { count: journey.step_count })));
    }

    function newJourneyForm() {
      api(API + '/applications').then(function (apps) {
        if (!apps.length) { toast(t('sa.record.noApps'), true); return; }
        var pick = el('select', {}, ...apps.map(function (a) { return el('option', { value: String(a.id) }, a.name); }));
        var name = el('input', { type: 'text', placeholder: t('sa.journey.namePlaceholder') });
        var desc = el('textarea', { rows: '2' });
        var crit = el('select', {}, ...['critical', 'high', 'normal', 'low'].map(function (c) {
          return el('option', { value: c }, criticalityLabel(c));
        }));
        crit.value = 'normal';
        var expected = el('input', { type: 'number', min: '1', placeholder: t('sa.journey.expectedPlaceholder') });
        var errors = el('div', {});
        modal(t('sa.journey.new'), el('div', { class: 'sa-form' },
          field(t('sa.tab.applications'), pick),
          field(t('sa.app.name'), name, t('sa.journey.nameHelp')),
          field(t('sa.app.description'), desc),
          field(t('sa.journey.criticality'), crit, t('sa.journey.criticalityHelp')),
          field(t('sa.journey.expected'), expected, t('sa.journey.expectedHelp')),
          errors), function () {
          return api(API + '/journeys', {
            method: 'POST',
            body: {
              application_id: Number(pick.value),
              name: name.value,
              description: desc.value || null,
              criticality: crit.value,
              // Typed in seconds because that is how people talk about it; the
              // API stores milliseconds like every other duration.
              expected_duration_ms: expected.value ? Math.round(Number(expected.value) * 1000) : null,
            },
          }).then(function (created) { state.journeyId = created.id; draw(); })
            .catch(function (e) { showErrors(errors, e); throw e; });
        }, t('sa.create'));
      }).catch(function (e) { toast(err(e), true); });
    }

    // Everything about a journey EXCEPT its steps — the same gap the test page
    // had: name, description, criticality and the expected duration were set
    // once at creation and unreachable after, so a journey whose importance
    // changed could never say so.
    //
    // `application_id` is not editable, for the same reason it is not on a test:
    // a journey is about ONE service, and moving it would leave every step
    // pointing at another application's tests.
    function journeyForm(journey) {
      var name = el('input', { type: 'text', value: journey.name || '' });
      var desc = el('textarea', { rows: '2' }, journey.description || '');
      var crit = el('select', {}, ...['critical', 'high', 'normal', 'low'].map(function (c) {
        return el('option', { value: c }, criticalityLabel(c));
      }));
      crit.value = journey.criticality || 'normal';
      // Seconds in the box because that is how people talk about it; the API
      // stores milliseconds like every other duration here.
      var expected = el('input', {
        type: 'number', min: '1', placeholder: t('sa.journey.expectedPlaceholder'),
        value: journey.expected_duration_ms ? String(Math.round(journey.expected_duration_ms / 1000)) : '',
      });
      var errors = el('div', {});

      modal(t('sa.journey.edit'), el('div', { class: 'sa-form' },
        field(t('sa.app.name'), name, t('sa.journey.nameHelp')),
        field(t('sa.app.description'), desc),
        field(t('sa.journey.criticality'), crit, t('sa.journey.criticalityHelp')),
        field(t('sa.journey.expected'), expected, t('sa.journey.expectedHelp')),
        errors), function () {
        return api(API + '/journeys/' + journey.id, {
          method: 'PUT',
          body: {
            name: name.value,
            description: desc.value || null,
            criticality: crit.value,
            // Cleared means "no expectation stated", which is honest and a
            // different fact from an expectation of zero.
            expected_duration_ms: expected.value ? Math.round(Number(expected.value) * 1000) : null,
          },
        }).then(function () { toast(t('sa.settings.saved')); draw(); })
          .catch(function (e) { showErrors(errors, e); throw e; });
      });
    }

    // Running a journey is running its member tests — one queued run each, in
    // order. There is no third kind of run: the worker picks these up the way it
    // picks up any other, and the journey's verdict is computed from them as it
    // always was.
    function runJourney(journey) {
      api(API + '/journeys/' + journey.id + '/run', { method: 'POST', body: {} })
        .then(function (res) {
          var connected = res.worker && res.worker.connected;
          toast(connected
            ? t('sa.journey.queued', { count: (res.runs || []).length })
            : t('sa.test.noWorker'), !connected);
          state.journeyId = null;
          state.tab = 'runs';
          draw();
        })
        .catch(function (e) { toast(err(e), true); });
    }

    function journeyDetail(body, id) {
      return Promise.all([
        api(API + '/journeys/' + id),
        api(API + '/tests'),
      ]).then(function (res) {
        var journey = res[0];
        var candidates = res[1].filter(function (x) { return x.application_id === journey.application_id; });
        var h = journey.health;

        mount(body,
          el('button', { class: 'ghost small', onclick: function () { state.journeyId = null; draw(); } }, '← ' + t('sa.back')),
          section(journey.name, isOperator() ? [
            // Only offered when there is something to run. A button that can
            // only answer "this journey has no steps yet" is a button that
            // should not be there.
            journey.step_count
              ? el('button', { class: 'primary', onclick: function () { runJourney(journey); } }, t('sa.journey.run'))
              : null,
            el('button', { class: 'ghost small', onclick: function () { journeyForm(journey); } }, t('sa.edit')),
            el('button', {
              class: 'ghost small danger',
              title: t('sa.delete'),
              onclick: function () {
                if (!confirmDelete(journey.name)) return;
                api(API + '/journeys/' + journey.id, { method: 'DELETE' })
                  .then(function () { state.journeyId = null; draw(); })
                  .catch(function (e) { toast(err(e), true); });
              },
            }, icon('trash')),
          ] : null),
          el('div', { class: 'sa-panel sa-health-' + h.status },
            el('div', { class: 'sa-journey-head' },
              el('span', { class: 'sa-health-chip sa-health-' + h.status }, healthLabel(h.status)),
              el('span', { class: 'sa-crit sa-crit-' + journey.criticality }, criticalityLabel(journey.criticality))),
            el('p', { class: 'sa-journey-reason' }, h.reason),
            journey.description ? el('p', { class: 'muted' }, journey.description) : null,
            journey.duration ? el('p', { class: journey.duration.slow ? 'sa-journey-slow' : 'muted' },
              t('sa.journey.duration', {
                duration: ms(journey.duration.duration_ms), expected: ms(journey.duration.expected_ms),
              })) : null),
          journeyStepsPanel(journey, candidates));
      });
    }

    // The membership editor. Whole-list, because the screen IS a list: "this is
    // the order now" is the only statement a drag & drop UI can make truthfully.
    function journeyStepsPanel(journey, candidates) {
      var steps = journey.health.steps.map(function (s) {
        return { test_id: s.test_id, label: s.label, required: s.required, outcome: s.outcome, status: s.status };
      });
      var list = el('div', { class: 'sa-steps' });
      var byId = {};
      candidates.forEach(function (c) { byId[c.id] = c; });

      function save() {
        return api(API + '/journeys/' + journey.id + '/steps', {
          method: 'PUT',
          body: { steps: steps.map(function (s) { return { test_id: s.test_id, label: s.label, required: s.required }; }) },
        }).then(function () { draw(); }).catch(function (e) { toast(err(e), true); });
      }

      function render() {
        mount(list, ...steps.map(function (step, i) {
          return el('div', { class: 'sa-step sa-outcome-' + (step.outcome || 'unknown') },
            el('span', { class: 'sa-step-pos' }, String(i + 1)),
            el('div', { class: 'sa-step-main' },
              el('strong', {}, step.label || (byId[step.test_id] && byId[step.test_id].name) || ('#' + step.test_id)),
              el('div', { class: 'muted' }, step.status
                ? t('sa.journey.lastRun', { status: step.status })
                : t('sa.journey.neverRun'))),
            isOperator() ? el('label', { class: 'sa-step-required', title: t('sa.journey.requiredHelp') },
              (function () {
                var box = el('input', { type: 'checkbox' });
                box.checked = step.required;
                box.addEventListener('change', function () { step.required = box.checked; save(); });
                return box;
              }()),
              el('span', {}, t('sa.journey.required'))) : null,
            isOperator() ? el('div', { class: 'sa-step-actions' },
              el('button', {
                class: 'ghost small', title: t('sa.moveUp'), disabled: i === 0,
                onclick: function () { steps.splice(i - 1, 0, steps.splice(i, 1)[0]); save(); },
              }, '↑'),
              el('button', {
                class: 'ghost small', title: t('sa.moveDown'), disabled: i === steps.length - 1,
                onclick: function () { steps.splice(i + 1, 0, steps.splice(i, 1)[0]); save(); },
              }, '↓'),
              el('button', {
                class: 'ghost small danger', title: t('sa.delete'),
                onclick: function () { steps.splice(i, 1); save(); },
              }, icon('trash'))) : null);
        }));
        if (!steps.length) mount(list, el('div', { class: 'sa-empty' }, t('sa.journey.noSteps')));
      }

      var unused = candidates.filter(function (c) {
        return !steps.some(function (s) { return s.test_id === c.id; });
      });
      var picker = el('select', {}, el('option', { value: '' }, t('sa.journey.addStep')),
        ...unused.map(function (c) { return el('option', { value: String(c.id) }, c.name); }));
      picker.addEventListener('change', function () {
        if (!picker.value) return;
        steps.push({ test_id: Number(picker.value), required: true });
        picker.value = '';
        save();
      });

      render();
      return el('div', { class: 'sa-panel' },
        section(t('sa.journey.steps'), isOperator() && unused.length ? [picker] : null),
        el('p', { class: 'sa-help' }, t('sa.journey.stepsHelp')),
        list);
    }

    // ----------------------------------------------------------- recording
    //
    // The operator performs the journey in their own browser, on the real
    // application, signed in as themselves. BlueEye watches through a small
    // script the bookmarklet injects and writes the test from what it saw.
    //
    // What the screen has to make obvious, because the alternative is a support
    // call: the recording is live NOW, it expires, and the bookmarklet is shown
    // once. Everything below is in service of those three facts.

    // Unfinished recordings, shown above the test list so a session the operator
    // walked away from is visible rather than a row that quietly expires.
    function recordingsPanel(recordings) {
      var open = (recordings || []).filter(function (r) { return r.status !== 'accepted'; });
      if (!open.length) return null;
      return el('div', { class: 'sa-panel' },
        el('h4', {}, t('sa.record.open')),
        el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, t('sa.app.name')),
            el('th', {}, t('sa.test.application')),
            el('th', {}, t('sa.record.steps')),
            el('th', {}, t('sa.record.status')),
            el('th', {}, ''))),
          el('tbody', {}, ...open.map(function (rec) {
            return el('tr', {},
              el('td', {}, el('strong', {}, rec.name)),
              el('td', {}, rec.application_name
                ? el('span', { class: 'sa-app-cell' }, rec.application_name)
                : el('span', { class: 'muted' }, '—')),
              el('td', {}, t('sa.test.steps', { count: rec.step_count })),
              el('td', {}, el('span', { class: 'sa-status sa-status-' + (rec.status === 'recording' ? 'running' : 'pending') },
                t(rec.status === 'recording' ? 'sa.record.live' : 'sa.record.stopped'))),
              el('td', { class: 'sa-row-actions' },
                // Stopping from HERE, not only from the badge on the page.
                // The badge's stop is a request FROM the customer's site, so a
                // site that blocks the recorder's connection also blocks its
                // goodbye — and the recording sat at "Recording" with nobody
                // able to end it. The dashboard's own connection always works.
                rec.status === 'recording' && isOperator() ? el('button', {
                  class: 'ghost small',
                  onclick: function () {
                    api(API + '/recordings/' + rec.id + '/stop', { method: 'POST', body: {} })
                      .then(function () { toast(t('sa.record.stoppedToast')); draw(); })
                      .catch(function (e) { toast(err(e), true); });
                  },
                }, t('sa.record.stop')) : null,
                el('button', { class: 'ghost small', onclick: function () { reviewRecording(rec.id); } }, t('sa.record.review')),
                el('button', {
                  class: 'ghost small danger',
                  title: t('sa.delete'),
                  onclick: function () {
                    if (!confirmDelete(rec.name)) return;
                    api(API + '/recordings/' + rec.id, { method: 'DELETE' })
                      .then(draw).catch(function (e) { toast(err(e), true); });
                  },
                }, icon('trash'))));
          }))));
    }

    function startRecordingFlow() {
      api(API + '/applications').then(function (apps) {
        if (!apps.length) { toast(t('sa.record.noApps'), true); return; }
        var name = el('input', { type: 'text', placeholder: t('sa.record.namePlaceholder') });
        var pick = el('select', {}, ...apps.map(function (a) {
          return el('option', { value: String(a.id) }, a.name);
        }));
        var errors = el('div', {});
        modal(t('sa.record.start'), el('div', { class: 'sa-form' },
          field(t('sa.tab.applications'), pick),
          field(t('sa.app.name'), name, t('sa.record.nameHelp')),
          errors), function () {
          return api(API + '/recordings', {
            method: 'POST',
            body: { application_id: Number(pick.value), name: name.value },
          }).then(showBookmarklet).catch(function (e) { showErrors(errors, e); throw e; });
        }, t('sa.record.start'));
      }).catch(function (e) { toast(err(e), true); });
    }

    // The one screen where the capture token exists. It is not stored anywhere
    // this page can read it back from, so leaving without taking the bookmarklet
    // means starting over — which the copy says plainly rather than letting the
    // operator discover it.
    function showBookmarklet(rec) {
      var link = el('a', { class: 'sa-bookmarklet', title: t('sa.record.dragHint') }, t('sa.record.bookmarkName'));
      // Set with setAttribute rather than the `href` property: a javascript:
      // URL assigned through the property is what a linter flags, and this one
      // is the product — the operator drags it to their own bookmarks bar.
      link.setAttribute('href', rec.bookmarklet);
      link.addEventListener('click', function (e) { e.preventDefault(); });

      var copied = el('button', { class: 'ghost small', onclick: function () {
        if (navigator.clipboard) navigator.clipboard.writeText(rec.bookmarklet).then(function () { toast(t('sa.record.copied')); });
      } }, t('sa.record.copy'));

      var status = el('div', { class: 'muted' }, t('sa.record.waiting'));
      var overlay = modal(t('sa.record.ready'), el('div', { class: 'sa-form' },
        // An http:// capture address cannot work from an https:// application:
        // the browser refuses it as mixed active content before the request is
        // made, and reports that to the console and nobody else. Saying so here
        // beats handing over a bookmarklet that can only fail.
        rec.insecure ? el('div', { class: 'sa-form-error' },
          el('strong', {}, t('sa.record.insecureTitle')), ' ',
          t('sa.record.insecureBody', { url: rec.capture_url })) : null,
        el('p', {}, t('sa.record.step1')),
        el('div', { class: 'sa-bookmarklet-row' }, link, copied),
        el('p', {}, t('sa.record.step2')),
        el('p', {}, t('sa.record.step3')),
        el('p', { class: 'sa-help' }, t('sa.record.iconNote')),
        el('p', { class: 'sa-help' }, t('sa.record.reinject')),
        el('p', { class: 'sa-help' }, t('sa.record.cspWarning')),
        el('p', { class: 'sa-help' }, t('sa.record.secretNote')),
        status), function () {
        return reviewRecording(rec.id);
      }, t('sa.record.review'));

      // Poll while the modal is open, so the operator sees the step count climb
      // and knows the recorder actually reached us. Stops with the modal — a
      // timer outliving its screen is how a dashboard ends up polling forever.
      var poll = setInterval(function () {
        if (!overlay.isConnected) { clearInterval(poll); return; }
        api(API + '/recordings/' + rec.id).then(function (live) {
          if (live.status !== 'recording') { status.textContent = t('sa.record.stopped'); return; }
          // Nothing has arrived yet. Say what that means while the operator is
          // still on the page and can act on it, rather than letting them
          // perform the whole journey and find an empty recording.
          status.textContent = live.step_count
            ? t('sa.record.captured', { count: live.step_count })
            : t('sa.record.nothingYet');
        }).catch(function () { clearInterval(poll); });
      }, 3000);
    }

    // Review: the recorded steps as the DSL the designer already edits, so what
    // the operator approves is exactly what will be saved. Nothing here is a
    // recording-specific test format — that is the whole point.
    function reviewRecording(id) {
      return api(API + '/recordings/' + id).then(function (rec) {
        // A journey that signs in carries {{credential.password}}, and the
        // server refuses to save it without a login — so the picker is here,
        // where the operator can answer, rather than as a 400 they have to
        // interpret.
        // Read through the application rather than the flat /credentials list:
        // that one is admin-only, while GET /applications/:id is open to every
        // viewer and already carries the same logins (label + username, never a
        // secret). An operator reviewing their own recording must not need an
        // administrator to find out which login to attach.
        return (rec.requires_credential
          ? api(API + '/applications/' + rec.application_id).then(function (app) { return app.credentials || []; })
            .catch(function () { return []; })
          : Promise.resolve([])).then(function (logins) { return [rec, logins]; });
      }).then(function (pair) {
        var rec = pair[0];
        var logins = pair[1];
        var steps = (rec.definition && rec.definition.steps) || [];
        var name = el('input', { type: 'text', value: rec.name });
        var errors = el('div', {});
        var credential = rec.requires_credential
          ? el('select', {}, el('option', { value: '' }, '—'), ...logins.map(function (c) {
            return el('option', { value: String(c.id) }, c.label + ' (' + c.username + ')');
          }))
          : null;
        var list = steps.length
          ? el('ol', { class: 'sa-record-steps' }, ...steps.map(function (step) {
            return el('li', {}, el('code', {}, step.type), ' ', el('span', {}, recordedStepText(step)));
          }))
          : el('div', { class: 'sa-empty' },
            el('p', {}, t('sa.record.nothing')),
            el('p', { class: 'muted' }, t('sa.record.nothingWhy')));

        modal(t('sa.record.review'), el('div', { class: 'sa-form' },
          field(t('sa.app.name'), name),
          credential ? field(t('sa.app.credentials'), credential, t('sa.record.credentialNote')) : null,
          list,
          errors),
        // A recording with no steps cannot become a test — so there is no save
        // button at all, rather than one that fails when pressed.
        steps.length ? function () {
          return api(API + '/recordings/' + id + '/accept', {
            method: 'POST',
            body: { name: name.value, credential_id: credential && credential.value ? Number(credential.value) : null },
          })
            .then(function (test) { toast(t('sa.record.saved')); state.testId = test.id; state.tab = 'tests'; draw(); })
            .catch(function (e) { showErrors(errors, e); throw e; });
        } : null,
        t('sa.record.save'));
      }).catch(function (e) { toast(err(e), true); });
    }

    // A recorded step in one line of plain language. The value is shown as it
    // will be saved — so a credential reference reads as a reference, and the
    // operator can see at a glance that no password was written down.
    //
    // Named apart from the designer's own describeStep on purpose: that one
    // renders an editable card, this one renders a read-only review line, and a
    // shared name across two scopes is how the wrong one gets called.
    function recordedStepText(step) {
      var where = step.target ? (step.target.name || step.target.label || step.target.text
        || step.target.placeholder || step.target.id || step.target.css || '') : '';
      if (step.type === 'open') return step.url;
      if (step.type === 'fill') return where + ' = ' + (step.value || '');
      if (step.type === 'checkbox') return where + ' = ' + (step.checked ? '✓' : '✗');
      if (step.type === 'select') return where + ' = ' + (step.value || '');
      return where;
    }

    // PASS PASS PASS FAIL PASS — the whole history in one glance (spec §24).
    function historyStrip(history) {
      var runs = (history && history.runs) || [];
      if (!runs.length) return el('span', { class: 'muted' }, '—');
      return el('span', { class: 'sa-strip' }, ...runs.slice(0, 10).reverse().map(function (run) {
        return el('span', { class: 'sa-strip-dot sa-status-' + run.status, title: run.status + ' · ' + when(run.started_at) });
      }));
    }

    function runTest(test) {
      api(API + '/tests/' + test.id + '/run', { method: 'POST', body: {} })
        .then(function (res) {
          toast(res.worker && res.worker.connected ? t('sa.test.queued') : t('sa.test.noWorker'), !(res.worker && res.worker.connected));
          state.tab = 'runs';
          draw();
        })
        .catch(function (e) { toast(err(e), true); });
    }

    function testDetail(body, id) {
      return Promise.all([
        api(API + '/tests/' + id),
        api(API + '/tests/step-types'),
        api(API + '/schedules?test_id=' + id),
        api(API + '/healing?test_id=' + id + '&status=proposed').catch(function () { return []; }),
      ]).then(function (res) {
        var test = res[0];
        var catalogue = res[1].categories;
        var schedules = res[2];
        var proposals = res[3] || [];

        var head = el('div', {},
          el('button', { class: 'ghost small', onclick: function () { state.testId = null; draw(); } }, '← ' + t('sa.back')),
          section(test.name, [
            isOperator() ? el('button', { class: 'primary', onclick: function () { runTest(test); } }, t('sa.test.run')) : null,
            // The designer below saves the STEPS. Everything else about a test
            // — its name, what it is for, which login it uses, whether it runs
            // at all — was only settable at creation and unreachable after,
            // which is how a test ends up named "Untitled" forever.
            isOperator() ? el('button', { class: 'ghost small', onclick: function () { testForm(test, schedules); } }, t('sa.edit')) : null,
            isOperator() ? el('button', {
              class: 'ghost small danger',
              onclick: function () { deleteTest(test); },
            }, t('sa.delete')) : null,
          ]),
          test.application_name
            ? el('p', { class: 'muted sa-detail-app' }, t('sa.test.runsAgainst', { application: test.application_name }))
            : null);

        mount(body, head,
          // What this test is FOR. Shown before the steps, because "which
          // customer journey breaks if I delete this" is the question an
          // operator has before they have any question about step 3.
          test.journeys && test.journeys.length
            ? el('p', { class: 'muted sa-detail-app' },
              t('sa.test.partOf'), ' ',
              ...test.journeys.map(function (j, i) {
                return el('span', {},
                  i ? ', ' : '',
                  el('a', {
                    class: 'linklike',
                    onclick: function () { state.testId = null; state.journeyId = j.id; state.tab = 'journeys'; draw(); },
                  }, j.name));
              }))
            : null,
          // Before the designer: a step that can no longer find its element is
          // the reason the operator opened this page, and the proposal is what
          // they can do about it.
          proposals.length ? healingPanel(proposals) : null,
          designer(test, catalogue),
          historyPanel(test),
          schedulePanel(test, schedules));
      });
    }

    // Everything about a test EXCEPT its steps. The steps have the designer
    // below; these fields had no way in at all once the test existed.
    //
    // `application_id` is not here on purpose. Moving a test to another
    // application would leave every step pointing at the old one's pages, its
    // history describing a service it no longer tests, and its journeys quietly
    // spanning two applications. Delete and rebuild is the honest path.
    //
    // How often it runs is here too. It used to live only in the Automatic runs
    // panel, where the only way to change "every hour" to "every 15 minutes" was
    // to delete the schedule and add it back — and where a test with no schedule
    // gave no hint that it would never run again on its own. "What is this test
    // and when does it run" is one question, so it is one dialog.
    function testForm(test, schedules) {
      var name = el('input', { type: 'text', value: test.name || '' });
      var desc = el('textarea', { rows: 2 }, test.description || '');
      var enabled = el('input', { type: 'checkbox' });
      enabled.checked = test.enabled !== false;
      var credential = el('select', {}, el('option', { value: '' }, t('sa.test.noLogin')));
      var errors = el('div', { class: 'sa-form-errors' });

      // At most one schedule per test today, which is what the panel's
      // "+ Add only when there are none" already assumed. Reading [0] rather
      // than assuming it exists keeps a test with none working.
      var schedule = (schedules || [])[0] || null;
      var every = el('select', {}, el('option', { value: '' }, t('sa.schedule.never')));
      var tz = el('input', {
        type: 'text',
        value: (schedule && schedule.timezone)
          || (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
      });

      var body = el('div', {},
        field(t('sa.app.name'), name),
        field(t('sa.app.description'), desc, t('sa.test.descriptionHelp')),
        field(t('sa.test.login'), credential, t('sa.test.loginHelp')),
        field(t('sa.schedule.every'), every, t('sa.schedule.everyHelp')),
        field(t('sa.schedule.timezone'), tz),
        el('label', { class: 'sa-field sa-field-inline' }, enabled,
          el('span', {}, t('sa.test.enabled'))),
        el('p', { class: 'sa-help' }, t('sa.test.enabledHelp')),
        errors);

      // The intervals the server accepts, asked for rather than hardcoded — a
      // list duplicated in the browser is one that drifts. If the read fails the
      // dropdown is left showing only what the test already has, so saving
      // cannot silently unschedule it.
      var intervalsLoaded = api(API + '/schedules/intervals').then(function (res) {
        (res.intervals || []).forEach(function (i) {
          var opt = el('option', { value: String(i.seconds) }, i.da || i.en);
          if (schedule && Number(schedule.interval_sec) === Number(i.seconds)) opt.selected = true;
          every.append(opt);
        });
      }).catch(function () {
        if (schedule) {
          every.append(el('option', { value: String(schedule.interval_sec), selected: 'selected' },
            schedule.description || String(schedule.interval_sec) + 's'));
          every.disabled = true;
        }
      });

      // The logins belong to the application, so they are read through it
      // rather than from a flat list that would show every application's.
      // If that read fails the dialog still opens — the select simply keeps
      // whatever the test already has, rather than silently offering to clear it.
      api(API + '/applications/' + test.application_id).then(function (app) {
        (app.credentials || []).forEach(function (c) {
          var opt = el('option', { value: String(c.id) }, c.username ? c.name + ' (' + c.username + ')' : c.name);
          if (Number(test.credential_id) === Number(c.id)) opt.selected = true;
          credential.append(opt);
        });
      }).catch(function () {
        if (test.credential_id) {
          credential.append(el('option', { value: String(test.credential_id), selected: 'selected' }, t('sa.test.loginUnreadable')));
          credential.disabled = true;
        }
      });

      modal(t('sa.test.edit'), body, function () {
        return api(API + '/tests/' + test.id, {
          method: 'PUT',
          body: {
            name: name.value.trim(),
            description: desc.value.trim() || null,
            credential_id: credential.value ? Number(credential.value) : null,
            enabled: enabled.checked,
          },
        })
          // The test is saved first and the schedule second, deliberately. If
          // the schedule call fails the name change still stands and the dialog
          // says what went wrong — the alternative is losing both to one error.
          .then(function () { return saveSchedule(); })
          .then(function () { toast(t('sa.settings.saved')); draw(); })
          .catch(function (e) { showErrors(errors, e); throw e; });
      });

      // Four cases, spelled out rather than inferred: add one, change one,
      // remove one, or leave it alone. "Leave it alone" matters — a PUT on every
      // save would reset next_run_at each time somebody fixed a typo in the
      // name, quietly pushing the next run an hour into the future.
      function saveSchedule() {
        return intervalsLoaded.then(function () {
          var wanted = every.value ? Number(every.value) : null;
          var zone = tz.value.trim();
          if (!schedule && wanted === null) return null;
          if (!schedule) {
            return api(API + '/schedules', {
              method: 'POST',
              body: { test_id: test.id, interval_sec: wanted, timezone: zone },
            });
          }
          if (wanted === null) {
            return api(API + '/schedules/' + schedule.id, { method: 'DELETE' });
          }
          if (Number(schedule.interval_sec) === wanted && (schedule.timezone || '') === zone) return null;
          return api(API + '/schedules/' + schedule.id, {
            method: 'PUT',
            body: { interval_sec: wanted, timezone: zone },
          });
        });
      }
    }

    // Deleting a test is not only deleting a test.
    //
    // A test that belongs to a journey is removed from that journey by the
    // database (the step row cascades), so a journey silently gets shorter and
    // keeps reporting healthy while the thing it was watching is no longer
    // watched. That is worth one extra sentence before the confirm, naming the
    // journeys, rather than finding out months later.
    function deleteTest(test) {
      var names = (test.journeys || []).map(function (j) { return j.name; });
      if (names.length && !root.confirm(t('sa.test.deleteJourneyWarn', { journeys: names.join(', ') }))) return;
      if (!confirmDelete(test.name)) return;
      api(API + '/tests/' + test.id, { method: 'DELETE' })
        .then(function () { state.testId = null; toast(t('sa.delete')); draw(); })
        .catch(function (e) { toast(err(e), true); });
    }

    // ------------------------------------------------------- self-healing
    //
    // The element a step points at is gone, and BlueEyes found one it thinks was
    // meant. It PROPOSES. Nothing on this screen has already happened — that is
    // the feature, not a formality: a heal applied without being read would turn
    // a test green while the service stayed broken.
    function healingPanel(proposals) {
      return el('div', { class: 'sa-panel sa-healing' },
        section(t('sa.heal.title'), null),
        el('p', { class: 'sa-help' }, t('sa.heal.help')),
        ...proposals.map(healingCard));
    }

    function healingCard(p) {
      var errors = el('div', {});
      var busy = false;
      function decide(action) {
        if (busy) return;
        busy = true;
        api(API + '/healing/' + p.id + '/' + action, { method: 'POST', body: {} })
          .then(function () { toast(t(action === 'accept' ? 'sa.heal.accepted' : 'sa.heal.rejected')); draw(); })
          .catch(function (e) { busy = false; showErrors(errors, e); });
      }

      return el('div', { class: 'sa-heal-card sa-conf-' + p.confidence },
        el('div', { class: 'sa-journey-head' },
          el('strong', {}, t('sa.heal.stepLabel', { step: p.step_path, type: p.step_type || '' })),
          el('span', { class: 'chip chip-' + p.confidence }, t('sa.suggest.confidence') + ': ' + p.confidence)),
        // Both sides, side by side, in the operator's words. A proposal they
        // cannot check is a proposal they should not accept.
        el('div', { class: 'sa-heal-compare' },
          el('div', {}, el('div', { class: 'muted' }, t('sa.heal.original')),
            el('code', {}, p.original_label || '')),
          el('div', { class: 'sa-heal-arrow' }, '\u2192'),
          el('div', {}, el('div', { class: 'muted' }, t('sa.heal.proposed')),
            el('code', {}, p.proposed_label || ''))),
        el('p', { class: 'sa-journey-reason' }, p.reason || ''),
        errors,
        isOperator() ? el('div', { class: 'sa-heal-actions' },
          el('button', { class: 'primary small', onclick: function () { decide('accept'); } }, t('sa.heal.accept')),
          el('button', { class: 'ghost small', onclick: function () { decide('reject'); } }, t('sa.heal.reject')),
          el('span', { class: 'sa-help' }, t('sa.heal.editHint'))) : null);
    }

    // ------------------------------------------------------ test designer
    // A vertical list of step cards, reordered with the HTML5 drag & drop API.
    // No library — the repo has no build step, and this is what that buys.
    function designer(test, catalogue) {
      var wrap = el('div', { class: 'sa-panel' });
      var steps = JSON.parse(JSON.stringify((test.definition && test.definition.steps) || []));
      var list = el('div', { class: 'sa-steps' });
      var dragging = null;

      var labels = {};
      catalogue.forEach(function (cat) {
        cat.steps.forEach(function (s) { labels[s.type] = s.label; });
      });

      function stepCard(step, index) {
        var card = el('div', {
          class: 'sa-step' + (step.enabled === false ? ' sa-step-off' : ''),
          draggable: isOperator() ? 'true' : 'false',
        });
        card.dataset.index = String(index);

        card.addEventListener('dragstart', function (e) {
          dragging = index;
          card.classList.add('sa-dragging');
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', function () { dragging = null; card.classList.remove('sa-dragging'); });
        card.addEventListener('dragover', function (e) { e.preventDefault(); card.classList.add('sa-drop'); });
        card.addEventListener('dragleave', function () { card.classList.remove('sa-drop'); });
        card.addEventListener('drop', function (e) {
          e.preventDefault();
          card.classList.remove('sa-drop');
          if (dragging === null || dragging === index) return;
          var moved = steps.splice(dragging, 1)[0];
          steps.splice(index, 0, moved);
          dragging = null;
          renderSteps();
        });

        var title = step.label || labels[step.type] || step.type;
        var detail = describeStep(step);

        card.append(
          el('div', { class: 'sa-step-grip', title: t('sa.designer.moveHelp') }, '⠿'),
          el('div', { class: 'sa-step-main' },
            el('div', { class: 'sa-step-title' }, el('span', { class: 'sa-step-n' }, String(index + 1)), title),
            detail ? el('div', { class: 'sa-step-detail' }, detail) : null),
          isOperator() ? el('div', { class: 'sa-step-tools' },
            el('button', { class: 'ghost small', title: t('sa.designer.rename'), onclick: function () { editStep(step, index); } }, icon('edit')),
            el('button', {
              class: 'ghost small',
              title: step.enabled === false ? t('sa.designer.enable') : t('sa.designer.disable'),
              onclick: function () { step.enabled = step.enabled === false ? undefined : false; renderSteps(); },
            }, icon(step.enabled === false ? 'hidden' : 'shown')),
            el('button', {
              class: 'ghost small',
              title: t('sa.designer.duplicate'),
              onclick: function () { steps.splice(index + 1, 0, JSON.parse(JSON.stringify(step))); renderSteps(); },
            }, icon('duplicate')),
            el('button', {
              class: 'ghost small danger',
              title: t('sa.delete'),
              onclick: function () { steps.splice(index, 1); renderSteps(); },
            }, icon('trash'))) : null);
        return card;
      }

      function describeStep(step) {
        var parts = [];
        if (step.url) parts.push(step.url);
        if (step.value !== undefined) {
          // A credential reference is shown as a reference, never resolved here.
          parts.push(/\{\{credential\./.test(String(step.value)) ? '••••••' : '"' + step.value + '"');
        }
        if (step.ms !== undefined) parts.push(step.ms + ' ms');
        if (step.status !== undefined) parts.push('HTTP ' + step.status);
        if (step.target) parts.push(t('sa.designer.target') + ': ' + targetWords(step.target));
        return parts.join(' · ');
      }

      // The target in words. A CSS selector is the only case the operator was
      // never meant to see, so it is labelled rather than printed raw.
      function targetWords(target) {
        if (target.role && target.name) return target.role + ' "' + target.name + '"';
        if (target.label) return '"' + target.label + '"';
        if (target.text) return '"' + target.text + '"';
        if (target.placeholder) return '"' + target.placeholder + '"';
        if (target.name) return '"' + target.name + '"';
        if (target.id) return '#' + target.id;
        return t('sa.technicalDetails');
      }

      function editStep(step, index) {
        var label = el('input', { type: 'text', value: step.label || '' });
        var value = el('input', { type: 'text', value: step.value === undefined ? '' : step.value });
        var url = el('input', { type: 'text', value: step.url === undefined ? '' : step.url });
        var body = el('div', {},
          field(t('sa.designer.rename'), label),
          step.url !== undefined ? field(t('sa.app.url'), url) : null,
          step.value !== undefined ? field('Værdi', value) : null);
        modal(labels[step.type] || step.type, body, function () {
          if (label.value.trim()) step.label = label.value.trim(); else delete step.label;
          if (step.url !== undefined) step.url = url.value.trim();
          if (step.value !== undefined) step.value = value.value;
          renderSteps();
          return Promise.resolve();
        });
      }

      function addStep() {
        var select = el('select', {});
        catalogue.forEach(function (cat) {
          var group = el('optgroup', { label: cat.category });
          cat.steps.forEach(function (s) { group.append(el('option', { value: s.type }, s.label)); });
          select.append(group);
        });
        modal(t('sa.designer.add'), el('div', {}, field(t('sa.designer.add'), select)), function () {
          var type = select.value;
          var step = { type: type };
          var meta = null;
          catalogue.forEach(function (cat) { cat.steps.forEach(function (s) { if (s.type === type) meta = s; }); });
          (meta && meta.fields ? meta.fields : []).forEach(function (f) {
            step[f.name] = f.type === 'boolean' ? true : (f.type === 'int' ? 0 : '');
          });
          if (meta && meta.target) step.target = { text: '' };
          steps.push(step);
          renderSteps();
          return Promise.resolve();
        });
      }

      function renderSteps() {
        mount(list, ...steps.map(stepCard));
        if (!steps.length) mount(list, el('div', { class: 'sa-empty' }, t('sa.designer.empty')));
      }

      function save() {
        var definition = { version: 1, name: test.name, steps: steps };
        api(API + '/tests/' + test.id, { method: 'PUT', body: { definition: definition } })
          .then(function () { toast(t('sa.settings.saved')); draw(); })
          .catch(function (e) { toast(err(e), true); });
      }

      renderSteps();
      mount(wrap, 
        section(t('sa.designer.title'), isOperator() ? [
          el('button', { class: 'ghost small', onclick: addStep }, '+ ' + t('sa.designer.add')),
          el('button', { class: 'primary', onclick: save }, t('sa.save')),
        ] : null),
        isOperator() ? el('p', { class: 'sa-help' }, t('sa.designer.moveHelp')) : null,
        list);
      return wrap;
    }

    // ------------------------------------------------------------ history
    function historyPanel(test) {
      // Two panels, not one: the chart owns its own (it has its own controls and
      // reloads in place), and the recent-runs list sits below it.
      var wrap = el('div', {});
      var list = el('div', { class: 'sa-panel' });
      var history = test.history || {};
      var runs = history.runs || [];
      mount(list, 
        section(t('sa.tab.runs'), null),
        runs.length ? el('div', { class: 'sa-stats' },
          stat(t('sa.run.successRate'), history.success_rate !== null ? Math.round(history.success_rate * 100) + '%' : '—'),
          stat(t('sa.run.avgDuration'), ms(history.avg_duration_ms)),
          stat(t('sa.run.lastFailure'), history.last_failure ? when(history.last_failure.started_at) : '—'))
          : el('div', { class: 'sa-empty' }, t('sa.run.noRuns')),
        runs.length ? el('table', { class: 'data-table' }, el('tbody', {}, ...runs.map(function (run) {
          return el('tr', { class: 'clickable', onclick: function () { state.tab = 'runs'; state.runId = run.id; draw(); } },
            el('td', {}, statusChip(run.status)),
            el('td', {}, when(run.started_at)),
            el('td', {}, ms(run.duration_ms)),
            el('td', {}, run.error_message || ''));
        }))) : null);
      // The shape of a month of runs answers "is this getting better or worse";
      // the list under it is the detail behind the shape.
      mount(wrap, historyChart({ testId: test.id }), list);
      return wrap;
    }

    // ----------------------------------------------------------- schedules
    function schedulePanel(test, schedules) {
      var wrap = el('div', { class: 'sa-panel' });
      function reload() { state.testId = test.id; draw(); }

      var rows = (schedules || []).map(function (s) {
        return el('tr', {},
          el('td', {}, s.description),
          el('td', {}, when(s.next_run_at)),
          el('td', {}, s.missed_intervals > 2 ? el('span', { class: 'sa-warn' }, t('sa.schedule.behind', { count: s.missed_intervals })) : ''),
          el('td', {}, isOperator() ? el('button', {
            class: 'ghost small danger',
            onclick: function () {
              api(API + '/schedules/' + s.id, { method: 'DELETE' }).then(reload).catch(function (e) { toast(err(e), true); });
            },
          }, t('sa.delete')) : null));
      });

      // This panel SHOWS when the test next runs and whether it is falling
      // behind. Setting how often is one field in Edit test, not a second form
      // here that could disagree with it.
      mount(wrap,
        section(t('sa.schedule.title'), isOperator()
          ? el('button', { class: 'ghost small', onclick: function () { testForm(test, schedules); } },
            rows.length ? t('sa.schedule.change') : '+ ' + t('sa.schedule.add')) : null),
        rows.length ? el('table', { class: 'data-table' }, el('tbody', {}, ...rows))
          : el('div', { class: 'sa-empty' }, t('sa.schedule.empty')));
      return wrap;
    }


    // --------------------------------------------------------------- charts
    // Run history as a picture: how many ran, how many failed, how long they
    // took — segmented by day, week, month or year, for any specific one.
    //
    // Two charts, never one with two y-axes: "12 runs" and "1.4 s" share no
    // scale, and a second axis is the fastest way to make a chart lie. They
    // share the x positions instead, so a spike in the lower chart lines up
    // with the bar above it.
    //
    // The server owns the calendar (src/serviceTests/stats/period.js): it
    // answers with every bucket in the period, the empty ones included, plus
    // where previous and next point. This function does no date arithmetic
    // beyond formatting a label.
    var SVG_NS = 'http://www.w3.org/2000/svg';

    function svgEl(tag, attrs, children) {
      var node = document.createElementNS(SVG_NS, tag);
      Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, String(attrs[k])); });
      (children || []).forEach(function (c) { if (c) node.appendChild(c); });
      return node;
    }

    function svgTitle(text) {
      var title = document.createElementNS(SVG_NS, 'title');
      title.textContent = text;
      return title;
    }

    // A bar with its top two corners rounded — the data end. Radius shrinks on a
    // thin bar so a one-pixel column does not turn into a lozenge.
    function barPath(x, y, w, h, r) {
      var radius = Math.max(0, Math.min(r, w / 2, h));
      return 'M' + x + ',' + (y + h) +
        'V' + (y + radius) +
        'a' + radius + ',' + radius + ' 0 0 1 ' + radius + ',' + -radius +
        'H' + (x + w - radius) +
        'a' + radius + ',' + radius + ' 0 0 1 ' + radius + ',' + radius +
        'V' + (y + h) + 'Z';
    }

    // Bucket labels. A chart with 31 labels on the x axis has none, so only
    // every nth is drawn — and the tooltip carries the full date regardless.
    function bucketLabel(startIso, bucket) {
      var d = new Date(startIso);
      if (Number.isNaN(d.getTime())) return '';
      if (bucket === 'hour') return String(d.getHours()).padStart(2, '0');
      if (bucket === 'month') return d.toLocaleDateString(undefined, { month: 'short' });
      return String(d.getDate());
    }

    function bucketTooltip(b, bucket) {
      var d = new Date(b.start);
      var whenText = Number.isNaN(d.getTime()) ? b.key
        : (bucket === 'hour' ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
          : (bucket === 'month' ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
            : d.toLocaleDateString(undefined, { dateStyle: 'full' })));
      if (!b.total) return whenText + ' — ' + t('sa.chart.noRuns');
      var parts = [t('sa.chart.runs') + ': ' + b.total];
      if (b.pass) parts.push(t('sa.chart.passed') + ': ' + b.pass);
      if (b.warning) parts.push(t('sa.chart.warned') + ': ' + b.warning);
      if (b.fail) parts.push(t('sa.chart.failed') + ': ' + b.fail);
      if (b.error) parts.push(t('sa.chart.errored') + ': ' + b.error);
      if (b.skipped) parts.push(t('sa.chart.skipped') + ': ' + b.skipped);
      if (b.avg_duration_ms !== null && b.avg_duration_ms !== undefined) {
        parts.push(t('sa.chart.avgDuration') + ': ' + ms(b.avg_duration_ms));
      }
      return whenText + ' — ' + parts.join(', ');
    }

    // The stacked outcome bars. Segments are ordered worst-last so the eye lands
    // on failures at the top of the column, and carry a 2px gap so two adjacent
    // segments never melt into one block.
    function outcomeChart(data) {
      var W = 1000;
      var H = 190;
      var pad = { l: 44, r: 10, t: 12, b: 22 };
      var buckets = data.buckets || [];
      var max = Math.max(1, Math.max.apply(null, buckets.map(function (b) { return b.total; }).concat([0])));
      var plotW = W - pad.l - pad.r;
      var plotH = H - pad.t - pad.b;
      var slot = plotW / Math.max(1, buckets.length);
      var barW = Math.max(2, Math.min(48, slot - 4));
      var yOf = function (v) { return pad.t + plotH - (v / max) * plotH; };

      var svg = svgEl('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'sa-chart-svg', preserveAspectRatio: 'none',
        role: 'img', 'aria-label': t('sa.chart.runsTitle'),
      });

      // Recessive grid: three lines, whole numbers only — half a run is not a
      // thing, so a max of 3 gets 0/2/3 rather than 0/1.5/3.
      [0, 0.5, 1].forEach(function (frac) {
        var value = Math.round(max * frac);
        var y = yOf(value);
        svg.appendChild(svgEl('line', { class: 'sa-chart-grid', x1: pad.l, y1: y, x2: W - pad.r, y2: y }));
        var label = svgEl('text', { x: pad.l - 8, y: y + 4, class: 'sa-chart-axis', 'text-anchor': 'end' });
        label.textContent = String(value);
        svg.appendChild(label);
      });

      var segments = [
        ['pass', 'sa-bar-pass'],
        ['warning', 'sa-bar-warning'],
        ['skipped', 'sa-bar-skipped'],
        ['failed', 'sa-bar-failed'],
      ];
      var every = Math.ceil(buckets.length / 12);

      buckets.forEach(function (b, i) {
        var x = pad.l + i * slot + (slot - barW) / 2;
        var group = svgEl('g', { class: 'sa-chart-bar' }, [svgTitle(bucketTooltip(b, data.bucket))]);

        if (!b.total) {
          // An empty bucket still gets a mark. A missing bar is ambiguous — it
          // could be "no runs" or "off the edge of the chart" — and "it stopped
          // running on Thursday" is exactly the reading this chart is for.
          group.appendChild(svgEl('rect', { class: 'sa-bar-empty', x: x, y: yOf(0) - 2, width: barW, height: 2 }));
        } else {
          // fail and error are both a red column: they differ in WHOSE fault it
          // was, which the tooltip says, not in whether the service worked.
          var counts = { pass: b.pass, warning: b.warning, skipped: b.skipped, failed: b.fail + b.error };
          var cursor = 0;
          segments.forEach(function (seg, idx) {
            var value = counts[seg[0]];
            if (!value) return;
            var top = yOf(cursor + value);
            var bottom = yOf(cursor);
            var height = Math.max(1, bottom - top - (cursor ? 2 : 0));
            var isTop = segments.slice(idx + 1).every(function (s) { return !counts[s[0]]; });
            group.appendChild(isTop
              ? svgEl('path', { class: seg[1], d: barPath(x, top, barW, height, 3) })
              : svgEl('rect', { class: seg[1], x: x, y: top, width: barW, height: height }));
            cursor += value;
          });
        }
        svg.appendChild(group);

        if (i % every === 0) {
          var tick = svgEl('text', { x: x + barW / 2, y: H - 6, class: 'sa-chart-axis', 'text-anchor': 'middle' });
          tick.textContent = bucketLabel(b.start, data.bucket);
          svg.appendChild(tick);
        }
      });

      return svg;
    }

    // Average duration per bucket. Its own chart on its own scale — see above.
    // A bucket with no runs breaks the line rather than being drawn as zero: an
    // hour nothing ran in is not an hour everything was instant.
    function durationChart(data) {
      var W = 1000;
      var H = 110;
      var pad = { l: 44, r: 10, t: 10, b: 18 };
      var buckets = data.buckets || [];
      var values = buckets.map(function (b) { return b.avg_duration_ms; }).filter(function (v) { return v !== null && v !== undefined; });
      if (!values.length) return null;

      var max = Math.max.apply(null, values);
      var plotW = W - pad.l - pad.r;
      var plotH = H - pad.t - pad.b;
      var slot = plotW / Math.max(1, buckets.length);
      var xOf = function (i) { return pad.l + i * slot + slot / 2; };
      var yOf = function (v) { return pad.t + plotH - (v / Math.max(1, max)) * plotH; };

      var svg = svgEl('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'sa-chart-svg', preserveAspectRatio: 'none',
        role: 'img', 'aria-label': t('sa.chart.durationTitle'),
      });
      [0, 1].forEach(function (frac) {
        var y = yOf(max * frac);
        svg.appendChild(svgEl('line', { class: 'sa-chart-grid', x1: pad.l, y1: y, x2: W - pad.r, y2: y }));
        var label = svgEl('text', { x: pad.l - 8, y: y + 4, class: 'sa-chart-axis', 'text-anchor': 'end' });
        label.textContent = ms(Math.round(max * frac));
        svg.appendChild(label);
      });

      // One path per unbroken stretch, so a gap stays a gap.
      var run = [];
      var flush = function () {
        if (run.length > 1) svg.appendChild(svgEl('path', { class: 'sa-line-duration', d: run.join(' ') }));
        run = [];
      };
      buckets.forEach(function (b, i) {
        if (b.avg_duration_ms === null || b.avg_duration_ms === undefined) { flush(); return; }
        run.push((run.length ? 'L' : 'M') + xOf(i).toFixed(1) + ',' + yOf(b.avg_duration_ms).toFixed(1));
      });
      flush();

      buckets.forEach(function (b, i) {
        if (b.avg_duration_ms === null || b.avg_duration_ms === undefined) return;
        svg.appendChild(svgEl('g', { class: 'sa-chart-bar' }, [
          svgTitle(bucketTooltip(b, data.bucket)),
          svgEl('circle', { class: 'sa-dot-duration', cx: xOf(i).toFixed(1), cy: yOf(b.avg_duration_ms).toFixed(1), r: 4 }),
        ]));
      });
      return svg;
    }

    function chartLegend(data) {
      var totals = data.totals || {};
      var items = [
        ['sa-bar-pass', t('sa.chart.passed'), totals.pass],
        ['sa-bar-warning', t('sa.chart.warned'), totals.warning],
        ['sa-bar-failed', t('sa.chart.failed'), (totals.fail || 0) + (totals.error || 0)],
        ['sa-bar-skipped', t('sa.chart.skipped'), totals.skipped],
      ].filter(function (item) { return item[2]; });
      // One outcome needs no legend — the colour is not carrying an identity
      // anyone has to look up.
      if (items.length < 2) return null;
      return el('div', { class: 'sa-legend' }, ...items.map(function (item) {
        return el('span', { class: 'sa-legend-item' },
          el('span', { class: 'sa-legend-swatch ' + item[0] }),
          item[1] + ' (' + item[2] + ')');
      }));
    }

    // The period label, in words: "11 September 2026", "Week of 7 September",
    // "September 2026", "2026".
    function periodLabel(data) {
      var start = new Date(data.from);
      if (Number.isNaN(start.getTime())) return data.at;
      // from/to are UTC instants; the label must read in the same local calendar
      // the buckets were cut in, and the first bucket IS that local start.
      var local = data.buckets && data.buckets.length ? new Date(data.buckets[0].start) : start;
      if (data.period === 'day') return local.toLocaleDateString(undefined, { dateStyle: 'full' });
      if (data.period === 'week') return t('sa.chart.weekOf', { date: local.toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) });
      if (data.period === 'month') return local.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
      return String(local.getFullYear());
    }

    // The whole panel: controls, totals, both charts, legend. Owns its own
    // period state and re-fetches in place — changing the segmentation must not
    // reload the page underneath the operator.
    function historyChart(opts) {
      var options = opts || {};
      var wrap = el('div', { class: 'sa-panel sa-chart-panel' });
      var stateChart = { period: 'week', at: null };

      function query() {
        var parts = ['period=' + encodeURIComponent(stateChart.period),
          'tz_offset=' + encodeURIComponent(String(new Date().getTimezoneOffset()))];
        if (stateChart.at) parts.push('at=' + encodeURIComponent(stateChart.at));
        if (options.testId) parts.push('test_id=' + encodeURIComponent(String(options.testId)));
        if (options.applicationId) parts.push('application_id=' + encodeURIComponent(String(options.applicationId)));
        return API + '/stats?' + parts.join('&');
      }

      function load() {
        return api(query()).then(render).catch(function (e) {
          mount(wrap, section(t('sa.chart.title'), null), el('p', { class: 'sa-help' }, t('sa.error', { message: err(e) })));
        });
      }

      function periodButtons() {
        return segmented([
          ['day', t('sa.chart.day')], ['week', t('sa.chart.week')],
          ['month', t('sa.chart.month')], ['year', t('sa.chart.year')],
        ], stateChart.period, function (value) {
          // Keep the anchor date when switching segmentation: looking at March
          // and clicking Year should show the year March is in, not jump back
          // to today.
          stateChart.period = value;
          load();
        }, t('sa.chart.periodGroup'));
      }

      function render(data) {
        stateChart.at = data.at;
        var jump = el('input', { type: 'date', class: 'sa-date-input', value: data.at, title: t('sa.chart.jump') });
        jump.addEventListener('change', function () {
          if (!jump.value) return;
          stateChart.at = jump.value;
          load();
        });

        var prev = el('button', { class: 'ghost small', onclick: function () { stateChart.at = data.prev_at; load(); } }, '◀');
        var next = el('button', {
          class: 'ghost small',
          onclick: function () { if (data.has_next) { stateChart.at = data.next_at; load(); } },
        }, '▶');
        // A period that has not happened yet is not a place you can go.
        next.disabled = !data.has_next;

        var today = el('button', {
          class: 'ghost small',
          onclick: function () { stateChart.at = null; load(); },
        }, t('sa.chart.now'));
        today.disabled = !!data.is_current;

        var totals = data.totals || {};
        var stats = el('div', { class: 'sa-stats' },
          stat(t('sa.chart.runs'), totals.total),
          stat(t('sa.run.successRate'), totals.success_rate === null || totals.success_rate === undefined
            ? '—' : Math.round(totals.success_rate * 100) + '%'),
          stat(t('sa.chart.failed'), (totals.fail || 0) + (totals.error || 0)),
          stat(t('sa.run.avgDuration'), ms(totals.avg_duration_ms)));

        mount(wrap,
          section(t('sa.chart.title'), [periodButtons()]),
          el('div', { class: 'sa-chart-nav' },
            prev,
            el('span', { class: 'sa-chart-period' }, periodLabel(data)),
            next,
            today,
            el('label', { class: 'sa-chart-jump' }, t('sa.chart.jump'), jump)),
          stats,
          totals.total
            ? el('div', {},
              el('h4', { class: 'sa-chart-title' }, t('sa.chart.runsTitle')),
              outcomeChart(data),
              chartLegend(data),
              durationChart(data)
                ? el('div', {}, el('h4', { class: 'sa-chart-title' }, t('sa.chart.durationTitle')), durationChart(data))
                : null)
            : el('div', { class: 'sa-empty' }, t('sa.chart.empty')));
      }

      mount(wrap, section(t('sa.chart.title'), null), el('div', { class: 'sa-loading' }, t('sa.loading')));
      load();
      return wrap;
    }

    // ---------------------------------------------------------------- runs
    // "Fellis · Production · scheduled" — the application, the environment it ran
    // against and what started it. Each part is dropped when unknown rather than
    // rendered as a dash, so the line stays a sentence.
    function runSubtitle(run) {
      return [
        run.application_name,
        run.environment_name,
        run.trigger_source === 'schedule' ? t('sa.run.bySchedule') : t('sa.run.byHand'),
      ].filter(Boolean).join(' · ');
    }

    // The failure screenshot.
    //
    // It used to be `<img src="/api/service-tests/runs/:id/screenshot">`, which
    // could never load: an <img> cannot send the Authorization header the
    // dashboard authenticates with, so the request arrived anonymous, answered
    // 401 and rendered as a broken-image icon. It is fetched with the header and
    // shown as an object URL instead.
    function screenshotPanel(run) {
      var img = el('img', { class: 'sa-screenshot', alt: t('sa.run.screenshot') });
      var holder = el('div', {}, el('div', { class: 'sa-help' }, t('sa.run.screenshotLoading')));
      var loaded = false;

      var details = el('details', {}, el('summary', {}, t('sa.run.screenshot')), holder);
      // Fetched only when the section is opened — a screenshot is the heaviest
      // thing on the page and most visits never expand it.
      details.addEventListener('toggle', function () {
        if (!details.open || loaded) return;
        loaded = true;
        if (!apiBlob) { mount(holder, el('div', { class: 'sa-help' }, t('sa.run.screenshotUnavailable'))); return; }
        apiBlob(API + '/runs/' + run.id + '/screenshot')
          .then(function (url) {
            img.src = url;
            // The object URL is held by the document only while this image is on
            // screen; releasing it on unload keeps a long session from growing.
            img.addEventListener('load', function () { root.URL.revokeObjectURL(url); }, { once: true });
            mount(holder, img);
          })
          .catch(function (e) {
            mount(holder, el('div', { class: 'sa-help' }, t('sa.run.screenshotFailed', { message: err(e) })));
          });
      });
      return details;
    }

    // The layer verdict + the calls behind it (docs/service-assurance-v2.md §5).
    //
    // Computed in the browser from the stored calls rather than persisted: it is
    // a READING of the evidence, and a reading that lives in the database gets
    // stale the moment the rule behind it improves.
    function layerVerdict(run) {
      var calls = run.api_calls || [];
      if (!calls.length) return null;

      var documents = calls.filter(function (c) { return c.resource_type === 'document'; });
      var apis = calls.filter(function (c) { return c.resource_type !== 'document'; });
      var bad = function (c) { return c.status === 0 || (typeof c.status === 'number' && c.status >= 400); };
      var failedApi = apis.filter(bad).sort(function (a, b) { return (b.status || 0) - (a.status || 0); })[0] || null;
      var failedDoc = documents.filter(bad)[0] || null;
      var started = run.failure_kind === 'worker_misconfigured';

      var layers = [
        [t('sa.run.layerBrowser'), !started],
        [t('sa.run.layerPage'), !started && !failedDoc && !(run.console_errors || []).length],
        [t('sa.run.layerApi'), !started && !failedApi],
      ];
      var status = (failedApi && failedApi.status) || (failedDoc && failedDoc.status) || null;

      return el('div', { class: 'sa-layers' },
        el('div', { class: 'sa-layer-row' }, ...layers.map(function (pair) {
          return el('span', { class: 'sa-layer ' + (pair[1] ? 'ok' : 'bad') },
            el('span', { class: 'sa-layer-name' }, pair[0]),
            el('span', { class: 'sa-layer-mark' }, pair[1] ? '✓' : '✗'));
        }), status ? el('span', { class: 'chip' }, 'HTTP ' + status) : null),
        apiCallsTable(calls));
    }

    // Only the calls worth reading: everything that failed, and the slowest of
    // the rest. A passing run's forty successful requests answer no question.
    function apiCallsTable(calls) {
      var bad = calls.filter(function (c) { return c.status === 0 || c.status >= 400; });
      var slowest = calls.filter(function (c) { return !(c.status === 0 || c.status >= 400); })
        .sort(function (a, b) { return (b.duration_ms || 0) - (a.duration_ms || 0); })
        .slice(0, 5);
      var shown = bad.concat(slowest);
      if (!shown.length) return null;

      return el('details', { class: 'sa-api-calls' },
        el('summary', {}, t('sa.run.apiCalls', { n: String(calls.length) })),
        el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, t('sa.run.method')), el('th', {}, t('sa.run.address')),
            el('th', {}, t('sa.run.status')), el('th', {}, t('sa.run.duration')))),
          el('tbody', {}, ...shown.map(function (c) {
            var failed = c.status === 0 || c.status >= 400;
            return el('tr', { class: failed ? 'sa-api-bad' : '' },
              el('td', {}, c.method || '—'),
              el('td', { class: 'sa-api-url' }, c.url || '—'),
              el('td', {}, c.error ? c.error : (c.status ? String(c.status) : '—')),
              el('td', {}, ms(c.duration_ms)));
          }))));
    }

    views.runs = function (body) {
      if (state.runId) return runDetail(body, state.runId);
      return Promise.all([api(API + '/runs'), api(API + '/runs/worker-status')]).then(function (res) {
        var runs = res[0];
        var worker = res[1];
        var head = section(t('sa.tab.runs'), null);
        // Shown whenever nothing is processing the queue — not only once work
        // has piled up. Finding out AFTER queueing a test is finding out late.
        var warning = worker.connected
          ? el('p', { class: 'sa-help' }, t('sa.worker.connected', { count: String(worker.worker_count || 1) }))
          : noWorkerBanner();

        if (!runs.length) {
          mount(body, head, warning, el('div', { class: 'sa-empty' }, t('sa.run.noneYet')));
          return;
        }
        // Every test in the install lands in this one list, so a row has to say
        // WHAT it was a run of. Without it, four failures from one site and a
        // pass from another read as one service flapping — which is exactly how
        // a healthy test got mistaken for a failing one.
        var rows = runs.map(function (run) {
          return el('tr', { class: 'clickable', onclick: function () { state.runId = run.id; draw(); } },
            el('td', {}, statusChip(run.status)),
            el('td', {},
              el('div', { class: 'sa-run-test' }, run.test_name || t('sa.run.deletedTest')),
              el('div', { class: 'muted' }, runSubtitle(run))),
            el('td', {}, when(run.started_at || run.created_at)),
            el('td', {}, ms(run.duration_ms)),
            el('td', {}, run.error_message || ''));
        });
        mount(body, head, warning, el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, t('sa.run.status')), el('th', {}, t('sa.run.test')),
            el('th', {}, t('sa.run.started')), el('th', {}, t('sa.run.duration')), el('th', {}, ''))),
          el('tbody', {}, ...rows)));
      });
    };

    // ---------------------------------------------------------- evidence
    //
    // Everything the run OBSERVED, in one place (V2 §10): the page, the calls it
    // made, the steps and what each pointed at. Nothing here concludes anything
    // — the likely cause belongs to the failure panel, and keeping the two apart
    // is the rule that a probable cause is never presented as a fact.
    function showEvidence(runId) {
      api(API + '/runs/' + runId + '/evidence').then(function (e) {
        var api_ = e.api || { calls: [] };
        modal(t('sa.evidence.title'), el('div', {},
          el('p', { class: 'sa-help' }, t('sa.evidence.help')),

          evidenceSection(t('sa.evidence.page'), el('div', { class: 'sa-kv' },
            kv(t('sa.evidence.url'), e.page.url || '—'),
            kv(t('sa.evidence.duration'), e.timings.total_label || '—'),
            e.timings.slowest_step
              ? kv(t('sa.evidence.slowestStep'), e.timings.slowest_step.label + ' · ' + ms(e.timings.slowest_step.duration_ms))
              : null,
            e.page.error_message ? kv(t('sa.evidence.error'), e.page.error_message) : null)),

          api_.calls.length ? evidenceSection(
            t('sa.evidence.api', { total: api_.total, failed: api_.failed }),
            el('table', { class: 'data-table' },
              el('thead', {}, el('tr', {},
                el('th', {}, t('sa.evidence.method')),
                el('th', {}, t('sa.evidence.url')),
                el('th', {}, t('sa.evidence.status')),
                el('th', {}, t('sa.evidence.time')))),
              el('tbody', {}, ...api_.calls.slice(0, 50).map(function (c) {
                return el('tr', { class: c.status === 0 || c.status >= 400 ? 'sa-row-bad' : '' },
                  el('td', {}, c.method || '—'),
                  el('td', { class: 'sa-evidence-url' }, c.url || '—'),
                  // Status 0 means it never completed, which reads as "fine" to
                  // anyone scanning for 4xx and 5xx — so it gets said in words.
                  el('td', {}, c.status === 0 ? t('sa.evidence.noResponse') : String(c.status == null ? '—' : c.status)),
                  el('td', {}, ms(c.duration_ms)));
              }))) ) : null,

          e.steps.length ? evidenceSection(t('sa.evidence.steps'),
            el('ol', { class: 'sa-record-steps' }, ...e.steps.map(function (st) {
              return el('li', { class: 'sa-outcome-' + (st.status === 'pass' ? 'ok' : (st.status === 'fail' ? 'broken' : 'unknown')) },
                el('strong', {}, st.label || st.step_type), ' ',
                st.target_label ? el('span', { class: 'muted' }, '\u2192 ' + st.target_label) : null,
                el('span', { class: 'muted' }, ' \u00b7 ' + ms(st.duration_ms)));
            }))) : null,

          (e.page.console_errors || []).length ? evidenceSection(t('sa.evidence.console'),
            el('pre', { class: 'sa-pre' }, e.page.console_errors.join('\n'))) : null),
        null, t('sa.close'));
      }).catch(function (err_) { toast(err(err_), true); });
    }

    function evidenceSection(title, content) {
      return el('div', { class: 'sa-evidence-section' }, el('h4', {}, title), content);
    }

    function kv(label, value) {
      return el('div', { class: 'sa-kv-row' },
        el('span', { class: 'muted' }, label), el('span', {}, String(value)));
    }

    function runDetail(body, id) {
      return api(API + '/runs/' + id).then(function (run) {
        var head = el('div', {},
          el('button', { class: 'ghost small', onclick: function () { state.runId = null; draw(); } }, '← ' + t('sa.back')),
          section(run.test_name || t('sa.run.deletedTest'), [
            statusChip(run.status),
            // Everything this run observed, in one place (V2 §10).
            el('button', { class: 'ghost small', onclick: function () { showEvidence(run.id); } }, t('sa.evidence.open')),
          ]),
          el('p', { class: 'sa-help' }, runSubtitle(run)));

        var summary = el('div', { class: 'sa-stats' },
          stat(t('sa.run.status'), String(run.status).toUpperCase()),
          stat(t('sa.run.steps'), (run.steps || []).length),
          stat(t('sa.run.duration'), ms(run.duration_ms)));

        // Performance as metadata on the result (V2 §9), not a separate screen.
        // Absent when there is not enough history to say what normal is — which
        // is an answer, and must not be dressed up as "normal".
        var perf = run.performance && run.performance.verdict !== 'unknown'
          ? el('div', { class: 'sa-perf sa-perf-' + run.performance.verdict },
            el('strong', {}, t(run.performance.verdict === 'slow' ? 'sa.perf.slow'
              : (run.performance.verdict === 'fast' ? 'sa.perf.fast' : 'sa.perf.normal'))),
            el('span', {}, ' ' + run.performance.reason))
          : (run.performance ? el('p', { class: 'muted' }, run.performance.reason) : null);

        // The failure, in plain language first and technical detail behind a
        // disclosure — spec §36.
        var failure = null;
        if (run.status === 'fail' || run.status === 'error') {
          var failedStep = (run.steps || []).find(function (s) { return s.status === 'fail'; });
          var detail = failedStep && failedStep.detail;
          var classification = detail && detail.classification;
          failure = el('div', { class: 'sa-failure' },
            failedStep ? el('h4', {}, t('sa.run.failedStep', { n: failedStep.position + 1, label: failedStep.label })) : null,
            classification ? el('p', { class: 'sa-failure-summary' }, classification.summary) : null,
            classification ? el('p', {}, el('strong', {}, t('sa.run.likelyCause') + ': '), classification.likely_cause) : null,
            classification ? el('p', { class: 'muted' }, classification.explanation) : null,
            classification && classification.http_status
              ? el('p', {}, el('span', { class: 'chip' }, 'HTTP ' + classification.http_status)) : null,
            // What was actually OBSERVED, in the operator's words. The classifier
            // has always collected this — which request returned which status,
            // which addresses the policy refused — and the page used to throw it
            // away and show only the generic one-liner, leaving "The server
            // rejected the request" with no way to find out WHICH request.
            // Browser ✓ · Page ✓ · API ✗ · HTTP 503 — three answers, not one.
            // "The test failed" is what the operator already knows; WHICH layer
            // failed is what they came for.
            layerVerdict(run),
            classification && (classification.evidence || []).length
              ? el('div', { class: 'sa-evidence' },
                el('h5', {}, t('sa.run.whatWeSaw')),
                el('ul', {}, ...classification.evidence.map(function (line) { return el('li', {}, line); })))
              : null,
            run.screenshot_path ? screenshotPanel(run) : null,
            el('details', {}, el('summary', {}, t('sa.technicalDetails')),
              el('pre', { class: 'sa-pre' }, JSON.stringify({
                error: run.error_message,
                kind: run.failure_kind,
                console_errors: run.console_errors,
                network_errors: run.network_errors,
              }, null, 2))));
        }

        var steps = el('table', { class: 'data-table' }, el('tbody', {}, ...(run.steps || []).map(function (s) {
          return el('tr', {},
            el('td', {}, String(s.position + 1)),
            el('td', {}, s.label),
            el('td', {}, statusChip(s.status)),
            el('td', {}, ms(s.duration_ms)),
            el('td', {}, s.message || ''));
        })));

        mount(body, head, summary, perf, failure, steps, visualPanel(run), accessibilityPanel(run));
      });
    }

    // Visual regression (V2 §8).
    //
    // Like accessibility, and for the same reason: a difference is reported
    // BESIDE the result, never as it. A moved button is not an outage, and a
    // check that can turn a build red is a check people switch off — at which
    // point it watches nothing.
    function visualPanel(run) {
      var results = run.visual;
      // Nothing was compared. Not the same as "everything matched", so nothing
      // is shown rather than a reassuring empty panel.
      if (!results || !results.length) return null;

      return el('div', { class: 'sa-panel sa-visual' },
        el('div', { class: 'sa-a11y-head' },
          el('strong', {}, t('sa.visual.title')),
          el('span', { class: 'sa-help' }, t('sa.visual.neverFails'))),
        el('div', { class: 'sa-a11y-list' }, ...results.map(function (v) { return visualItem(run, v); })));
    }

    function visualItem(run, v) {
      var body = el('div', {});
      if (v.status === 'match') {
        mount(body, el('p', { class: 'muted' }, v.explanation || t('sa.visual.match')));
      } else if (v.status === 'uncomparable') {
        // Said plainly. "Could not be compared" is a real answer and a very
        // different one from "nothing changed" — reported as a match it would
        // mean a step silently stopped being watched.
        mount(body, el('p', { class: 'sa-warn' }, v.reason || t('sa.visual.uncomparable')));
      } else {
        mount(body,
          el('p', {}, v.explanation || ''),
          // What changed and where, in numbers a person can check.
          el('p', { class: 'muted' }, t('sa.visual.numbers', {
            changed: v.changed_pixels || 0,
            compared: v.compared_pixels || 0,
            ignored: v.ignored_pixels || 0,
          })),
          v.image_path
            ? el('details', {}, el('summary', {}, t('sa.visual.seeIt')),
              el('p', { class: 'sa-help' }, t('sa.visual.seeItHelp')))
            : null,
          // Accepting is an ACT and says so: this becomes what the page should
          // look like from now on, for every later run.
          isOperator()
            ? el('button', {
              class: 'ghost small',
              onclick: function () { acceptBaseline(run, v); },
            }, t('sa.visual.accept'))
            : null);
      }

      return el('div', { class: 'sa-a11y-item sa-visual-' + v.status },
        el('div', { class: 'sa-a11y-item-head' },
          el('span', { class: 'sa-a11y-chip sa-visual-chip-' + v.status }, visualStatusLabel(v.status)),
          el('strong', {}, v.step_label || ('#' + v.step_index))),
        body);
    }

    function visualStatusLabel(status) {
      if (status === 'match') return t('sa.visual.statusMatch');
      if (status === 'changed') return t('sa.visual.statusChanged');
      if (status === 'resized') return t('sa.visual.statusResized');
      return t('sa.visual.statusUncomparable');
    }

    function acceptBaseline(run, v) {
      if (!root.confirm(t('sa.visual.acceptConfirm', { step: v.step_label || ('#' + v.step_index) }))) return;
      api(API + '/baselines', {
        method: 'POST',
        body: { run_id: run.id, step_index: v.step_index },
      })
        .then(function () { toast(t('sa.visual.accepted')); draw(); })
        .catch(function (e) { toast(err(e), true); });
    }

    // Accessibility (V2 §9).
    //
    // Below the steps and visually apart from the failure block, because the
    // spec says these are reported SEPARATELY from functional failures and means
    // it. An image with no alt text is not the service being down. Mixing the two
    // makes both useless: the run status stops meaning "the journey works", and
    // the accessibility report becomes the thing people switch off to get a green
    // build.
    //
    // So: no red, no status chip, nothing that can be mistaken for the verdict.
    function accessibilityPanel(run) {
      var a = run.accessibility;
      // Not collected is NOT the same as clean, and a reassuring empty panel
      // would be a lie about a page nobody looked at. Nothing is shown at all.
      if (!a) return null;

      var counts = a.counts || {};
      var findings = a.findings || [];

      var head = el('div', { class: 'sa-a11y-head' },
        el('strong', {}, t('sa.a11y.title')),
        el('span', { class: 'sa-a11y-counts' },
          ...['serious', 'moderate', 'minor'].map(function (impact) {
            if (!counts[impact]) return null;
            return el('span', { class: 'sa-a11y-chip sa-a11y-' + impact },
              counts[impact] + ' ' + impactLabel(impact));
          })));

      if (!findings.length) {
        return el('div', { class: 'sa-panel sa-a11y' }, head,
          // Says what it looked at, so "nothing found" can be read for what it
          // is: these checks found nothing, not "this page is accessible".
          el('p', { class: 'sa-help' }, t('sa.a11y.clean', {
            elements: (a.checked && a.checked.elements) || 0,
          })));
      }

      return el('div', { class: 'sa-panel sa-a11y' }, head,
        el('p', { class: 'sa-help' }, t('sa.a11y.help')),
        a.collection_truncated || a.truncated
          ? el('p', { class: 'sa-warn' }, t('sa.a11y.truncated', { shown: findings.length, total: counts.total || findings.length }))
          : null,
        el('div', { class: 'sa-a11y-list' }, ...findings.map(a11yFinding)));
    }

    function impactLabel(impact) {
      if (impact === 'serious') return t('sa.a11y.serious');
      if (impact === 'moderate') return t('sa.a11y.moderate');
      return t('sa.a11y.minor');
    }

    function a11yFinding(f) {
      var element = f.element || {};
      return el('div', { class: 'sa-a11y-item sa-a11y-' + f.impact },
        el('div', { class: 'sa-a11y-item-head' },
          el('span', { class: 'sa-a11y-chip sa-a11y-' + f.impact }, impactLabel(f.impact)),
          el('strong', {}, f.message)),
        // WHY it matters, in the operator's words. A rule code is a finding
        // nobody acts on.
        el('p', { class: 'sa-a11y-why' }, f.why),
        // Enough to go and find it. A finding you cannot locate is one you
        // cannot fix.
        el('div', { class: 'sa-a11y-where' },
          element.selector ? el('code', {}, element.selector) : null,
          element.text ? el('span', { class: 'muted' }, ' \u2014 \u201c' + element.text + '\u201d') : null));
    }

    // -------------------------------------------------------------- history
    // Every run in the install, as a picture. The Runs tab answers "what just
    // happened"; this one answers "how has it been going", which is the question
    // a weekly report is written from.
    views.history = function (body) {
      // Applications are loaded only to offer the filter — the chart itself is
      // one request, whatever is selected.
      return api(API + '/applications').then(function (apps) {
        var selected = state.chartApplicationId || '';
        var picker = el('select', { class: 'sa-select' },
          el('option', { value: '' }, t('sa.chart.allApplications')),
          ...apps.map(function (a) {
            var option = el('option', { value: String(a.id) }, a.name);
            if (String(a.id) === String(selected)) option.selected = true;
            return option;
          }));
        picker.addEventListener('change', function () {
          state.chartApplicationId = picker.value || null;
          draw();
        });

        mount(body,
          section(t('sa.tab.history'), [el('label', { class: 'sa-chart-jump' }, t('sa.chart.application'), picker)]),
          historyChart({ applicationId: state.chartApplicationId || null }));
      });
    };

    // ------------------------------------------ top applications by criticals
    //
    // "Which services gave us the most trouble this period" — a magnitude
    // ranking over long, named categories, which is a HORIZONTAL bar chart and
    // nothing else. Vertical columns would turn ten application names into
    // rotated stubs, and a pie of ten slices answers no question at all.
    //
    // ONE hue, not a palette — and not a NEW hue either: the bars reuse
    // .sa-bar-failed, the red this page already uses for "this is the bad one".
    // Because every bar is that same colour, filtering the list cannot repaint
    // the survivors, and a single series needs no legend: the title says what
    // the bars are.
    // The categorical palette, in the order the design system fixes. The order
    // IS the colourblind-safety mechanism, not decoration, so slots are assigned
    // in sequence and NEVER cycled: a ninth series folds into "Other" rather
    // than getting a generated hue that nobody can tell from slot 3.
    //
    // Colour follows the APPLICATION, not its rank in the current filter, so
    // narrowing the picker cannot repaint the lines that survive.
    var SERIES_SLOTS = 8;

    function seriesClass(i) {
      return i >= SERIES_SLOTS ? 'sa-series-other' : 'sa-series-' + (i + 1);
    }

    // Nice round axis maximum, so the gridlines land on numbers a person reads.
    function niceMax(value) {
      if (value <= 5) return Math.max(1, value);
      var pow = Math.pow(10, Math.floor(Math.log10(value)));
      return Math.ceil(value / (pow / 2)) * (pow / 2);
    }

    // One chart, three forms. The DATA is the same in all of them — counts per
    // bucket per application — so the choice is about what the reader is doing:
    // a line reads a trend, grouped bars compare buckets, stacked bars read a
    // total with its composition.
    function incidentChart(data, form) {
      var series = data.series || [];
      var buckets = data.buckets || [];
      if (!series.length || !buckets.length) return null;

      var W = 760;
      var H = 300;
      var PAD = { top: 12, right: 16, bottom: 28, left: 40 };
      var plotW = W - PAD.left - PAD.right;
      var plotH = H - PAD.top - PAD.bottom;

      var stacked = form === 'stacked';
      var perBucket = buckets.map(function (_, i) {
        return series.reduce(function (acc, ser) { return acc + (ser.points[i] || 0); }, 0);
      });
      var peak = stacked
        ? perBucket.reduce(function (m, v) { return Math.max(m, v); }, 0)
        : series.reduce(function (m, ser) {
          return Math.max(m, ser.points.reduce(function (n, v) { return Math.max(n, v); }, 0));
        }, 0);
      var max = niceMax(peak || 1);

      var xOf = function (i) {
        return buckets.length === 1
          ? PAD.left + plotW / 2
          : PAD.left + (i / (buckets.length - 1)) * plotW;
      };
      var yOf = function (v) { return PAD.top + plotH - (v / max) * plotH; };

      var svg = svgEl('svg', {
        class: 'sa-chart-svg', viewBox: '0 0 ' + W + ' ' + H,
        role: 'img', 'aria-label': t('sa.top.title'),
      });

      // Recessive grid + y labels.
      [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
        var v = max * f;
        var y = yOf(v);
        svg.appendChild(svgEl('line', { class: 'sa-chart-grid', x1: PAD.left, x2: W - PAD.right, y1: y.toFixed(1), y2: y.toFixed(1) }));
        svg.appendChild(svgEl('text', {
          class: 'sa-chart-axis', x: PAD.left - 8, y: (y + 4).toFixed(1), 'text-anchor': 'end',
        }, [document.createTextNode(String(Math.round(v)))]));
      });

      // X labels: only as many as fit, the tooltip carries the rest.
      var every = Math.max(1, Math.ceil(buckets.length / 12));
      buckets.forEach(function (b, i) {
        if (i % every) return;
        svg.appendChild(svgEl('text', {
          class: 'sa-chart-axis', x: xOf(i).toFixed(1), y: H - 8, 'text-anchor': 'middle',
        }, [document.createTextNode(bucketLabel(b.start, data.bucket))]));
      });

      if (form === 'line') {
        series.forEach(function (ser, si) {
          var d = ser.points.map(function (v, i) { return (i ? 'L' : 'M') + xOf(i).toFixed(1) + ',' + yOf(v).toFixed(1); }).join('');
          svg.appendChild(svgEl('path', { class: 'sa-series-line ' + seriesClass(si), d: d }));
          ser.points.forEach(function (v, i) {
            svg.appendChild(svgEl('g', { class: 'sa-chart-bar' }, [
              svgTitle(t('sa.top.point', { app: ser.application_name, n: String(v), when: bucketLabel(buckets[i].start, data.bucket) })),
              svgEl('circle', { class: 'sa-series-dot ' + seriesClass(si), cx: xOf(i).toFixed(1), cy: yOf(v).toFixed(1), r: 4 }),
            ]));
          });
        });
      } else {
        // Grouped or stacked columns. A 2px surface gap between fills either way.
        var slot = plotW / Math.max(1, buckets.length);
        var groupW = Math.max(4, slot * 0.7);
        var barW = stacked ? groupW : Math.max(2, (groupW / series.length) - 2);
        buckets.forEach(function (b, i) {
          var x0 = xOf(i) - groupW / 2;
          var stackTop = PAD.top + plotH;
          series.forEach(function (ser, si) {
            var v = ser.points[i] || 0;
            if (!v) return;
            var h = (v / max) * plotH;
            var x = stacked ? x0 : x0 + si * (barW + 2);
            var y = stacked ? (stackTop - h) : yOf(v);
            if (stacked) stackTop -= h + 2; // the surface gap between segments
            svg.appendChild(svgEl('g', { class: 'sa-chart-bar' }, [
              svgTitle(t('sa.top.point', { app: ser.application_name, n: String(v), when: bucketLabel(b.start, data.bucket) })),
              svgEl('path', { class: 'sa-series-fill ' + seriesClass(si), d: barPath(x, y, barW, Math.max(1, h), 4) }),
            ]));
          });
        });
      }
      return svg;
    }

    // The legend. Always present for two or more series — identity must never be
    // carried by colour alone — and it doubles as the totals table, so the
    // ranking the operator asked for is readable as numbers too.
    function incidentLegend(series) {
      if (!series.length) return null;
      return el('div', { class: 'sa-legend' }, ...series.map(function (ser, i) {
        return el('span', { class: 'sa-legend-item' },
          el('span', { class: 'sa-legend-swatch ' + seriesClass(i) }),
          ser.application_name + ' (' + ser.total + ')');
      }));
    }

    // A searchable, multiple-choice application filter.
    //
    // Hand-rolled because the repo ships no UI library and is not about to grow
    // one for a dropdown. Deliberately NOT a native <select multiple>: that has
    // no search, and ctrl-clicking to keep a selection is the kind of thing
    // people get wrong once and then distrust.
    //
    // No selection means ALL — the honest default for a filter nobody has
    // touched. Clearing the last chip returns to that rather than to an empty
    // chart.
    function applicationPicker(apps, selected, onChange) {
      var open = false;
      var wrap = el('div', { class: 'sa-picker' });
      var search = el('input', { type: 'text', class: 'sa-date-input sa-picker-search', placeholder: t('sa.top.searchApps') });
      var list = el('div', { class: 'sa-picker-list' });

      function draw() {
        var q = search.value.trim().toLowerCase();
        var matches = apps.filter(function (a) { return !q || a.name.toLowerCase().indexOf(q) >= 0; });
        mount(list, ...(matches.length ? matches.map(function (a) {
          var box = el('input', { type: 'checkbox' });
          box.checked = selected.indexOf(a.id) >= 0;
          box.addEventListener('change', function () {
            if (box.checked) { if (selected.indexOf(a.id) < 0) selected.push(a.id); }
            else selected.splice(selected.indexOf(a.id), 1);
            onChange();
            chips();
          });
          return el('label', { class: 'sa-picker-option' }, box, el('span', {}, a.name));
        }) : [el('div', { class: 'sa-help' }, t('sa.top.noMatch'))]));
      }

      var chipRow = el('div', { class: 'sa-picker-chips' });
      function chips() {
        mount(chipRow, ...(selected.length ? selected.map(function (id) {
          var app = apps.find(function (a) { return a.id === id; });
          return el('span', { class: 'sa-chip' },
            el('span', {}, app ? app.name : String(id)),
            el('button', {
              class: 'sa-chip-x', title: t('sa.top.clearOne'),
              onclick: function () { selected.splice(selected.indexOf(id), 1); onChange(); chips(); draw(); },
            }, '×'));
        }).concat([el('button', {
          class: 'ghost small',
          onclick: function () { selected.length = 0; onChange(); chips(); draw(); },
        }, t('sa.top.clearAll'))]) : [el('span', { class: 'sa-help' }, t('sa.top.allApps'))]));
      }

      var toggle = el('button', {
        class: 'ghost small',
        onclick: function () { open = !open; panel.hidden = !open; if (open) search.focus(); },
      }, t('sa.top.chooseApps'));

      var panel = el('div', { class: 'sa-picker-panel' }, search, list);
      panel.hidden = true;
      search.addEventListener('input', draw);

      draw();
      chips();
      mount(wrap, el('div', { class: 'sa-picker-head' }, toggle, chipRow), panel);
      return wrap;
    }

    // The panel: period controls + application filter + the ranking.
    function topApplicationsPanel() {
      var wrap = el('div', { class: 'sa-panel sa-chart-panel' });
      // Month by default: the Health page's question is "how has this month
      // been", not "what happened in the last hour".
      // Month and a line chart by default: the Health page's question is "how
      // has this month been", and a trend is what a line answers.
      var st = { period: 'month', at: null, apps: [], form: 'line' };
      var allApps = [];

      function query() {
        var parts = ['period=' + encodeURIComponent(st.period),
          'tz_offset=' + encodeURIComponent(String(new Date().getTimezoneOffset()))];
        if (st.at) parts.push('at=' + encodeURIComponent(st.at));
        if (st.apps.length) parts.push('application_ids=' + encodeURIComponent(st.apps.join(',')));
        return API + '/assurance/top-applications?' + parts.join('&');
      }

      function load() {
        return Promise.all([
          api(query()),
          allApps.length ? Promise.resolve(allApps) : api(API + '/applications'),
        ]).then(function (res) {
          allApps = res[1] || [];
          render(res[0]);
        }).catch(function (e) {
          mount(wrap, section(t('sa.top.title'), null), el('p', { class: 'sa-help' }, t('sa.error', { message: err(e) })));
        });
      }

      function periodButtons() {
        return segmented([
          ['day', t('sa.chart.day')], ['week', t('sa.chart.week')],
          ['month', t('sa.chart.month')], ['year', t('sa.chart.year')],
        ], st.period, function (value) { st.period = value; load(); }, t('sa.chart.periodGroup'));
      }

      // The chart type. Same data in all three — counts per bucket per
      // application — so the choice is about what the reader is doing: a line
      // reads a trend, grouped bars compare buckets side by side, stacked bars
      // read a total with its composition. Switching redraws from the data
      // already in hand; it never re-fetches.
      function formButtons(data) {
        return segmented([
          ['line', t('sa.top.formLine')], ['bars', t('sa.top.formBars')], ['stacked', t('sa.top.formStacked')],
        ], st.form, function (value) { st.form = value; render(data); }, t('sa.top.formGroup'));
      }

      function render(data) {
        st.at = data.at;
        var jump = el('input', { type: 'date', class: 'sa-date-input', value: data.at, title: t('sa.chart.jump') });
        jump.addEventListener('change', function () { if (jump.value) { st.at = jump.value; load(); } });

        var next = el('button', { class: 'ghost small', onclick: function () { if (data.has_next) { st.at = data.next_at; load(); } } }, '▶');
        next.disabled = !data.has_next;
        var now = el('button', { class: 'ghost small', onclick: function () { st.at = null; load(); } }, t('sa.chart.now'));
        now.disabled = !!data.is_current;

        var series = data.series || [];
        mount(wrap,
          section(t('sa.top.title'), null),
          el('p', { class: 'sa-help' }, t('sa.top.help')),
          el('div', { class: 'sa-chart-nav' },
            periodButtons(),
            el('button', { class: 'ghost small', onclick: function () { st.at = data.prev_at; load(); } }, '◀'),
            el('span', { class: 'sa-chart-period' }, periodLabel(Object.assign({ buckets: [] }, data))),
            next, now,
            el('span', { class: 'sa-chart-jump' }, t('sa.chart.jump'), jump),
            formButtons(data)),
          applicationPicker(allApps, st.apps, function () { load(); }),
          // An empty chart is GOOD NEWS and has to read as good news — an empty
          // plot area reads as "broken", which is the opposite.
          series.length
            ? incidentChart(data, st.form)
            : el('div', { class: 'sa-empty' }, t('sa.top.none')),
          series.length ? incidentLegend(series) : null,
          series.length > SERIES_SLOTS
            ? el('p', { class: 'sa-help' }, t('sa.top.tooMany', { n: String(SERIES_SLOTS) }))
            : null);
      }

      load();
      return wrap;
    }

    // --------------------------------------------------------------- health
    // What the module has REACTED to: incidents it opened, and the certificate
    // on every address it watches. This is the screen an operator opens when
    // they want the one-line answer to "is anything wrong right now?".
    views.health = function (body) {
      return Promise.all([
        api(API + '/assurance/incidents?status=open'),
        api(API + '/assurance/certificates'),
        api(API + '/assurance/summary'),
      ]).then(function (res) {
        var incidents = res[0];
        var certificates = res[1];
        var summary = res[2];

        var head = section(t('sa.tab.health'), isOperator()
          ? el('button', { class: 'ghost small', onclick: checkCertificatesNow }, t('sa.health.checkNow'))
          : null);

        var counts = el('div', { class: 'sa-stats' },
          stat(t('sa.health.openCrit'), (summary.open && summary.open.CRIT) || 0),
          stat(t('sa.health.openWarn'), (summary.open && summary.open.WARN) || 0),
          stat(t('sa.health.certsWatched'), (summary.certificates && summary.certificates.total) || 0),
          stat(t('sa.health.certsExpiring'), (summary.certificates && summary.certificates.expiring) || 0));

        mount(body, head, counts, topApplicationsPanel(), incidentsPanel(incidents), certificatesPanel(certificates));
      });
    };

    function severityChip(severity) {
      return el('span', { class: 'sa-sev sa-sev-' + String(severity || '').toLowerCase() }, String(severity || ''));
    }

    // Days remaining, coloured by how much trouble it is. A number on its own
    // does not say whether 12 is fine — the chip does.
    function daysChip(days, status) {
      if (days === null || days === undefined) return el('span', { class: 'sa-days sa-days-unknown' }, '—');
      var tone = status === 'expired' || days < 0 ? 'bad' : (days <= 7 ? 'bad' : (days <= 30 ? 'warn' : 'ok'));
      var label = days < 0 ? t('sa.health.expiredDaysAgo', { n: String(Math.abs(days)) }) : t('sa.health.daysLeft', { n: String(days) });
      return el('span', { class: 'sa-days sa-days-' + tone }, label);
    }

    function incidentsPanel(incidents) {
      if (!incidents.length) {
        return el('div', { class: 'sa-panel' },
          section(t('sa.health.incidents'), null),
          el('div', { class: 'sa-empty' }, t('sa.health.allClear')));
      }
      var rows = incidents.map(function (incident) {
        return el('tr', {},
          el('td', {}, severityChip(incident.severity),
            // A severity a rule changed says so. A downgraded critical that
            // looks exactly like a detected warning is how a dashboard goes
            // green without anyone deciding it should.
            incident.original_severity
              ? el('div', { class: 'muted' }, t('sa.health.wasSeverity', { severity: incident.original_severity }))
              : null),
          el('td', {}, incident.subject_label || incident.subject_key),
          el('td', {},
            el('div', {}, incident.summary || ''),
            el('div', { class: 'muted' }, incident.likely_cause ? t('sa.run.likelyCause') + ': ' + incident.likely_cause : ''),
            el('details', {},
              el('summary', {}, t('sa.technicalDetails')),
              el('pre', { class: 'sa-pre' }, (incident.evidence || []).join('\n') + (incident.explanation ? '\n\n' + incident.explanation : '')))),
          el('td', {}, when(incident.opened_at)),
          el('td', {}, String(incident.occurrences || 1)),
          el('td', {},
            isOperator()
              ? el('button', { class: 'ghost small', onclick: function () { resolveIncident(incident); } }, t('sa.health.resolve'))
              : null,
            // Only when the host dashboard offers the form. The module does not
            // own the severity-rule screens and will not grow a second copy.
            (isAdmin() && ctx.editSeverityRule)
              ? el('button', {
                class: 'ghost small',
                title: t('sa.health.severityRuleHelp'),
                onclick: function () {
                  ctx.editSeverityRule({
                    source: 'service_assurance',
                    match_kind: incident.kind,
                    match_application_id: incident.application_id,
                  });
                },
              }, t('sa.health.severityRule'))
              : null));
      });
      return el('div', { class: 'sa-panel' },
        section(t('sa.health.incidents'), null),
        el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, t('sa.health.severity')), el('th', {}, t('sa.health.subject')),
            el('th', {}, t('sa.health.whatHappened')), el('th', {}, t('sa.health.since')),
            el('th', {}, t('sa.health.seen')), el('th', {}, ''))),
          el('tbody', {}, ...rows)));
    }

    function certificatesPanel(certificates) {
      if (!certificates.length) {
        return el('div', { class: 'sa-panel' },
          section(t('sa.health.certificates'), null),
          el('div', { class: 'sa-empty' }, t('sa.health.noCertificates')));
      }
      var rows = certificates.map(function (cert) {
        return el('tr', {},
          el('td', {}, cert.host + (cert.port && cert.port !== 443 ? ':' + cert.port : '')),
          el('td', {}, cert.issuer || '—'),
          el('td', {}, cert.valid_to ? when(cert.valid_to) : '—'),
          el('td', {}, daysChip(cert.days_remaining, cert.status)),
          el('td', {}, statusChip(cert.status)),
          el('td', { class: 'muted' }, cert.error_message || ''));
      });
      return el('div', { class: 'sa-panel' },
        section(t('sa.health.certificates'), null),
        el('p', { class: 'sa-help' }, t('sa.health.certificatesHelp')),
        el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, t('sa.health.host')), el('th', {}, t('sa.health.issuer')),
            el('th', {}, t('sa.health.expires')), el('th', {}, t('sa.health.remaining')),
            el('th', {}, t('sa.run.status')), el('th', {}, ''))),
          el('tbody', {}, ...rows)));
    }

    function checkCertificatesNow() {
      toast(t('sa.health.checking'));
      api(API + '/assurance/certificates/check', { method: 'POST', body: {} })
        .then(function (res) { toast(t('sa.health.checked', { n: String((res && res.checked) || 0) })); draw(); })
        .catch(function (e) { toast(err(e), true); });
    }

    // Resolving by hand does not fix anything — the next sweep re-opens the
    // incident if the condition still holds — so the confirm says so rather than
    // letting an operator think they have silenced it.
    function resolveIncident(incident) {
      if (!root.confirm(t('sa.health.confirmResolve', { subject: incident.subject_label || incident.subject_key }))) return;
      api(API + '/assurance/incidents/' + incident.id + '/resolve', { method: 'POST', body: {} })
        .then(function () { toast(t('sa.health.resolved')); draw(); })
        .catch(function (e) { toast(err(e), true); });
    }

    // ------------------------------------------------------------ schedules
    views.schedules = function (body) {
      return Promise.all([api(API + '/schedules'), api(API + '/tests')]).then(function (res) {
        var schedules = res[0];
        var tests = res[1];
        var byId = {};
        tests.forEach(function (x) { byId[x.id] = x; });

        var head = section(t('sa.schedule.title'), isOperator()
          ? el('button', {
            class: 'primary',
            onclick: function () { scheduleForm(tests, function () { draw(); }); },
          }, '+ ' + t('sa.schedule.add'))
          : null);

        if (!schedules.length) {
          mount(body, head, el('div', { class: 'sa-empty' },
            t(tests.length ? 'sa.schedule.noneYet' : 'sa.schedule.noTests')));
          return;
        }
        mount(body, head, el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, t('sa.schedule.test')),
            el('th', {}, t('sa.schedule.every')),
            el('th', {}, t('sa.schedule.next')),
            el('th', {}, ''))),
          el('tbody', {}, ...schedules.map(function (s) {
            return el('tr', { class: 'clickable', onclick: function () { state.tab = 'tests'; state.testId = s.test_id; draw(); } },
              el('td', {}, (byId[s.test_id] && byId[s.test_id].name) || ('#' + s.test_id)),
              el('td', {}, s.description),
              el('td', {}, when(s.next_run_at)),
              el('td', {}, s.missed_intervals > 2 ? el('span', { class: 'sa-warn' }, t('sa.schedule.behind', { count: s.missed_intervals })) : ''));
          }))));
      });
    };

    // The schedule form, shared by the global Schedules tab (where a test must be
    // picked) and a test's own page (where it is already known).
    function scheduleForm(tests, onSaved, fixedTest) {
      if (!fixedTest && !tests.length) { toast(t('sa.schedule.noTests'), true); return; }
      api(API + '/schedules/intervals').then(function (res) {
        var testSel = fixedTest ? null : el('select', {},
          ...tests.map(function (x) { return el('option', { value: String(x.id) }, x.name); }));
        var every = el('select', {}, ...res.intervals.map(function (i) {
          return el('option', { value: String(i.seconds) }, i.da || i.en);
        }));
        var tz = el('input', { type: 'text', value: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
        var errors = el('div', { class: 'sa-form-errors' });

        modal(t('sa.schedule.add'), el('div', {},
          testSel ? field(t('sa.schedule.test'), testSel) : null,
          field(t('sa.schedule.every'), every),
          field(t('sa.schedule.timezone'), tz),
          errors), function () {
          return api(API + '/schedules', {
            method: 'POST',
            body: {
              test_id: fixedTest ? fixedTest.id : Number(testSel.value),
              interval_sec: Number(every.value),
              timezone: tz.value.trim(),
            },
          }).then(onSaved).catch(function (e) { showErrors(errors, e); throw e; });
        });
      }).catch(function (e) { toast(err(e), true); });
    }

    // ------------------------------------------------------------ settings
    // Rendered in Administration → Settings → Service Assurance, not in this
    // module's own tab bar: every value here is SYSTEM-WIDE, and BlueEye keeps
    // system-wide configuration in one place. The per-application settings —
    // base URL, environments, logins, allowed hosts — stay on the application.
    //
    // Fields carry human labels and units. `maxDurationMs` is what the API
    // calls it; "Stop the whole crawl after — milliseconds" is what an operator
    // needs to read.
    // Every label as a LITERAL t() key.
    //
    // Concatenating the prefix with the field name would be shorter and worse:
    // the UI gate verifies each key exists in both catalogues by reading the
    // literals out of this file, and a computed key defeats that — a typo, or a
    // field the API adds later, would render as the raw name with nothing to
    // catch it. Written out, the gate fails the build instead.
    function settingLabel(key) {
      var labels = {
        publicUrl: t('sa.set.publicUrl'),
        maxAddressesPerApplication: t('sa.set.maxAddressesPerApplication'),
        minCidrPrefix: t('sa.set.minCidrPrefix'),
        maxPages: t('sa.set.maxPages'),
        maxDepth: t('sa.set.maxDepth'),
        maxRequests: t('sa.set.maxRequests'),
        navigationTimeoutMs: t('sa.set.navigationTimeoutMs'),
        maxDurationMs: t('sa.set.maxDurationMs'),
        stepTimeoutMs: t('sa.set.stepTimeoutMs'),
        maxRunDurationMs: t('sa.set.maxRunDurationMs'),
        maxStepsPerTest: t('sa.set.maxStepsPerTest'),
        concurrency: t('sa.set.concurrency'),
        browser: t('sa.set.browser'),
        screenshotOnFailure: t('sa.set.screenshotOnFailure'),
        fullPage: t('sa.set.fullPage'),
        format: t('sa.set.format'),
        quality: t('sa.set.quality'),
        maxPerRun: t('sa.set.maxPerRun'),
        retentionDays: t('sa.set.retentionDays'),
        claimTimeoutMs: t('sa.set.claimTimeoutMs'),
        pollIntervalMs: t('sa.set.pollIntervalMs'),
        workerHeartbeatTimeoutMs: t('sa.set.workerHeartbeatTimeoutMs'),
        enabled: t('sa.set.assuranceEnabled'),
        notify: t('sa.set.assuranceNotify'),
        watchCertificates: t('sa.set.watchCertificates'),
        watchTests: t('sa.set.watchTests'),
        sweepIntervalMs: t('sa.set.sweepIntervalMs'),
        certificateCheckIntervalMinutes: t('sa.set.certificateCheckIntervalMinutes'),
        certificateWarnDays: t('sa.set.certificateWarnDays'),
        certificateCriticalDays: t('sa.set.certificateCriticalDays'),
        certificateTimeoutMs: t('sa.set.certificateTimeoutMs'),
        failureStreak: t('sa.set.failureStreak'),
        incidentRetentionDays: t('sa.set.incidentRetentionDays'),
      };
      // An unlabelled field still renders — with its raw name, which is the
      // visible signal that a label is missing.
      return labels[key] || key;
    }

    function settingSection(name) {
      var sections = {
        discovery: { title: t('sa.set.discovery'), help: t('sa.set.discoveryHelp') },
        runner: { title: t('sa.set.runner'), help: t('sa.set.runnerHelp') },
        artifacts: { title: t('sa.set.artifacts'), help: t('sa.set.artifactsHelp') },
        allowlist: { title: t('sa.set.allowlist'), help: t('sa.set.allowlistHelp') },
        queue: { title: t('sa.set.queue'), help: t('sa.set.queueHelp') },
        assurance: { title: t('sa.set.assurance'), help: t('sa.set.assuranceHelp') },
        recording: { title: t('sa.set.recording'), help: t('sa.set.recordingHelp') },
      };
      return sections[name] || { title: name, help: '' };
    }

    function settingsPanel(body) {
      // The worker status is fetched with the settings rather than on its own
      // tab: an admin who opens this page is usually here because something is
      // not running.
      return Promise.all([
        api(API + '/settings'),
        api(API + '/runs/worker-status').catch(function () { return null; }),
      ]).then(function (loaded) {
        var res = loaded[0];
        var worker = loaded[1];
        var order = ['assurance', 'recording', 'discovery', 'runner', 'artifacts', 'allowlist', 'queue'];
        var sections = order.filter(function (k) { return res.settings[k]; });

        var panels = sections.map(function (name) {
          var values = res.settings[name];
          var inputs = {};
          var errors = el('div', { class: 'sa-form-errors' });

          var fields = Object.keys(values).map(function (key) {
            var value = values[key];
            var input;
            if (typeof value === 'boolean') {
              input = el('input', { type: 'checkbox' });
              input.checked = value;
            } else if (typeof value === 'number') {
              input = el('input', { type: 'number', value: String(value) });
            } else {
              input = el('input', { type: 'text', value: String(value) });
              // An empty address means "work it out from the request", which is
              // a real setting and not a missing one — the placeholder says so.
              if (key === 'publicUrl') input.placeholder = t('sa.set.publicUrlPlaceholder');
            }
            input.disabled = !isAdmin();
            inputs[key] = input;

            // Units belong beside the number, not buried in the field name.
            var unit = key === 'publicUrl' ? t('sa.set.publicUrlHelp')
              : (/Ms$/.test(key) ? t('sa.set.unitMs')
                : (/Days$/.test(key) ? t('sa.set.unitDays')
                  : (/Minutes$/.test(key) ? t('sa.set.unitMinutes') : null)));
            return field(settingLabel(key), input, unit);
          });

          return el('div', { class: 'sa-panel' },
            section(settingSection(name).title, isAdmin() ? [
              el('button', {
                class: 'primary',
                onclick: function () {
                  var patch = {};
                  Object.keys(inputs).forEach(function (key) {
                    var input = inputs[key];
                    patch[key] = input.type === 'checkbox' ? input.checked
                      : (input.type === 'number' ? Number(input.value) : input.value);
                  });
                  mount(errors);
                  api(API + '/settings/' + name, { method: 'PUT', body: patch })
                    .then(function () { toast(t('sa.settings.saved')); })
                    .catch(function (e) { showErrors(errors, e); });
                },
              }, t('sa.save')),
              el('button', {
                class: 'ghost small',
                onclick: function () {
                  api(API + '/settings/' + name + '/reset', { method: 'POST', body: {} })
                    .then(function () { toast(t('sa.settings.saved')); settingsPanel(body); })
                    .catch(function (e) { toast(err(e), true); });
                },
              }, t('sa.settings.reset')),
            ] : null),
            el('p', { class: 'sa-help' }, settingSection(name).help),
            el('div', { class: 'sa-fields' }, ...fields), errors);
        });

        mount(body,
          el('p', { class: 'sa-help' }, t('sa.settings.help')),
          isAdmin() ? null : el('p', { class: 'sa-help' }, t('sa.set.readOnly')),
          workerPanel(worker),
          ...panels);
        return body;
      });
    }

    // --------------------------------------------------------------- modal
    // `onSave` null means there is nothing to save, and the dialog says so by
    // NOT having the button: an enabled button that only produces an error when
    // pressed tells the operator they did something wrong, when the truth is
    // that there was never anything there to press it for.
    function modal(title, content, onSave, saveLabel) {
      var overlay = el('div', { class: 'sa-modal-overlay' });
      function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
      function onKey(e) { if (e.key === 'Escape') close(); }
      document.addEventListener('keydown', onKey);

      var save = onSave ? el('button', { class: 'primary', onclick: function () {
        save.disabled = true;
        Promise.resolve(onSave()).then(close).catch(function () { save.disabled = false; });
      } }, saveLabel || t('sa.save')) : null;

      overlay.append(el('div', { class: 'sa-modal' },
        el('div', { class: 'sa-modal-head' }, el('h3', {}, title),
          el('button', { class: 'ghost small', onclick: close }, '×')),
        el('div', { class: 'sa-modal-body' }, content),
        el('div', { class: 'sa-modal-foot' },
          // With no save there is nothing to cancel — the only thing left to do
          // is close the dialog, so the button says that instead.
          el('button', { class: 'ghost', onclick: close }, save ? t('sa.cancel') : t('sa.close')), save)));
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
      document.body.append(overlay);
      return overlay;
    }

    // Renders a server 400 into the form, field by field, so an operator is told
    // which box is wrong rather than being handed a JSON blob.
    // A 400 from this API carries { error, details } — one message per field.
    // app.js's api() attaches the parsed body as `e.data`, so that is where the
    // details live; the other shapes are fallbacks for a standalone host with a
    // different client. Reading only the fallbacks is how a form came to show a
    // bare "Validation failed" while the server had said exactly what was wrong.
    function showErrors(node, e) {
      var details = (e && e.data && e.data.details)
        || (e && e.details)
        || (e && e.body && e.body.details)
        || null;
      if (details && typeof details === 'object') {
        mount(node, ...Object.keys(details).map(function (key) {
          return el('div', { class: 'sa-form-error' }, el('strong', {}, key + ': '), String(details[key]));
        }));
        return;
      }
      mount(node, el('div', { class: 'sa-form-error' }, err(e)));
    }

    // Administration → Settings mounts ONLY the settings panel. Drawing the
    // module's shell there would fetch applications nobody asked for and show a
    // tab bar inside another screen's tab bar.
    if (ctx.mode === 'settings') {
      settingsPanel(host);
      return host;
    }

    draw();
    return host;
  }

  // Administration → Settings → Service Assurance. The settings are system-wide,
  // so the shared Settings screen mounts them rather than this module's tab bar.
  function settingsPanelEntry(ctx) {
    return create({
      el: ctx.el, api: ctx.api, t: ctx.t, toast: ctx.toast,
      isAdmin: ctx.isAdmin, isOperator: ctx.isAdmin,
      mode: 'settings',
    });
  }

  root.ServiceAssurance = { create: create, settingsPanel: settingsPanelEntry };
}(typeof window !== 'undefined' ? window : this));
