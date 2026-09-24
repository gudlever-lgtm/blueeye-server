// public/views/changes.js — Changes, as a ListPage (template A).
//
// The landing screen: what has changed since you last looked. Built from the
// contract's components (public/ui.js, docs/ui-contract.md) — this is the first
// screen phase 3 migrated, and the shape every other one follows.
//
// What it keeps from the screen it replaces: the window vocabulary the server
// accepts, the reference marker that moves ONLY on an explicit "Mark as seen"
// (never on a load — a marker that advanced on read would mean the page could
// never show anybody anything after the first visit), the CSV export, and every
// deep link into the record a row is about.
//
// What changed: the severity grouping became a StatStrip filter plus a column,
// and each row's explanation moved into the Drawer, where it is shown once per
// row on demand rather than repeated down the page.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var api = deps.api;
    var t = deps.t;
    var errText = deps.errText;
    var openAgent = deps.openAgent;
    var ui = deps.ui;

    var SEV_TONE = { CRIT: 'crit', WARN: 'warn', INFO: 'info' };
    var SEV_ORDER = { CRIT: 3, WARN: 2, INFO: 1 };
    // A key built from data is resolved through a variable, never concatenated
    // inside the translate call: the gate sweeps the source for literal keys,
    // and a concatenation reads to it as a truncated key it cannot verify.
    function severityLabel(sev) { var k = 'changes.group.' + sev; var v = t(k); return v === k ? String(sev) : v; }
    function kindLabel(kind) { var k = 'changes.kind.' + kind; var v = t(k); return v === k ? String(kind || '\u2014') : v; }

    function view() {
      var root = ui.page();
      // The window and the reference marker live in app.js: they outlive this
      // view, because a window the user chose must survive leaving the page and
      // the marker moves only on an explicit "Mark as seen".
      // The filters live in app.js too (deps.filterState): created here they
      // were reset by every rebuild, so a refresh threw away what the reader
      // had narrowed the list to.
      var state = deps.filterState ? deps.filterState() : {};
      if (state.status == null) {
        // Acknowledged rows are hidden by default: acknowledging is how a
        // reader says "I have dealt with this one", so it leaves the list.
        state.status = 'open';
        state.severity = '';
        state.host = '';
        state.sort = { key: 'time', dir: 'desc' };
      }
      var names = {};
      var body = el('div', {});
      var stripHost = el('div', {});

      var markSeen = ui.button('primary', t('changes.markSeen'), {
        onclick: function () {
          markSeen.disabled = true;
          api('/api/changes/seen', { method: 'POST', body: {} })
            .then(function () {
              ui.toast(t('changes.marked'), t('changes.markedDetail'));
              deps.setWindow(deps.LAST_SEEN);
              return load();
            })
            .catch(function (e) { ui.toast(t('changes.title'), errText(e), { bad: true }); })
            .then(function () { markSeen.disabled = false; });
        },
      });

      root.append(ui.pageHeader({
        title: t('changes.title'),
        lead: t('changes.subtitle'),
        help: {
          title: t('changes.help.title'),
          body: function () {
            return [
              el('p', {}, t('changes.help.p1')),
              el('p', {}, t('changes.help.p2')),
              el('p', {}, t('changes.help.p3')),
              el('p', {}, t('changes.help.p4')),
            ];
          },
        },
        // One primary. "Fleet grid" is a way out of the page, so it is secondary.
        actions: [
          ui.button('secondary', t('changes.fleetLink'), { onclick: function () { deps.gotoView('fleet'); } }),
          markSeen,
        ],
      }), stripHost, body);

      function toolbar(onChange) {
        return ui.toolbar({
          filters: [
            ui.filter(t('changes.window'), ui.select({
              label: t('changes.window'), value: deps.getWindow(), options: deps.WINDOWS,
              onchange: function (e) { deps.setWindow(e.target.value); load(); },
            })),
            ui.filter(t('changes.filter.severity'), ui.select({
              label: t('changes.filter.severity'), value: state.severity,
              options: [['', t('changes.filter.all')], ['CRIT', t('changes.group.CRIT')],
                ['WARN', t('changes.group.WARN')], ['INFO', t('changes.group.INFO')]],
              onchange: function (e) { state.severity = e.target.value; onChange(); },
            })),
            ui.filter(t('changes.filter.status'), ui.select({
              label: t('changes.filter.status'), value: state.status,
              options: [['open', t('changes.status.open')], ['acked', t('changes.status.acked')], ['all', t('changes.status.all')]],
              onchange: function (e) { state.status = e.target.value; onChange(); },
            })),
            ui.filter(t('changes.filter.host'), el('input', {
              type: 'search', value: state.host, placeholder: t('changes.filter.hostPlaceholder'),
              'aria-label': t('changes.filter.host'), size: '16',
              oninput: function (e) { state.host = e.target.value; onChange(); },
            })),
          ],
          actions: [
            ui.button('secondary', t('changes.export'), { onclick: deps.exportCsv }),
          ],
        });
      }

      // Acknowledge / undo, for the caller's own view only (POST/DELETE
      // /api/changes/ack). The row is updated in place and the list redrawn, so
      // with "Not acknowledged" selected it leaves the list straight away.
      function setAck(ev, on) {
        var req = on
          ? api('/api/changes/ack', { method: 'POST', body: { key: ev.ackKey } })
          : api('/api/changes/ack/' + encodeURIComponent(ev.ackKey), { method: 'DELETE' });
        return req
          .then(function (res) {
            ev.acknowledgedAt = on ? ((res && res.acknowledgedAt) || new Date().toISOString()) : null;
            ui.closeDrawer();
            ui.toast(on ? t('changes.act.acked') : t('changes.act.unacked'), ev.summary);
            draw();
          })
          .catch(function (e) { ui.toast(t('changes.title'), errText(e), { bad: true }); });
      }

      function hostName(id) { return names[id] || (t('changes.agentN', { id: id })); }

      // The record a row is about, when it has a page of its own: an event
      // opens the event, a situation the situation. Without this the row only
      // led to the host, and the event had to be found again in its own list.
      function recordAction(ev) {
        var id = ev.refId != null ? ev.refId : ev.ref_id;
        if (id == null) return null;
        if (ev.kind === 'event' && deps.openEvent) {
          return { label: t('changes.act.event'), onclick: function () { ui.closeDrawer(); deps.openEvent(Number(id)); } };
        }
        if (ev.kind === 'cluster' && deps.openCluster) {
          return { label: t('changes.act.situation'), onclick: function () { ui.closeDrawer(); deps.openCluster(Number(id)); } };
        }
        return null;
      }

      function openRowDrawer(ev, tr) {
        var tone = SEV_TONE[ev.severity] || 'info';
        var indicationKey = 'changes.indicates.' + ev.family;
        var indication = ev.family ? t(indicationKey) : '';
        var sections = [
          ui.drawerSection(t('changes.drawer.what'), el('p', {}, ev.summary)),
          indication && indication !== indicationKey
            ? ui.drawerSection(t('changes.drawer.why'), el('p', {}, indication)) : null,
          ui.drawerSection(t('changes.drawer.detail'), ui.keyValues([
            [t('changes.drawer.source'), ev.source || '—'],
            [t('changes.drawer.type'), ev.type || '—'],
            [t('changes.drawer.metric'), ev.metric || '—'],
            [t('changes.drawer.host'), ev.agentId == null ? '—' : hostName(ev.agentId)],
          ])),
          ui.drawerSection(t('changes.drawer.history'), ui.history([
            [ui.fmt.short(ev.firstAt || ev.timestamp), t('changes.drawer.first')],
            [ui.fmt.short(ev.timestamp), t('changes.drawer.last')],
            [null, t('changes.drawer.seen', { count: Number(ev.count) || 1 })],
          ].concat(ev.acknowledgedAt ? [[ui.fmt.short(ev.acknowledgedAt), t('changes.drawer.acked')]] : []))),
        ];
        ui.openDrawer({
          title: ev.summary,
          status: ui.badge(tone, severityLabel(ev.severity)),
          meta: ui.fmt.abs(ev.timestamp),
          row: tr,
          sections: sections.filter(Boolean),
          footer: ui.drawerFooter([
            ev.ackKey ? ui.button('secondary', ev.acknowledgedAt ? t('changes.act.unack') : t('changes.act.ack'), {
              onclick: function () { setAck(ev, !ev.acknowledgedAt); },
            }) : null,
          ].filter(Boolean), [
            recordAction(ev) ? ui.button('primary', recordAction(ev).label, { onclick: recordAction(ev).onclick }) : null,
            ev.agentId == null ? null : ui.button(recordAction(ev) ? 'secondary' : 'primary', t('changes.drawer.openHost'), {
              onclick: function () { ui.closeDrawer(); openAgent(Number(ev.agentId)); },
            }),
          ].filter(Boolean)),
        });
      }

      function table(events) {
        var rows = events.map(function (ev) {
          var count = Number(ev.count) || 1;
          return {
            ev: ev,
            cells: {
              time: ui.fmt.short(ev.timestamp),
              severity: ui.badge(SEV_TONE[ev.severity] || 'info', String(ev.severity || '')),
              type: ui.meta(kindLabel(ev.kind)),
              title: ev.acknowledgedAt
                ? el('span', {}, ev.summary, ' ', ui.badge('neutral', t('changes.status.acked')))
                : ev.summary,
              // Host is a link in its own column, never a chip on the title.
              host: ev.agentId == null ? ui.meta('—')
                : ui.hostLink(hostName(ev.agentId), function () { openAgent(Number(ev.agentId)); }),
              // Metadata as muted text, not a chip.
              count: ui.meta(count > 1 ? count + '×' : '—'),
              actions: ui.rowActions(
                ev.ackKey ? {
                  label: ev.acknowledgedAt ? t('changes.act.unack') : t('changes.act.ack'),
                  onclick: function () { setAck(ev, !ev.acknowledgedAt); },
                } : null,
                [
                  { label: t('changes.act.open'), onclick: function () { openRowDrawer(ev, null); } },
                  recordAction(ev),
                  ev.agentId == null ? null : { label: t('changes.act.host'), onclick: function () { openAgent(Number(ev.agentId)); } },
                ].filter(Boolean)),
            },
          };
        });
        return ui.dataTable({
          columns: [
            { key: 'time', label: t('changes.col.time'), width: '136px', sortable: true, time: true },
            { key: 'severity', label: t('changes.col.severity'), width: '108px', sortable: true },
            { key: 'type', label: t('changes.col.type'), width: '150px', sortable: true },
            { key: 'title', label: t('changes.col.title'), sortable: true },
            { key: 'host', label: t('changes.col.host'), width: '172px', sortable: true },
            { key: 'count', label: t('changes.col.count'), width: '122px', sortable: true, num: true },
            // Wide enough for the hover primary ("Acknowledge") PLUS the ⋯, or
            // the button spills over the Repeats column next to it.
            { key: 'actions', label: '', width: '156px' },
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

      // The rows the status selector lets through. The stat strip counts these,
      // so acknowledging a WARN takes it off the WARN card too.
      function byStatus() {
        return (data.events || []).filter(function (ev) {
          if (state.status === 'open') return !ev.acknowledgedAt;
          if (state.status === 'acked') return !!ev.acknowledgedAt;
          return true;
        });
      }

      function visible() {
        var out = byStatus().filter(function (ev) {
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
        var pool = byStatus();
        var ackedHidden = state.status === 'open'
          ? (data.events || []).filter(function (ev) { return ev.acknowledgedAt; }).length : 0;
        pool.forEach(function (ev) { if (counts[ev.severity] !== undefined) counts[ev.severity]++; });
        var pick = function (sev) {
          return function () { state.severity = state.severity === sev ? '' : sev; draw(); };
        };
        stripHost.replaceChildren(ui.statStrip([
          { value: counts.CRIT, label: t('changes.group.CRIT'), tone: 'crit', active: state.severity === 'CRIT', onclick: pick('CRIT') },
          { value: counts.WARN, label: t('changes.group.WARN'), tone: 'warn', active: state.severity === 'WARN', onclick: pick('WARN') },
          { value: counts.INFO, label: t('changes.group.INFO'), tone: 'info', active: state.severity === 'INFO', onclick: pick('INFO') },
          { value: pool.length, label: t('changes.total'), active: state.severity === '', onclick: function () { state.severity = ''; draw(); } },
        ]));

        var rows = visible();
        var kids = [toolbar(draw)];
        kids.push(ui.inlineNote(t('changes.since', { when: ui.fmt.abs(data.since) })
          + (data.correlated > 0 ? ' · ' + t('changes.correlated', { rows: data.total, raw: data.rawTotal }) : '')
          + (ackedHidden > 0 ? ' · ' + t('changes.ackedHidden', { n: ackedHidden }) : '')));
        // A partial result is a fact about the DATA, so it sits above the table
        // as an inline note — never a banner, never hidden behind the (?).
        if (data.partial && (data.failedSources || []).length) {
          kids.push(ui.inlineNote('⚠ ' + t('changes.partial', { sources: data.failedSources.join(', ') }), 'warn'));
        }
        kids.push(ui.panel({
          title: t('changes.panel'),
          note: t('changes.rowCount', { n: rows.length }),
          children: [
            rows.length ? table(rows) : ui.emptyState({
              title: t('changes.empty', { when: ui.fmt.abs(data.since) }),
              body: t('changes.emptyHint'),
              action: state.severity || state.host || state.status !== 'open'
                ? ui.button('secondary', t('changes.clearFilters'), {
                  onclick: function () { state.severity = ''; state.host = ''; state.status = 'open'; draw(); },
                })
                : null,
            }),
          ],
          foot: rows.length ? [
            el('span', {}, t('changes.showing', { shown: rows.length, total: pool.length })),
            el('div', { class: 'foot-right' },
              ui.button('secondary', '‹ ' + t('changes.prev'), { disabled: true }),
              ui.button('secondary', t('changes.next') + ' ›', { disabled: true })),
          ] : null,
        }));
        body.replaceChildren.apply(body, kids);
      }

      function load() {
        ui.closeDrawer();
        body.replaceChildren(ui.panel({ title: t('changes.panel'), children: [ui.loadingState(6)] }));
        stripHost.replaceChildren();
        return api(deps.feedPath())
          .then(function (d) { data = d; draw(); })
          .catch(function (e) {
            body.replaceChildren(ui.panel({
              title: t('changes.panel'),
              children: [ui.errorState({
                title: t('changes.err.title'),
                body: errText(e),
                detail: 'GET ' + deps.feedPath(),
                onRetry: load,
              })],
            }));
          });
      }

      return api('/agents')
        .catch(function () { return []; })
        .then(function (agents) {
          (agents || []).forEach(function (a) { names[a.id] = a.display_name || a.hostname || t('changes.agentN', { id: a.id }); });
          return load();
        })
        .then(function () { return root; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.ChangesView = apiObj;
})(typeof window !== 'undefined' ? window : null);
