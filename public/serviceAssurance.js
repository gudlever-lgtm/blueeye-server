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
  var TABS = ['applications', 'tests', 'runs', 'health', 'schedules'];

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

    function showSuggestions(discoveryId) {
      api(API + '/suggestions?discovery_id=' + discoveryId).then(function (list) {
        if (!list.length) { toast(t('sa.suggest.empty')); return; }
        var checks = {};
        var body = el('div', { class: 'sa-suggestions' }, ...list.map(function (s) {
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
        modal(t('sa.suggest.title'), body, function () {
          var ids = Object.keys(checks).filter(function (id) { return checks[id].checked; }).map(Number);
          if (!ids.length) return Promise.resolve();
          return api(API + '/suggestions/accept-many', { method: 'POST', body: { ids: ids } })
            .then(function (res) { toast(t('sa.suggest.create') + ': ' + res.created.length); state.tab = 'tests'; draw(); });
        }, t('sa.suggest.create'));
      }).catch(function (e) { toast(err(e), true); });
    }

    // --------------------------------------------------------------- tests
    views.tests = function (body) {
      if (state.testId) return testDetail(body, state.testId);
      return api(API + '/tests').then(function (tests) {
        var head = section(t('sa.tab.tests'), null);
        if (!tests.length) {
          mount(body, head, el('div', { class: 'sa-empty' }, t('sa.test.empty')));
          return;
        }
        var rows = tests.map(function (test) {
          return el('tr', { class: 'clickable', onclick: function () { state.testId = test.id; draw(); } },
            el('td', {}, el('strong', {}, test.name)),
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
        mount(body, head, el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, t('sa.app.name')),
            el('th', {}, t('sa.designer.title')),
            el('th', {}, t('sa.tab.runs')),
            el('th', {}, t('sa.run.successRate')),
            el('th', {}, t('sa.run.avgDuration')),
            el('th', {}, ''))),
          el('tbody', {}, ...rows)));
      });
    };

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
      ]).then(function (res) {
        var test = res[0];
        var catalogue = res[1].categories;
        var schedules = res[2];

        var head = el('div', {},
          el('button', { class: 'ghost small', onclick: function () { state.testId = null; draw(); } }, '← ' + t('sa.back')),
          section(test.name, [
            isOperator() ? el('button', { class: 'primary', onclick: function () { runTest(test); } }, t('sa.test.run')) : null,
          ]));

        mount(body, head,
          designer(test, catalogue),
          historyPanel(test),
          schedulePanel(test, schedules));
      });
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

      function addForm() {
        api(API + '/schedules/intervals').then(function (res) {
          var select = el('select', {}, ...res.intervals.map(function (i) {
            return el('option', { value: String(i.seconds) }, i.da || i.en);
          }));
          var tz = el('input', { type: 'text', value: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
          var errors = el('div', { class: 'sa-form-errors' });
          modal(t('sa.schedule.add'), el('div', {},
            field(t('sa.schedule.every'), select), field(t('sa.schedule.timezone'), tz), errors), function () {
            return api(API + '/schedules', {
              method: 'POST',
              body: { test_id: test.id, interval_sec: Number(select.value), timezone: tz.value.trim() },
            }).then(reload).catch(function (e) { showErrors(errors, e); throw e; });
          });
        });
      }

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

      mount(wrap, 
        section(t('sa.schedule.title'), isOperator() && !rows.length
          ? el('button', { class: 'ghost small', onclick: addForm }, '+ ' + t('sa.schedule.add')) : null),
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
        return el('div', { class: 'sa-segmented' }, ...[
          ['day', t('sa.chart.day')], ['week', t('sa.chart.week')],
          ['month', t('sa.chart.month')], ['year', t('sa.chart.year')],
        ].map(function (pair) {
          return el('button', {
            class: 'sa-segment' + (stateChart.period === pair[0] ? ' active' : ''),
            onclick: function () {
              // Keep the anchor date when switching segmentation: looking at
              // March and clicking Year should show the year March is in, not
              // jump back to today.
              stateChart.period = pair[0];
              load();
            },
          }, pair[1]);
        }));
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

    function runDetail(body, id) {
      return api(API + '/runs/' + id).then(function (run) {
        var head = el('div', {},
          el('button', { class: 'ghost small', onclick: function () { state.runId = null; draw(); } }, '← ' + t('sa.back')),
          section(run.test_name || t('sa.run.deletedTest'), statusChip(run.status)),
          el('p', { class: 'sa-help' }, runSubtitle(run)));

        var summary = el('div', { class: 'sa-stats' },
          stat(t('sa.run.status'), String(run.status).toUpperCase()),
          stat(t('sa.run.steps'), (run.steps || []).length),
          stat(t('sa.run.duration'), ms(run.duration_ms)));

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

        mount(body, head, summary, failure, steps);
      });
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

        mount(body, head, counts, incidentsPanel(incidents), certificatesPanel(certificates));
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
          el('td', {}, severityChip(incident.severity)),
          el('td', {}, incident.subject_label || incident.subject_key),
          el('td', {},
            el('div', {}, incident.summary || ''),
            el('div', { class: 'muted' }, incident.likely_cause ? t('sa.run.likelyCause') + ': ' + incident.likely_cause : ''),
            el('details', {},
              el('summary', {}, t('sa.technicalDetails')),
              el('pre', { class: 'sa-pre' }, (incident.evidence || []).join('\n') + (incident.explanation ? '\n\n' + incident.explanation : '')))),
          el('td', {}, when(incident.opened_at)),
          el('td', {}, String(incident.occurrences || 1)),
          el('td', {}, isOperator()
            ? el('button', { class: 'ghost small', onclick: function () { resolveIncident(incident); } }, t('sa.health.resolve'))
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
        var order = ['assurance', 'discovery', 'runner', 'artifacts', 'allowlist', 'queue'];
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
            }
            input.disabled = !isAdmin();
            inputs[key] = input;

            // Units belong beside the number, not buried in the field name.
            var unit = /Ms$/.test(key) ? t('sa.set.unitMs')
              : (/Days$/.test(key) ? t('sa.set.unitDays')
                : (/Minutes$/.test(key) ? t('sa.set.unitMinutes') : null));
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
    function modal(title, content, onSave, saveLabel) {
      var overlay = el('div', { class: 'sa-modal-overlay' });
      function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
      function onKey(e) { if (e.key === 'Escape') close(); }
      document.addEventListener('keydown', onKey);

      var save = el('button', { class: 'primary', onclick: function () {
        save.disabled = true;
        Promise.resolve(onSave()).then(close).catch(function () { save.disabled = false; });
      } }, saveLabel || t('sa.save'));

      overlay.append(el('div', { class: 'sa-modal' },
        el('div', { class: 'sa-modal-head' }, el('h3', {}, title),
          el('button', { class: 'ghost small', onclick: close }, '×')),
        el('div', { class: 'sa-modal-body' }, content),
        el('div', { class: 'sa-modal-foot' },
          el('button', { class: 'ghost', onclick: close }, t('sa.cancel')), save)));
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
