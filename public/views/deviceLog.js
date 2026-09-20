// public/views/deviceLog.js — the device log, as a ListPage (template B).
//
// What the network equipment itself said, newest first. Until this screen the
// dashboard could show that something broke; the device had been saying WHY the
// whole time and nobody was listening.
//
// Three decisions shape the screen:
//
//   * THE SEVERITY CHIPS ARE THE PRIMARY CONTROL. A fleet of switches emits
//     thousands of notice-level lines an hour, every one of them true. Getting
//     from that to the six lines that matter is the entire job, so the counts
//     sit at the top as a StatStrip and clicking one IS the filter. They count
//     what they are HIDING, which is what makes them worth reading.
//
//   * THE CLOCK SKEW IS ON THE ROW, not buried in a detail pane. A switch whose
//     clock is three seconds behind quietly ruins every correlation built on
//     its timestamps, and an operator reading the log has no other way to know.
//
//   * A ROW OPENS A DRAWER, not a new page. Reading one line's raw text must
//     not cost the place in the list somebody has just filtered their way to.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    // Syslog severity → badge tone. LOWER IS WORSE, which is the single most
    // confusing thing about syslog; the whole screen is built to make that
    // invisible to the reader rather than something they must remember.
    var SEV_TONE = ['crit', 'crit', 'crit', 'crit', 'warn', 'neutral', 'neutral', 'neutral'];

    // The windows worth offering. Anything longer belongs in a report.
    var WINDOWS = [15, 60, 120, 480, 1440, 4320, 10080];

    function sevTone(n) { return SEV_TONE[n] || 'neutral'; }

    function fmtTime(iso) {
      if (!iso) return '–';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '–';
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // A clock difference worth naming. Under a second is noise; past that it is
    // a real correlation hazard and the sign matters (ahead vs behind).
    function skewNote(ms) {
      if (ms == null || Math.abs(ms) < 1000) return null;
      var secs = Math.round(Math.abs(ms) / 1000);
      return ms > 0 ? t('devlog.skew.behind', { s: secs }) : t('devlog.skew.ahead', { s: secs });
    }

    function view() {
      var st = deps.state;
      if (st.minutes == null) st.minutes = 120;
      if (st.maxSeverity === undefined) st.maxSeverity = null;

      var page = ui.page();
      var chipHost = el('div', {});
      var listHost = el('div', {});
      var statusHost = el('span', { class: 'meta-xs' });

      var info = deps.help();
      page.append(ui.pageHeader({
        title: t('devlog.title'),
        lead: info.lead,
        help: { title: info.title, body: info.body },
      }));

      // ---- controls ---------------------------------------------------------
      var windowSel = ui.select({
        id: 'devlog-window',
        label: t('devlog.filter.window'),
        value: String(st.minutes),
        options: WINDOWS.map(function (m) { return [String(m), t('devlog.window.' + m)]; }),
        onchange: function (e) { st.minutes = Number(e.target.value); refresh(); },
      });

      var typeSel = ui.select({
        id: 'devlog-type',
        label: t('devlog.filter.type'),
        value: st.eventType || '',
        options: [['', t('devlog.type.any')]],
        onchange: function (e) { st.eventType = e.target.value || null; refresh(); },
      });

      var transportSel = ui.select({
        id: 'devlog-transport',
        label: t('devlog.filter.transport'),
        value: st.transport || '',
        options: [
          ['', t('devlog.transport.any')],
          ['syslog', t('devlog.transport.syslog')],
          ['trap', t('devlog.transport.trap')],
        ],
        onchange: function (e) { st.transport = e.target.value || null; refresh(); },
      });

      var searchIn = el('input', {
        id: 'devlog-q', type: 'search', maxlength: '128',
        placeholder: t('devlog.filter.search.placeholder'),
        'aria-label': t('devlog.filter.search'),
        onkeydown: function (e) {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          st.q = e.target.value.trim() || null;
          refresh();
        },
      });
      searchIn.value = st.q || '';

      page.append(ui.toolbar({
        filters: [
          ui.filter(t('devlog.filter.window'), windowSel),
          ui.filter(t('devlog.filter.type'), typeSel),
          ui.filter(t('devlog.filter.transport'), transportSel),
          ui.filter(t('devlog.filter.search'), searchIn),
        ],
        actions: [
          statusHost,
          ui.button('secondary', t('devlog.refresh'), { onclick: function () { refresh(); } }),
        ],
      }), chipHost, listHost);

      // ---- the severity chips ----------------------------------------------
      //
      // Clicking a chip sets maxSeverity to THAT level, which in syslog terms
      // means "this and everything worse" — the thing an operator actually
      // wants. Clicking the active one clears the filter.
      function drawChips(counts) {
        var byLevel = {};
        (counts || []).forEach(function (c) { byLevel[c.severity] = c; });

        // Only the bands worth a chip. Eight buttons for eight syslog levels
        // would be a faithful rendering of the protocol and a bad control.
        var bands = [
          { max: 3, label: t('devlog.band.critical'), tone: 'crit', levels: [0, 1, 2, 3] },
          { max: 4, label: t('devlog.band.warning'), tone: 'warn', levels: [4] },
          { max: 7, label: t('devlog.band.info'), tone: '', levels: [5, 6, 7] },
        ];

        var cards = bands.map(function (b) {
          var rows = b.levels.reduce(function (n, lv) {
            return n + (byLevel[lv] ? byLevel[lv].rows : 0);
          }, 0);
          return {
            value: rows,
            label: b.label,
            tone: b.tone,
            active: st.maxSeverity === b.max,
            title: t('devlog.band.hint'),
            onclick: function () {
              st.maxSeverity = st.maxSeverity === b.max ? null : b.max;
              refresh();
            },
          };
        });
        chipHost.replaceChildren(ui.statStrip(cards));
      }

      // ---- the drawer -------------------------------------------------------
      function openRow(e) {
        var skew = skewNote(e.clockSkewMs);
        ui.openDrawer({
          title: e.summary,
          status: ui.badge(sevTone(e.severity), e.severityName),
          meta: (e.deviceName || e.deviceHostname || e.sourceIp) + ' · ' + fmtTime(e.receivedAt),
          sections: [
            ui.drawerSection(t('devlog.drawer.what'), ui.keyValues([
              [t('devlog.field.type'), e.typeLabel || e.eventType],
              e.ifname ? [t('devlog.field.iface'), e.ifname] : null,
              e.tag ? [t('devlog.field.tag'), e.tag] : null,
              [t('devlog.field.severity'), e.severityName + ' (' + e.severity + ')'],
              e.occurrences > 1 ? [t('devlog.field.occurrences'), String(e.occurrences)] : null,
            ])),
            ui.drawerSection(t('devlog.drawer.who'), ui.keyValues([
              [t('devlog.field.sender'), e.sourceIp],
              e.deviceName ? [t('devlog.field.device'), e.deviceName] : null,
              e.deviceHostname ? [t('devlog.field.selfName'), e.deviceHostname] : null,
              [t('devlog.field.receivedBy'), e.agentName || ('#' + e.agentId)],
              // An unresolved sender is stated, not left as a gap. The row was
              // kept precisely because an incomplete inventory is what an
              // outage produces.
              e.deviceId == null ? [t('devlog.field.device'), t('devlog.unresolved')] : null,
            ])),
            ui.drawerSection(t('devlog.drawer.when'), ui.keyValues([
              [t('devlog.field.received'), new Date(e.receivedAt).toLocaleString()],
              [t('devlog.field.deviceTime'), e.deviceTime ? new Date(e.deviceTime).toLocaleString() : t('devlog.noDeviceTime')],
              skew ? [t('devlog.field.skew'), skew] : null,
            ])),
            e.raw ? ui.drawerSection(t('devlog.drawer.raw'),
              el('pre', { class: 'devlog-raw' }, e.raw)) : null,
          ].filter(Boolean),
          // The one action worth offering from here: everything this device
          // said around the same moment.
          footer: e.deviceId != null ? ui.drawerFooter([
            ui.button('secondary', t('devlog.action.timeline'), {
              onclick: function () {
                ui.closeDrawer();
                deps.openTimeline(e.deviceId);
              },
            }),
          ]) : null,
        });
      }

      // ---- the list ---------------------------------------------------------
      function drawList(data) {
        var events = data.events || [];
        if (!events.length) {
          listHost.replaceChildren(ui.emptyState({
            kind: 'nodata',
            title: t('devlog.empty.title'),
            body: t('devlog.empty.body'),
          }));
          return;
        }

        listHost.replaceChildren(ui.panel({
          children: [ui.dataTable({
            dense: true,
            columns: [
              { key: 'time', label: t('devlog.col.time'), width: '92px', time: true },
              { key: 'sev', label: t('devlog.col.severity'), width: '96px' },
              { key: 'device', label: t('devlog.col.device'), width: '170px' },
              { key: 'message', label: t('devlog.col.message') },
              { key: 'iface', label: t('devlog.col.iface'), width: '130px' },
            ],
            rows: events.map(function (e) {
              var skew = skewNote(e.clockSkewMs);
              return {
                cells: {
                  time: el('span', { title: new Date(e.receivedAt).toLocaleString() }, fmtTime(e.receivedAt)),
                  sev: ui.badge(sevTone(e.severity), e.severityName),
                  device: el('span', {},
                    e.deviceName || e.deviceHostname || e.sourceIp,
                    // A sender nobody could resolve says so quietly rather than
                    // looking like a device the inventory knows.
                    e.deviceId == null ? ui.metaXs(' ' + t('devlog.unresolvedShort')) : null),
                  message: el('span', {},
                    e.summary,
                    e.occurrences > 1 ? ui.metaXs(' ×' + e.occurrences) : null,
                    skew ? ui.metaXs(' · ' + skew) : null),
                  iface: e.ifname ? el('code', {}, e.ifname) : el('span', { class: 'meta-xs' }, '–'),
                },
                raw: e,
              };
            }),
            onOpen: function (row) { openRow(row.raw); },
          })],
          foot: data.hasMore ? ui.metaXs(t('devlog.more', { n: events.length })) : null,
        }));
      }

      // ---- fetch ------------------------------------------------------------
      function refresh() {
        statusHost.textContent = t('devlog.loading');
        return deps.fetchEvents({
          minutes: st.minutes,
          maxSeverity: st.maxSeverity,
          eventType: st.eventType,
          transport: st.transport,
          q: st.q,
        }).then(function (data) {
          statusHost.textContent = t('devlog.count', { n: (data.events || []).length });
          drawChips(data.counts);
          drawList(data);
        }).catch(function (err) {
          statusHost.textContent = '';
          chipHost.replaceChildren();
          listHost.replaceChildren(ui.errorState({
            title: t('devlog.err.title'),
            body: t('devlog.err.body'),
            detail: deps.errText ? deps.errText(err) : String(err && err.message),
            onRetry: function () { refresh(); },
          }));
        });
      }

      // The type filter's options come from the SERVER's catalogue, so the list
      // and the stored data can never drift apart. A catalogue that does not
      // load costs the dropdown, never the log.
      deps.fetchCatalog().then(function (cat) {
        var opts = [['', t('devlog.type.any')]];
        (cat.groups || []).forEach(function (g) {
          (g.types || []).forEach(function (ty) { opts.push([ty.type, ty.label]); });
        });
        var current = typeSel.value;
        typeSel.replaceChildren();
        opts.forEach(function (o) {
          var attrs = { value: o[0] };
          if (o[0] === current) attrs.selected = 'selected';
          typeSel.append(el('option', attrs, o[1]));
        });
      }).catch(function () { /* the dropdown stays as "any type" */ });

      return refresh().then(function () { return page; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.DeviceLogView = apiObj;
})(typeof window !== 'undefined' ? window : null);
