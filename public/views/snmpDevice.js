// public/views/snmpDevice.js — one polled switch, as a RecordPage (template D).
//
// The screen the whole SNMP effort was building towards. Everything before it
// answered a question ABOUT the network from somewhere else; this is the first
// page that is a piece of network equipment.
//
// Three decisions shape it:
//
//   * THE PORT TABLE IS THE PAGE. A switch is its ports. The identity of a row
//     is the port NAME, not its ifIndex — a reboot or a new module renumbers
//     the indexes, and a table keyed on them silently shows one port's history
//     under another's name.
//
//   * A PORT THAT CANNOT ANSWER SAYS SO. "fdb not supported", "no speed
//     reported", "no counters yet" — each is a different answer from zero, and
//     the whole SNMP feature has been built on that distinction. A screen that
//     printed 0 for all three would undo it in one line of markup.
//
//   * THE CHART IS OPENED, NOT SHOWN. Forty-eight sparklines is a wall nobody
//     reads. One port's series, on demand, under the row that asked for it.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    // Windows worth charting. Longer than a day belongs in a report, and
    // shorter than an hour is fewer points than the chart has pixels.
    var WINDOWS = [60, 240, 1440];

    function fmtBps(v) {
      if (v == null) return '–';
      if (v >= 1e9) return (v / 1e9).toFixed(2) + ' Gbit/s';
      if (v >= 1e6) return (v / 1e6).toFixed(1) + ' Mbit/s';
      if (v >= 1e3) return (v / 1e3).toFixed(1) + ' kbit/s';
      return Math.round(v) + ' bit/s';
    }

    // A rate that is ABSENT reads as a dash; a rate that is ZERO reads as 0.
    // This is the same distinction the storage layer keeps, and the screen is
    // the last place it can be thrown away.
    function fmtRate(v, unit) {
      if (v == null) return '–';
      return (v < 1 && v > 0 ? v.toFixed(2) : String(Math.round(v * 100) / 100)) + (unit ? ' ' + unit : '');
    }

    function fmtPct(v) {
      if (v == null) return '–';
      return (Math.round(v * 100) / 100) + ' %';
    }

    // Oper/admin status as a badge. The two answer different questions —
    // somebody turned this port off, versus this port fell over — so a port
    // that is admin-down is never shown as a fault.
    function statusBadge(port) {
      if (port.adminStatus === 'down') return ui.badge('neutral', t('snmpdev.status.adminDown'));
      if (port.operStatus === 'up') return ui.badge('ok', t('snmpdev.status.up'));
      if (port.operStatus == null) return ui.badge('neutral', t('snmpdev.status.unknown'));
      return ui.badge('crit', t('snmpdev.status.down'));
    }

    // An error rate worth colouring. Errors and discards are not a scale where
    // more is worse by degrees: on a healthy port they are ZERO, so anything
    // above zero is the finding.
    function errorTone(v) {
      if (v == null || v === 0) return '';
      return v >= 1 ? 'crit' : 'warn';
    }

    function view(deviceId) {
      var page = ui.page();
      var host = el('div', {});
      page.append(host);

      function refresh() {
        return Promise.all([
          deps.fetchDevice(deviceId),
          deps.fetchCounters(deviceId).catch(function () { return null; }),
        ]).then(function (out) {
          draw(out[0], out[1]);
        }).catch(function (err) {
          host.replaceChildren(ui.errorState({
            title: t('snmpdev.err.title'),
            body: t('snmpdev.err.body'),
            detail: deps.errText ? deps.errText(err) : String(err && err.message),
            onRetry: function () { refresh(); },
          }));
        });
      }

      function draw(data, counters) {
        var device = data.device || {};
        var ports = data.interfaces || [];
        var fdb = data.fdb || [];
        var byInterface = {};
        (counters && counters.counters ? counters.counters : []).forEach(function (c) {
          byInterface[c.interfaceId] = c;
        });

        var body = el('div', {});

        body.append(ui.pageHeader({
          title: device.displayName || device.host || t('snmpdev.title'),
          lead: t('snmpdev.lead', { host: device.host || '–' }),
          help: { title: t('snmpdev.title'), body: deps.help },
        }));

        // What the device ANSWERED, not what it was asked. A switch that cannot
        // serve the forwarding table shows "not supported" rather than an empty
        // column — the same rule the connection test follows.
        var supported = device.supported;
        body.append(ui.statStrip([
          { label: t('snmpdev.stat.ports'), value: ports.length ? String(ports.length) : '–' },
          { label: t('snmpdev.stat.up'), value: String(ports.filter(function (p) { return p.operStatus === 'up'; }).length) },
          {
            label: t('snmpdev.stat.macs'),
            value: supported && supported.indexOf('fdb') < 0 ? t('snmpdev.unsupported') : String(data.fdbTotal || fdb.length),
          },
          {
            label: t('snmpdev.stat.lastOk'),
            value: device.lastOkAt ? new Date(device.lastOkAt).toLocaleString() : t('snmpdev.never'),
            tone: device.lastError ? 'crit' : '',
          },
        ]));

        if (device.lastError) {
          body.append(ui.inlineNote(t('snmpdev.lastError', { error: device.lastError }), 'crit'));
        }

        // ---- the ports ------------------------------------------------------
        var chartHost = el('div', {});

        body.append(ui.panel({
          title: t('snmpdev.ports.title'),
          note: counters ? t('snmpdev.ports.note') : t('snmpdev.ports.noCounters'),
          children: [ports.length ? ui.dataTable({
            dense: true,
            columns: [
              { key: 'name', label: t('snmpdev.col.port'), width: '190px' },
              { key: 'status', label: t('snmpdev.col.status'), width: '110px' },
              { key: 'speed', label: t('snmpdev.col.speed'), width: '90px', num: true },
              { key: 'inRate', label: t('snmpdev.col.in'), width: '110px', num: true },
              { key: 'outRate', label: t('snmpdev.col.out'), width: '110px', num: true },
              { key: 'util', label: t('snmpdev.col.util'), width: '80px', num: true },
              { key: 'errors', label: t('snmpdev.col.errors'), width: '90px', num: true },
              { key: 'discards', label: t('snmpdev.col.discards'), width: '90px', num: true },
              { key: 'alias', label: t('snmpdev.col.alias') },
            ],
            rows: ports.map(function (p) {
              var c = byInterface[p.id] || {};
              var errs = c.inErrPps == null && c.outErrPps == null
                ? null : (c.inErrPps || 0) + (c.outErrPps || 0);
              var disc = c.inDiscPps == null && c.outDiscPps == null
                ? null : (c.inDiscPps || 0) + (c.outDiscPps || 0);
              return {
                cells: {
                  // The NAME is the identity. It is shown as the device spells
                  // it, and a name that came from the weaker ifDescr says so.
                  name: p.nameSource && p.nameSource !== 'ifName'
                    ? el('span', {}, el('code', {}, p.ifName), ' ',
                      el('span', { class: 'meta-xs' }, t('snmpdev.nameSource.' + p.nameSource)))
                    : el('code', {}, p.ifName),
                  status: statusBadge(p),
                  // NULL, not 0: a device that did not report a speed has not
                  // said the port is stalled.
                  speed: p.speedMbps == null ? '–' : p.speedMbps + ' Mbit/s',
                  inRate: fmtBps(c.inBps),
                  outRate: fmtBps(c.outBps),
                  // The busier direction: an uplink saturated outbound read
                  // as idle when only the in-direction was shown.
                  util: fmtPct(c.inUtilPct == null && c.outUtilPct == null ? null
                    : Math.max(c.inUtilPct || 0, c.outUtilPct || 0)),
                  errors: errs == null ? '–'
                    : el('span', { class: errorTone(errs) ? 'num-' + errorTone(errs) : '' }, fmtRate(errs, '/s')),
                  discards: disc == null ? '–'
                    : el('span', { class: errorTone(disc) ? 'num-' + errorTone(disc) : '' }, fmtRate(disc, '/s')),
                  alias: p.ifAlias || '',
                },
                raw: p,
              };
            }),
            // A row opens its chart UNDER the table rather than navigating:
            // comparing one port against the table it came from is the whole
            // reason somebody clicked.
            onOpen: function (row) { openChart(row.raw); },
          }) : ui.emptyState({
            kind: 'nodata',
            title: t('snmpdev.ports.empty.title'),
            body: t('snmpdev.ports.empty.body'),
          })],
        }));

        body.append(chartHost);
        host.replaceChildren(body);

        function openChart(port, minutes) {
          var window_ = minutes || 240;
          chartHost.replaceChildren(ui.panel({
            title: t('snmpdev.chart.title', { port: port.ifName }),
            children: [ui.loadingState(4)],
          }));
          deps.fetchSeries(deviceId, port.id, window_).then(function (out) {
            var samples = out.samples || [];
            // A series where every point is a discontinuity is not a chart —
            // it is a device that has been rebooting, and saying so is more
            // use than an empty plot.
            var usable = samples.filter(function (s) { return s.inBps != null || s.outBps != null; });
            var pick = function (field) {
              return usable.map(function (s) {
                return { y: s[field] == null ? 0 : s[field], label: new Date(s.ts).toLocaleTimeString() };
              });
            };
            // Errors and discards are charted in + out, the same sum the port
            // table shows — a port dropping only on egress was a flat line here.
            var pickSum = function (a, b) {
              return usable.map(function (s) {
                return { y: (s[a] || 0) + (s[b] || 0), label: new Date(s.ts).toLocaleTimeString() };
              });
            };
            chartHost.replaceChildren(ui.panel({
              title: t('snmpdev.chart.title', { port: port.ifName }),
              note: t('snmpdev.chart.note', { n: out.total || samples.length, step: out.step || 1 }),
              actions: WINDOWS.map(function (m) {
                return ui.button(m === window_ ? 'primary' : 'secondary', t('snmpdev.window.' + m), {
                  onclick: function () { openChart(port, m); },
                });
              }),
              children: [
                usable.length ? ui.chart({
                  form: 'line',
                  height: 220,
                  title: t('snmpdev.chart.traffic'),
                  format: fmtBps,
                  series: [
                    { name: t('snmpdev.col.in'), points: pick('inBps') },
                    { name: t('snmpdev.col.out'), points: pick('outBps') },
                  ],
                }) : ui.emptyState({
                  kind: 'nodata',
                  title: t('snmpdev.chart.empty.title'),
                  body: t('snmpdev.chart.empty.body'),
                }),
                // Errors get their OWN chart. On a healthy port they are zero,
                // so plotted against bits per second they would be a flat line
                // at the bottom of the axis and invisible — which is the one
                // thing somebody opening this page is looking for.
                usable.some(function (s) { return s.inErrPps || s.outErrPps || s.inDiscPps || s.outDiscPps; })
                  ? ui.chart({
                    form: 'line',
                    height: 160,
                    title: t('snmpdev.chart.errors'),
                    format: function (v) { return fmtRate(v, '/s'); },
                    series: [
                      { name: t('snmpdev.col.errors'), points: pickSum('inErrPps', 'outErrPps') },
                      { name: t('snmpdev.col.discards'), points: pickSum('inDiscPps', 'outDiscPps') },
                    ],
                  })
                  : el('p', { class: 'meta' }, t('snmpdev.chart.noErrors')),
              ],
            }));
          }).catch(function (err) {
            chartHost.replaceChildren(ui.errorState({
              title: t('snmpdev.chart.err'),
              detail: deps.errText ? deps.errText(err) : String(err && err.message),
              onRetry: function () { openChart(port, window_); },
            }));
          });
        }
      }

      return refresh().then(function () { return page; });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.SnmpDeviceView = apiObj;
})(typeof window !== 'undefined' ? window : null);
