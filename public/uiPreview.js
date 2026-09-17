// public/uiPreview.js — the two UI-contract example screens.
//
// Phase 1 of the UI unification (docs/ui-contract.md): Changes rebuilt as a
// ListPage (template A) and Probes & Tests as a FormPage (template C), on
// /ui-preview/changes and /ui-preview/probes, admin only. The live screens are
// untouched — these exist so the direction can be seen and approved before the
// rest of the codebase is migrated, and they are DELETED once Changes and
// Probes move onto their real routes.
//
// Both read the real APIs (/api/changes, /agents, /api/connection-test/checks),
// so what is on screen is this server's own data.
//
// Repo convention: createX(deps). app.js passes its own helpers in rather than
// this file reaching into app.js's scope.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var api = deps.api;
    var t = deps.t;
    var toast = deps.toast;
    var errText = deps.errText;
    var fmtDate = deps.fmtDate;
    // Two timestamps, on purpose: a table column has ~110px and a full locale
    // string does not fit in it, so the row gets the short form and the Drawer
    // — which has the room and is where somebody reads it carefully — the full
    // one. Both come from app.js; neither is formatted here.
    var fmtTimeShort = deps.fmtTimeShort;
    var shortTime = function (iso) {
      var ms = Date.parse(iso);
      return isFinite(ms) ? fmtTimeShort(ms) : fmtDate(iso);
    };
    var openAgent = deps.openAgent;
    // The one tab-strip builder (app.js). It owns the keyboard and the ARIA;
    // components.css gives it the contract's underline look.
    var tabStrip = deps.tabStrip;
    var plural = deps.plural;

    // ---- shared components -------------------------------------------------

    // PageHeader. Title, one line of description, help behind (?), actions
    // right — at most one primary, which the contract enforces by convention
    // and ui:check enforces by counting.
    function pageHeader(opts) {
      var head = el('header', { class: 'page-head' });
      var title = el('h1', {}, opts.title);
      if (opts.help) title.append(helpButton(opts.help));
      head.append(el('div', {}, title, el('p', {}, opts.lead)));
      var actions = (opts.actions || []).filter(Boolean);
      if (actions.length) head.append(el('div', { class: 'page-head-actions' }, actions));
      return head;
    }

    // The (?) popover that replaced the info banner. One open at a time; Escape
    // and an outside click close it.
    var openPopover = null;
    function closePopover() {
      if (!openPopover) return;
      document.removeEventListener('keydown', onPopoverKey);
      document.removeEventListener('click', onPopoverClick, true);
      openPopover.remove();
      openPopover = null;
    }
    function onPopoverKey(e) { if (e.key === 'Escape') closePopover(); }
    function onPopoverClick(e) {
      if (openPopover && !openPopover.contains(e.target) && !e.target.closest('.help-btn')) closePopover();
    }
    function helpButton(help) {
      var btn = el('button', {
        class: 'help-btn', type: 'button', 'aria-label': help.title,
        onclick: function (e) {
          e.stopPropagation();
          if (openPopover) { closePopover(); return; }
          var pop = el('div', { class: 'ui ui-popover', role: 'dialog', 'aria-label': help.title },
            el('button', {
              class: 'btn btn-ghost btn-icon btn-xs pop-close', type: 'button',
              'aria-label': t('common.cancel'), onclick: closePopover,
            }, '✕'),
            el('h3', {}, help.title),
            help.body());
          document.body.append(pop);
          var r = btn.getBoundingClientRect();
          pop.style.top = (r.bottom + 8) + 'px';
          pop.style.left = Math.max(8, r.left - 8) + 'px';
          openPopover = pop;
          document.addEventListener('keydown', onPopoverKey);
          document.addEventListener('click', onPopoverClick, true);
        },
      }, '?');
      return btn;
    }

    function statStrip(cards) {
      return el('div', { class: 'statstrip' }, cards.map(function (c) {
        return el('button', {
          class: 'stat-card' + (c.tone ? ' ' + c.tone : ''), type: 'button',
          'aria-pressed': String(!!c.active), onclick: c.onclick,
        }, el('span', { class: 'stat-n' }, String(c.value)), el('span', { class: 'stat-l' }, c.label));
      }));
    }

    function panel(opts) {
      var p = el('section', { class: 'panel-ui' });
      if (opts.title) {
        var head = el('div', { class: 'panel-head' }, el('h2', {}, opts.title));
        if (opts.note) head.append(el('span', { class: 'meta-xs' }, opts.note));
        var acts = (opts.actions || []).filter(Boolean);
        if (acts.length) head.append(el('div', { class: 'panel-actions' }, acts));
        p.append(head);
      }
      p.append.apply(p, (opts.children || []).filter(Boolean));
      return p;
    }

    function badge(tone, text) { return el('span', { class: 'badge-ui ' + tone }, text); }

    function emptyState(o) {
      return el('div', { class: 'state' },
        el('div', { class: 'state-ico' }, o.icon || '✓'),
        el('h3', {}, o.title),
        el('p', {}, o.body),
        o.action || null);
    }
    function errorState(o) {
      return el('div', { class: 'state is-error' },
        el('div', { class: 'state-ico' }, '⚠'),
        el('h3', {}, o.title),
        el('p', {}, o.body, o.detail ? [' ', el('code', {}, o.detail)] : null),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: o.onRetry }, t('common.retry')));
    }
    function loadingState(rows) {
      var host = el('div', {});
      for (var i = 0; i < (rows || 6); i++) {
        host.append(el('div', { class: 'skel-row' },
          el('div', { class: 'skel skel-a' }), el('div', { class: 'skel skel-b' }),
          el('div', { class: 'skel skel-c' }), el('div', { class: 'skel skel-d' }),
          el('div', { class: 'skel skel-e' }), el('div', { class: 'skel skel-f' })));
      }
      return host;
    }

    // Drawer: right side, 480px, title + status + close. One open at a time.
    var drawerEls = null;
    function closeDrawer() {
      if (!drawerEls) return;
      document.removeEventListener('keydown', onDrawerKey);
      drawerEls.scrim.remove();
      drawerEls.panel.remove();
      if (drawerEls.row) drawerEls.row.setAttribute('aria-selected', 'false');
      drawerEls = null;
    }
    function onDrawerKey(e) { if (e.key === 'Escape') closeDrawer(); }
    function openDrawer(o) {
      closeDrawer();
      var scrim = el('div', { class: 'ui ui-scrim', onclick: closeDrawer });
      var panelEl = el('aside', { class: 'ui ui-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
        el('div', { class: 'drawer-head' },
          el('div', { style: 'min-width:0' },
            el('h2', {}, o.title),
            el('div', { class: 'drawer-meta' }, o.status || null, o.meta ? el('span', { class: 'meta-xs' }, o.meta) : null)),
          el('button', {
            class: 'btn btn-ghost btn-icon', type: 'button',
            'aria-label': t('common.cancel'), style: 'margin-left:auto', onclick: closeDrawer,
          }, '✕')),
        el('div', { class: 'drawer-body' }, o.sections),
        o.footer || null);
      document.body.append(scrim, panelEl);
      if (o.row) o.row.setAttribute('aria-selected', 'true');
      drawerEls = { scrim: scrim, panel: panelEl, row: o.row || null };
    }
    function dsec(title, body) { return el('section', { class: 'dsec' }, el('h3', {}, title), body); }

    // Row overflow menu. One primary action stays visible on hover; the rest
    // live here, so a row never grows a stack of buttons.
    var rowMenu = null;
    function closeRowMenu() {
      if (!rowMenu) return;
      document.removeEventListener('click', onMenuClick, true);
      rowMenu.remove();
      rowMenu = null;
    }
    function onMenuClick(e) { if (rowMenu && !rowMenu.contains(e.target)) closeRowMenu(); }
    function openRowMenu(anchor, items) {
      closeRowMenu();
      var menu = el('div', { class: 'ui ui-rowmenu', role: 'menu' }, items.map(function (it) {
        if (it === '-') return el('hr', {});
        return el('button', {
          type: 'button', role: 'menuitem', class: it.danger ? 'danger' : null,
          onclick: function () { closeRowMenu(); it.onclick(); },
        }, it.label);
      }));
      document.body.append(menu);
      var r = anchor.getBoundingClientRect();
      menu.style.top = (r.bottom + 4) + 'px';
      menu.style.left = Math.max(8, r.right - menu.offsetWidth) + 'px';
      rowMenu = menu;
      setTimeout(function () { document.addEventListener('click', onMenuClick, true); }, 0);
    }

    // DataTable. A real <table>: fixed columns, sticky header, sorting in the
    // header, the row opens the Drawer.
    function dataTable(opts) {
      var sort = opts.sort;
      var table = el('table', { class: 'dt' });
      table.append(el('colgroup', {}, opts.columns.map(function (c) {
        return el('col', c.width ? { style: 'width:' + c.width } : {});
      })));
      table.append(el('thead', {}, el('tr', {}, opts.columns.map(function (c) {
        var attrs = { class: c.num ? 'col-num' : null, scope: 'col' };
        if (!c.sortable) return el('th', attrs, c.label || '');
        if (sort && sort.key === c.key) attrs['aria-sort'] = sort.dir === 'asc' ? 'ascending' : 'descending';
        attrs.onclick = function () { opts.onSort(c.key); };
        attrs.title = opts.sortHint;
        return el('th', attrs, c.label, el('span', { class: 'sort' },
          sort && sort.key === c.key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'));
      }))));
      var body = el('tbody', {});
      opts.rows.forEach(function (row) {
        var tr = el('tr', { 'aria-selected': 'false', tabindex: '0' });
        if (row.dimmed) tr.classList.add('is-dimmed');
        opts.columns.forEach(function (c) {
          tr.append(el('td', { class: c.num ? 'col-num' : (c.time ? 'col-time' : null) }, row.cells[c.key]));
        });
        if (!row.dimmed && opts.onOpen) {
          var open = function (e) {
            if (e.target.closest('button') || e.target.closest('a')) return;
            opts.onOpen(row, tr);
          };
          tr.addEventListener('click', open);
          tr.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            open(e);
          });
        }
        body.append(tr);
      });
      table.append(body);
      return el('div', { class: 'table-wrap-ui' }, table);
    }

    function rowActions(primary, menuItems) {
      return el('div', { class: 'row-act' },
        primary ? el('button', {
          class: 'btn btn-secondary btn-xs on-hover', type: 'button',
          onclick: function (e) { e.stopPropagation(); primary.onclick(); },
        }, primary.label) : null,
        el('button', {
          class: 'btn btn-ghost btn-xs btn-icon', type: 'button', 'aria-haspopup': 'menu',
          'aria-label': t('uip.rowMenu'),
          onclick: function (e) { e.stopPropagation(); openRowMenu(e.currentTarget, menuItems); },
        }, '⋯'));
    }

    // Toasts: top right, stacked, 5 s — an error stays until it is dismissed.
    function toastHost() {
      var host = document.getElementById('ui-toasts');
      if (!host) {
        host = el('div', { class: 'ui ui-toasts', id: 'ui-toasts', role: 'status', 'aria-live': 'polite' });
        document.body.append(host);
      }
      return host;
    }
    function uiToast(title, detail, bad) {
      var node = el('div', { class: 'ui-toast ' + (bad ? 'err' : 'ok') },
        el('div', { class: 'toast-tx' },
          el('div', { class: 'toast-title' }, title),
          detail ? el('div', { class: 'toast-detail' }, detail) : null),
        el('button', {
          class: 'btn btn-ghost btn-icon btn-xs', type: 'button',
          'aria-label': t('common.cancel'), onclick: function () { node.remove(); },
        }, '✕'));
      toastHost().append(node);
      if (!bad) setTimeout(function () { node.remove(); }, 5000);
      return node;
    }

    var SEV_TONE = { CRIT: 'crit', WARN: 'warn', INFO: 'info' };
    // A key built from data is resolved through a variable, never concatenated
    // inside the translate call: the gate sweeps the source for literal keys,
    // and a concatenation reads to it as a truncated key it cannot verify.
    function severityLabel(sev) { var k = 'changes.group.' + sev; var v = t(k); return v === k ? String(sev) : v; }
    function kindLabel(kind) { var k = 'changes.kind.' + kind; var v = t(k); return v === k ? String(kind || '\u2014') : v; }
    function tabLabel(key) { var k = 'route.tab.probes.' + key; var v = t(k); return v === k ? key : v; }
    var SEV_ORDER = { CRIT: 3, WARN: 2, INFO: 1 };

    // ---- Example 1 · Changes as a ListPage (template A) ---------------------

    function changesView() {
      var root = el('div', { class: 'ui ui-page' });
      var state = {
        window: '7d',
        severity: '',
        host: '',
        sort: { key: 'time', dir: 'desc' },
        forced: new URLSearchParams(window.location.search).get('state') || '',
      };
      var names = {};
      var body = el('div', {});
      var stripHost = el('div', {});

      var markSeen = el('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: function () {
          markSeen.disabled = true;
          api('/api/changes/seen', { method: 'POST', body: {} })
            .then(function () { uiToast(t('changes.marked'), t('uip.markedDetail')); return load(); })
            .catch(function (e) { uiToast(t('changes.title'), errText(e), true); })
            .then(function () { markSeen.disabled = false; });
        },
      }, t('changes.markSeen'));

      root.append(pageHeader({
        title: t('changes.title'),
        lead: t('changes.subtitle'),
        help: {
          title: t('uip.help.changes.title'),
          body: function () {
            return [
              el('p', {}, t('uip.help.changes.p1')),
              el('p', {}, t('uip.help.changes.p2')),
              el('p', {}, t('uip.help.changes.p3')),
            ];
          },
        },
        // One primary. "Fleet grid" is a way out of the page, so it is secondary.
        actions: [
          el('button', {
            class: 'btn btn-secondary', type: 'button',
            onclick: function () { deps.gotoView('fleet'); },
          }, t('changes.fleetLink')),
          markSeen,
        ],
      }), stripHost, body);

      function toolbar(onChange) {
        var win = el('select', {
          'aria-label': t('changes.window'),
          onchange: function (e) { state.window = e.target.value; load(); },
        }, ['24h', '7d', '30d'].map(function (w) {
          return el('option', Object.assign({ value: w }, w === state.window ? { selected: 'selected' } : {}), w);
        }));
        var sev = el('select', {
          'aria-label': t('uip.filter.severity'),
          onchange: function (e) { state.severity = e.target.value; onChange(); },
        }, [['', t('uip.filter.all')], ['CRIT', t('changes.group.CRIT')], ['WARN', t('changes.group.WARN')], ['INFO', t('changes.group.INFO')]]
          .map(function (o) {
            return el('option', Object.assign({ value: o[0] }, o[0] === state.severity ? { selected: 'selected' } : {}), o[1]);
          }));
        var host = el('input', {
          type: 'search', value: state.host, placeholder: t('uip.filter.hostPlaceholder'),
          'aria-label': t('uip.filter.host'), size: '16',
          oninput: function (e) { state.host = e.target.value; onChange(); },
        });
        return el('div', { class: 'toolbar-ui' },
          el('label', { class: 'field-inline' }, t('changes.window'), win),
          el('label', { class: 'field-inline' }, t('uip.filter.severity'), sev),
          el('label', { class: 'field-inline' }, t('uip.filter.host'), host),
          el('div', { class: 'toolbar-right' },
            el('button', {
              class: 'btn btn-secondary', type: 'button',
              onclick: function () { uiToast(t('uip.exportQueued'), t('uip.exportDetail')); },
            }, t('uip.export'))));
      }

      function hostName(id) { return names[id] || (t('uip.agentN', { id: id })); }

      function openRowDrawer(ev, tr) {
        var tone = SEV_TONE[ev.severity] || 'info';
        var indicationKey = 'changes.indicates.' + ev.family;
        var indication = ev.family ? t(indicationKey) : '';
        var sections = [
          dsec(t('uip.drawer.what'), el('p', {}, ev.summary)),
          indication && indication !== indicationKey
            ? dsec(t('uip.drawer.why'), el('p', {}, indication)) : null,
          dsec(t('uip.drawer.detail'), el('dl', { class: 'kv-ui' },
            el('dt', {}, t('uip.drawer.source')), el('dd', {}, ev.source || '—'),
            el('dt', {}, t('uip.drawer.type')), el('dd', {}, ev.type || '—'),
            el('dt', {}, t('uip.drawer.metric')), el('dd', {}, ev.metric || '—'),
            el('dt', {}, t('uip.drawer.host')), el('dd', {}, ev.agentId == null ? '—' : hostName(ev.agentId)))),
          dsec(t('uip.drawer.history'), el('ul', { class: 'hist' },
            el('li', {}, el('time', {}, shortTime(ev.firstAt || ev.timestamp)), el('span', {}, t('uip.drawer.first'))),
            el('li', {}, el('time', {}, shortTime(ev.timestamp)), el('span', {}, t('uip.drawer.last'))),
            el('li', {}, el('span', {}, t('uip.drawer.seen', { count: Number(ev.count) || 1 }))))),
        ];
        openDrawer({
          title: ev.summary,
          status: badge(tone, severityLabel(ev.severity)),
          meta: fmtDate(ev.timestamp),
          row: tr,
          sections: sections.filter(Boolean),
          footer: ev.agentId == null ? null : el('div', { class: 'drawer-foot' },
            el('div', { class: 'foot-right' },
              el('button', {
                class: 'btn btn-primary', type: 'button',
                onclick: function () { closeDrawer(); openAgent(Number(ev.agentId)); },
              }, t('uip.drawer.openHost')))),
        });
      }

      function table(events) {
        var rows = events.map(function (ev) {
          var count = Number(ev.count) || 1;
          return {
            ev: ev,
            cells: {
              time: shortTime(ev.timestamp),
              severity: badge(SEV_TONE[ev.severity] || 'info', String(ev.severity || '')),
              type: el('span', { class: 'meta' }, kindLabel(ev.kind)),
              title: ev.summary,
              // Host is a link in its own column, never a chip on the title.
              host: ev.agentId == null ? el('span', { class: 'meta' }, '—')
                : el('a', {
                  class: 'hostlink', href: '#',
                  onclick: function (e) { e.preventDefault(); e.stopPropagation(); openAgent(Number(ev.agentId)); },
                }, hostName(ev.agentId)),
              // Metadata as muted text, not a chip.
              count: el('span', { class: 'meta' }, count > 1 ? count + '×' : '—'),
              actions: rowActions(
                { label: t('uip.act.ack'), onclick: function () { uiToast(t('uip.act.acked'), ev.summary); } },
                [
                  { label: t('uip.act.open'), onclick: function () { openRowDrawer(ev, null); } },
                  ev.agentId == null ? null : { label: t('uip.act.host'), onclick: function () { openAgent(Number(ev.agentId)); } },
                  '-',
                  { label: t('uip.act.mute'), danger: true, onclick: function () { uiToast(t('uip.act.muted'), ev.summary); } },
                ].filter(Boolean)),
            },
          };
        });
        return dataTable({
          sortHint: t('uip.sortHint'),
          columns: [
            { key: 'time', label: t('uip.col.time'), width: '136px', sortable: true, time: true },
            { key: 'severity', label: t('uip.col.severity'), width: '108px', sortable: true },
            { key: 'type', label: t('uip.col.type'), width: '150px', sortable: true },
            { key: 'title', label: t('uip.col.title'), sortable: true },
            { key: 'host', label: t('uip.col.host'), width: '172px', sortable: true },
            { key: 'count', label: t('uip.col.count'), width: '122px', sortable: true, num: true },
            { key: 'actions', label: '', width: '104px' },
          ],
          rows: rows,
          sort: state.sort,
          onSort: function (key) {
            state.sort = state.sort.key === key
              ? { key: key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
              : { key: key, dir: 'desc' };
            draw();
          },
          onOpen: function (row, tr) { openRowDrawer(row.ev, tr); },
        });
      }

      var data = null;

      function visible() {
        var out = (data.events || []).filter(function (ev) {
          if (state.severity && ev.severity !== state.severity) return false;
          if (state.host) {
            var n = ev.agentId == null ? '' : hostName(ev.agentId);
            if (n.toLowerCase().indexOf(state.host.toLowerCase()) < 0) return false;
          }
          return true;
        });
        var dir = state.sort.dir === 'asc' ? 1 : -1;
        var key = state.sort.key;
        return out.sort(function (a, b) {
          var av, bv;
          if (key === 'severity') { av = SEV_ORDER[a.severity] || 0; bv = SEV_ORDER[b.severity] || 0; }
          else if (key === 'count') { av = Number(a.count) || 1; bv = Number(b.count) || 1; }
          else if (key === 'host') { av = a.agentId == null ? '' : hostName(a.agentId); bv = b.agentId == null ? '' : hostName(b.agentId); }
          else if (key === 'type') { av = a.kind || ''; bv = b.kind || ''; }
          else if (key === 'title') { av = a.summary || ''; bv = b.summary || ''; }
          else { av = a.timestamp || ''; bv = b.timestamp || ''; }
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        });
      }

      function draw() {
        var counts = { CRIT: 0, WARN: 0, INFO: 0 };
        (data.events || []).forEach(function (ev) { if (counts[ev.severity] !== undefined) counts[ev.severity]++; });
        var pick = function (sev) {
          return function () { state.severity = state.severity === sev ? '' : sev; draw(); };
        };
        stripHost.replaceChildren(statStrip([
          { value: counts.CRIT, label: t('changes.group.CRIT'), tone: 'crit', active: state.severity === 'CRIT', onclick: pick('CRIT') },
          { value: counts.WARN, label: t('changes.group.WARN'), tone: 'warn', active: state.severity === 'WARN', onclick: pick('WARN') },
          { value: counts.INFO, label: t('changes.group.INFO'), tone: 'info', active: state.severity === 'INFO', onclick: pick('INFO') },
          { value: (data.events || []).length, label: t('uip.total'), active: state.severity === '', onclick: function () { state.severity = ''; draw(); } },
        ]));

        var rows = visible();
        var kids = [toolbar(draw)];
        kids.push(el('p', { class: 'inline-note' }, t('changes.since', { when: fmtDate(data.since) })
          + (data.correlated > 0 ? ' · ' + t('changes.correlated', { rows: data.total, raw: data.rawTotal }) : '')));
        // A partial result is a fact about the DATA, so it sits above the table
        // as an inline note — never a banner, never hidden behind the (?).
        if (data.partial && (data.failedSources || []).length) {
          kids.push(el('p', { class: 'inline-note is-warn' }, '⚠ ' + t('changes.partial', { sources: data.failedSources.join(', ') })));
        }
        kids.push(panel({
          title: t('uip.panel.changes'),
          note: t('uip.rowCount', { n: rows.length }),
          children: [
            rows.length ? table(rows) : emptyState({
              title: t('changes.empty', { when: fmtDate(data.since) }),
              body: t('changes.emptyHint'),
              action: state.severity || state.host ? el('button', {
                class: 'btn btn-secondary', type: 'button',
                onclick: function () { state.severity = ''; state.host = ''; draw(); },
              }, t('uip.clearFilters')) : null,
            }),
            rows.length ? el('div', { class: 'panel-foot' },
              el('span', {}, t('uip.showing', { shown: rows.length, total: (data.events || []).length })),
              el('div', { class: 'foot-right' },
                el('button', { class: 'btn btn-secondary', type: 'button', disabled: 'disabled' }, '‹ ' + t('uip.prev')),
                el('button', { class: 'btn btn-secondary', type: 'button', disabled: 'disabled' }, t('uip.next') + ' ›'))) : null,
          ],
        }));
        body.replaceChildren.apply(body, kids);
      }

      function load() {
        closeDrawer();
        body.replaceChildren(panel({ title: t('uip.panel.changes'), children: [loadingState(6)] }));
        stripHost.replaceChildren();
        // The two states a live server rarely produces on demand. Reachable as
        // ?state=empty / ?state=error so both can be reviewed without waiting
        // for the server to have a bad day.
        if (state.forced === 'empty') {
          data = { since: new Date().toISOString(), events: [], total: 0, rawTotal: 0, correlated: 0 };
          draw();
          return Promise.resolve();
        }
        if (state.forced === 'error') {
          body.replaceChildren(panel({
            title: t('uip.panel.changes'),
            children: [errorState({
              title: t('uip.err.title'),
              body: t('uip.err.body'),
              detail: 'GET /api/changes?window=' + state.window,
              onRetry: function () { state.forced = ''; load(); },
            })],
          }));
          return Promise.resolve();
        }
        return api('/api/changes?window=' + encodeURIComponent(state.window))
          .then(function (d) { data = d; draw(); })
          .catch(function (e) {
            body.replaceChildren(panel({
              title: t('uip.panel.changes'),
              children: [errorState({
                title: t('uip.err.title'),
                body: errText(e),
                detail: 'GET /api/changes?window=' + state.window,
                onRetry: load,
              })],
            }));
          });
      }

      return api('/agents')
        .catch(function () { return []; })
        .then(function (agents) {
          (agents || []).forEach(function (a) { names[a.id] = a.display_name || a.hostname || t('uip.agentN', { id: a.id }); });
          return load();
        })
        .then(function () { return root; });
    }

    // ---- Example 2 · Probes & Tests as a FormPage (template C) --------------

    function probesView() {
      var root = el('div', { class: 'ui ui-page' });
      var tab = new URLSearchParams(window.location.search).get('tab') || 'connection';
      var body = el('div', {});

      root.append(pageHeader({
        title: t('uip.probes.title'),
        lead: t('uip.probes.lead'),
        help: {
          title: t('uip.probes.title'),
          body: function () {
            return [
              el('p', {}, t('uip.help.probes.p1')),
              el('p', {}, t('uip.help.probes.p2')),
              el('p', {}, t('uip.help.probes.p3')),
            ];
          },
        },
      }));
      root.append(tabStrip(
        [['run', tabLabel('run')], ['connection', tabLabel('connection')], ['packages', tabLabel('packages')]],
        {
          active: tab,
          ariaLabel: t('uip.probes.title'),
          onPick: function (key) {
            tab = key;
            var qs = key === 'connection' ? '' : ('?tab=' + key);
            try { window.history.replaceState(null, '', window.location.pathname + qs); } catch (e) { /* URL API off */ }
            render();
          },
        }));
      root.append(body);

      function notInPreview() {
        return panel({
          title: tabLabel(tab),
          children: [emptyState({
            icon: '⚑',
            title: t('uip.probes.notInPreview'),
            body: t('uip.probes.notInPreviewBody'),
          })],
        });
      }

      function checkLabel(c) {
        var checkKey = 'ct.check.' + c.id;
        var base = t(checkKey);
        if (base === checkKey) base = c.id;
        return c.port ? base + ' ' + c.port : base;
      }

      function render() {
        if (tab !== 'connection') { body.replaceChildren(notInPreview()); return Promise.resolve(); }
        body.replaceChildren(panel({ title: t('ct.title'), children: [loadingState(4)] }));
        return Promise.all([
          api('/agents').catch(function () { return []; }),
          api('/api/connection-test/checks').catch(function () { return null; }),
        ]).then(function (res) {
          var agents = res[0] || [];
          var cat = res[1];
          if (!cat) {
            body.replaceChildren(panel({
              title: t('ct.title'),
              children: [errorState({
                title: t('uip.err.title'),
                body: t('uip.err.body'),
                detail: 'GET /api/connection-test/checks',
                onRetry: render,
              })],
            }));
            return;
          }
          if (!agents.length) {
            body.replaceChildren(panel({
              title: t('ct.title'),
              children: [emptyState({ icon: '◎', title: t('ct.noAgents'), body: t('uip.probes.enrolFirst') })],
            }));
            return;
          }
          var checks = cat.checks || [];
          var rounds = 3;

          var agentSel = el('select', { id: 'uip-agent' }, agents.map(function (a) {
            return el('option', { value: String(a.id) }, a.display_name || a.hostname || t('uip.agentN', { id: a.id }));
          }));
          var targetInput = el('input', { id: 'uip-target', type: 'text', value: '', placeholder: t('ct.targetPlaceholder') });
          var targetErr = el('span', { class: 'field-error' });
          var countInput = el('input', {
            id: 'uip-count', type: 'number', min: '1', max: '20', value: String(rounds),
            // The button says how many rounds it will run, so it follows the
            // field. A Run that keeps saying "3" while the box reads 7 is the
            // kind of small lie that costs somebody a debugging session.
            oninput: function (e) {
              var n = Math.max(1, Math.min(20, Number(e.target.value) || 1));
              runBtn.textContent = t('ct.run.prefix') + ' ' + n + ' ' + plural('ct.run.suffix', n);
            },
          });

          var stopBtn = el('button', { class: 'btn btn-secondary', type: 'button', disabled: 'disabled' }, t('ct.stop'));
          var runBtn = el('button', {
            class: 'btn btn-primary', type: 'button',
            onclick: function () {
              var target = targetInput.value.trim();
              if (!target) {
                targetInput.setAttribute('aria-invalid', 'true');
                targetErr.textContent = t('uip.probes.targetRequired');
                targetInput.focus();
                return;
              }
              targetInput.removeAttribute('aria-invalid');
              targetErr.textContent = '';
              var n = Number(countInput.value) || 1;
              uiToast(t('uip.probes.queued'), t('uip.probes.queuedDetail', {
                target: target, n: n, agent: agentSel.options[agentSel.selectedIndex].text,
              }));
              uiToast(t('uip.probes.previewOnly'), t('uip.probes.previewOnlyDetail'), true);
            },
          }, t('ct.run.prefix') + ' ' + rounds + ' ' + plural('ct.run.suffix', rounds));

          var form = panel({
            title: t('ct.title'),
            children: [el('div', { class: 'panel-body' },
              el('div', { class: 'form-sec' },
                el('h3', {}, t('uip.probes.sec.where')),
                el('p', { class: 'sec-hint' }, t('uip.probes.sec.whereHint')),
                el('div', { class: 'form-grid-ui' },
                  el('div', { class: 'f' }, el('label', { for: 'uip-agent' }, t('ct.agent')), agentSel,
                    el('span', { class: 'hint' }, t('uip.probes.agentHint'))),
                  el('div', { class: 'f' }, el('label', { for: 'uip-target' }, t('ct.target')), targetInput,
                    el('span', { class: 'hint' }, t('uip.probes.targetHint')), targetErr))),
              el('div', { class: 'form-actions-ui' },
                el('span', { class: 'meta' }, t('ct.defaultOn')),
                el('div', { class: 'actions-right' },
                  el('label', { class: 'count-field', for: 'uip-count' }, t('uip.probes.rounds'), countInput),
                  el('button', { class: 'btn btn-secondary', type: 'button' }, t('ct.repeat')),
                  stopBtn,
                  runBtn)))],
          });

          // The catalogue as the server serves it: a check the agent cannot run
          // is dimmed with the reason, from the start, rather than hidden.
          var rows = checks.map(function (c) {
            var supported = c.available !== false;
            var applies = c.applies !== false;
            var tone = supported && applies ? 'ok' : 'neutral';
            var label = supported ? (applies ? t('ct.state.ok') : t('ct.reason.notApplicable')) : t('ct.reason.notSupported');
            var descKey = 'ct.check.' + c.id + '.desc';
            var desc = t(descKey);
            if (desc === descKey) desc = '';
            var reason = supported
              ? (applies ? desc : t('ct.why.notApplicable'))
              : t('ct.why.notSupported');
            return {
              dimmed: !(supported && applies),
              cells: {
                check: checkLabel(c),
                status: badge(tone, label.toUpperCase()),
                result: el('span', { class: 'meta' }, reason),
                duration: el('span', { class: 'meta' }, '—'),
              },
            };
          });

          var runnable = rows.filter(function (r) { return !r.dimmed; }).length;
          var results = panel({
            title: t('uip.probes.resultTitle'),
            note: t('ct.resultsNote'),
            children: [
              dataTable({
                sortHint: t('uip.sortHint'),
                columns: [
                  { key: 'check', label: t('uip.probes.col.check'), width: '210px', sortable: true },
                  { key: 'status', label: t('uip.probes.col.status'), width: '150px', sortable: true },
                  { key: 'result', label: t('uip.probes.col.result') },
                  { key: 'duration', label: t('uip.probes.col.duration'), width: '120px', num: true, sortable: true },
                ],
                rows: rows,
                sort: null,
                onSort: function () { /* the catalogue has one honest order: the server's */ },
              }),
              el('div', { class: 'panel-foot' },
                el('span', {}, t('uip.probes.summary', { total: rows.length, runnable: runnable, blocked: rows.length - runnable }))),
            ],
          });

          body.replaceChildren(form, results);
        });
      }

      return render().then(function () { return root; });
    }

    return {
      changes: changesView,
      probes: probesView,
      closeOverlays: function () { closeDrawer(); closePopover(); closeRowMenu(); },
    };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.UiPreview = apiObj;
})(typeof window !== 'undefined' ? window : null);
