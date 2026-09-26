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

    // One error rate as a cell: a dash when the device could not report it,
    // coloured when it is anything but zero.
    function rateCell(v) {
      if (v == null) return '–';
      return el('span', { class: errorTone(v) ? 'num-' + errorTone(v) : '' }, fmtRate(v, '/s'));
    }

    // Duplex as the device reported it (EtherLike-MIB). HALF is the one worth a
    // colour, and it turns critical when late collisions or FCS errors are
    // rising with it — that combination is a duplex mismatch, the fault this
    // column exists to make visible. NULL is a dash: the device did not answer,
    // which is not the same as answering "unknown".
    function duplexCell(c) {
      if (!c || c.duplex == null) return '–';
      if (c.duplex === 'half') {
        var mismatch = (c.lateCollPps || 0) > 0 || (c.fcsPps || 0) > 0;
        var badge = ui.badge(mismatch ? 'crit' : 'warn', t('snmpdev.duplex.half'));
        if (mismatch) badge.setAttribute('title', t('snmpdev.duplex.mismatch'));
        return badge;
      }
      return ui.badge(c.duplex === 'full' ? 'ok' : 'neutral', t('snmpdev.duplex.' + c.duplex));
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
          // What the switch itself said — its syslog and traps, tied to it by
          // the address they came from (migration 133).
          actions: [deps.openDeviceLog ? ui.button('secondary', t('snmpdev.action.deviceLog'), {
            onclick: function () { deps.openDeviceLog(device.id); },
          }) : null],
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

        // WHERE the device is: the site, and below it the room or rack the
        // device's own sysLocation names. The site says which building; this
        // says where in it to walk.
        var where = [data.siteName || null, device.sysLocation || null].filter(Boolean).join(' · ');
        if (where) body.append(el('p', { class: 'meta' }, t('snmpdev.where', { where: where })));

        // What the switch says it is — model, OS, firmware — so nobody has to
        // log in to it to find out which box this page is about.
        if (device.sysDescr) {
          body.append(el('p', { class: 'meta' }, t('snmpdev.sysDescr', { descr: device.sysDescr })));
        }
        // The name the switch gives itself (SNMPv2-MIB sysName) — the name its
        // neighbours see over LLDP/CDP, and often not the one it was added as.
        if (device.sysName && device.sysName !== device.displayName) {
          body.append(el('p', { class: 'meta' }, t('snmpdev.sysName', { name: device.sysName })));
        }
        var hw = device.hardware || {};
        var about = [
          hw.model ? t('snmpdev.hw.model', { model: [hw.vendor, hw.model].filter(Boolean).join(' ') }) : null,
          hw.serial ? t('snmpdev.hw.serial', { serial: hw.serial }) : null,
          device.sysContact ? t('snmpdev.sysContact', { contact: device.sysContact }) : null,
          device.sysObjectId ? t('snmpdev.sysObjectId', { oid: device.sysObjectId }) : null,
        ].filter(Boolean);
        if (about.length) body.append(el('p', { class: 'meta-xs' }, about.join(' · ')));

        if (device.lastError) {
          body.append(ui.inlineNote(t('snmpdev.lastError', { error: device.lastError }), 'crit'));
        }

        // ---- the ports ------------------------------------------------------
        var chartHost = el('div', {});
        // A 48-port switch is a long table; the filter narrows it by name,
        // alias or status as it is typed.
        var portQuery = '';
        var portTableHost = el('div', {});
        var portSearch = el('input', {
          type: 'search', placeholder: t('snmpdev.ports.searchPlaceholder'),
          'aria-label': t('snmpdev.ports.search'), size: '18',
          oninput: function (e) { portQuery = String(e.target.value || '').trim().toLowerCase(); drawPorts(); },
        });
        function drawPorts() {
          var all = ports;
          var ports_ = portQuery ? all.filter(function (p) {
            return [p.ifName, p.ifAlias, p.operStatus, p.adminStatus].some(function (v) {
              return v != null && String(v).toLowerCase().indexOf(portQuery) >= 0;
            });
          }) : all;
          portTableHost.replaceChildren(ports_.length ? ui.dataTable({
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
              // The EtherLike columns. Errors and discards say a port is
              // broken; these say HOW — FCS is the cable or the optic, late
              // collisions with half duplex is a duplex mismatch.
              { key: 'fcs', label: t('snmpdev.col.fcs'), width: '80px', num: true },
              { key: 'lateColl', label: t('snmpdev.col.lateColl'), width: '90px', num: true },
              { key: 'duplex', label: t('snmpdev.col.duplex'), width: '80px' },
              // The port's configured MTU (ifMtu). It belongs next to duplex:
              // both are settings rather than measurements, and both are faults
              // that leave every counter on this row looking clean.
              { key: 'mtu', label: t('snmpdev.col.mtu'), width: '80px', num: true },
              { key: 'alias', label: t('snmpdev.col.alias') },
            ],
            rows: ports_.map(function (p) {
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
                  fcs: rateCell(c.fcsPps),
                  lateColl: rateCell(c.lateCollPps),
                  duplex: duplexCell(c),
                  // NULL, not 0, for the same reason as speed: a device that
                  // did not report an MTU has not configured one of zero.
                  mtu: p.mtu == null ? '–' : String(p.mtu),
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
          }));
        }

        body.append(ui.panel({
          title: t('snmpdev.ports.title'),
          note: counters ? t('snmpdev.ports.note') : t('snmpdev.ports.noCounters'),
          actions: [portSearch],
          children: [portTableHost],
        }));
        drawPorts();

        body.append(chartHost);

        // ---- the forwarding table -------------------------------------------
        // Which MAC sits behind which port — the question "where is that
        // device plugged in?" answered on the switch that knows. The count on
        // the stat strip used to be all the page showed of it.
        if (fdb.length) {
          var fdbQuery = '';
          var fdbHost = el('div', {});
          var copy = deps.copyable || function (v) { return el('code', {}, v); };
          var fdbSearch = el('input', {
            type: 'search', placeholder: t('snmpdev.fdb.searchPlaceholder'),
            'aria-label': t('snmpdev.fdb.search'), size: '18',
            oninput: function (e) { fdbQuery = String(e.target.value || '').trim().toLowerCase(); drawFdb(); },
          });
          var drawFdb = function () {
            var q = fdbQuery.replace(/[-.]/g, ':');
            var rows = fdbQuery ? fdb.filter(function (f) {
              return [f.mac, f.ifName, f.bridgePort, f.vlan].some(function (v) {
                return v != null && String(v).toLowerCase().replace(/[-.]/g, ':').indexOf(q) >= 0;
              });
            }) : fdb;
            fdbHost.replaceChildren(rows.length ? ui.dataTable({
              dense: true,
              columns: [
                { key: 'mac', label: t('snmpdev.fdb.mac'), width: '190px' },
                { key: 'port', label: t('snmpdev.fdb.port'), width: '150px' },
                { key: 'vlan', label: t('snmpdev.fdb.vlan'), width: '70px', num: true },
                { key: 'portMacs', label: t('snmpdev.fdb.portMacs'), width: '120px', num: true },
                { key: 'moves', label: t('snmpdev.fdb.moves'), width: '90px', num: true },
                { key: 'seen', label: t('snmpdev.fdb.lastSeen'), time: true },
              ],
              rows: rows.map(function (f) {
                return {
                  cells: {
                    mac: copy(f.mac),
                    port: f.ifName ? el('code', {}, f.ifName) : ui.meta('#' + f.bridgePort),
                    vlan: f.vlan ? String(f.vlan) : '–',
                    portMacs: String(f.portMacCount || '–'),
                    // A MAC that keeps moving between ports is how a loop
                    // looks from here; it carries the tone.
                    moves: f.moveCount > 0
                      ? el('span', { class: f.moveCount >= 3 ? 'num-crit' : 'num-warn' }, String(f.moveCount))
                      : '0',
                    seen: f.lastSeen ? new Date(f.lastSeen).toLocaleString() : '–',
                  },
                };
              }),
            }) : ui.emptyState({ kind: 'nodata', title: t('snmpdev.fdb.none') }));
          };
          body.append(ui.panel({
            title: t('snmpdev.fdb.title'),
            note: t('snmpdev.fdb.note', { shown: fdb.length, total: data.fdbTotal || fdb.length }),
            actions: [fdbSearch],
            children: [fdbHost],
          }));
          drawFdb();
        }

        // The VLAN names the switch reported. Only when there are any: a
        // switch without Q-BRIDGE names is common, and an empty panel for it
        // would be noise on a page that is about ports.
        var vlans = data.vlans || [];
        if (vlans.length) {
          body.append(ui.panel({
            title: t('snmpdev.vlans.title'),
            note: t('snmpdev.vlans.note'),
            children: [ui.dataTable({
              dense: true,
              columns: [
                { key: 'vlan', label: t('snmpdev.col.vlan'), width: '90px', num: true },
                { key: 'name', label: t('snmpdev.col.vlanName') },
              ],
              rows: vlans.map(function (v) {
                return { cells: { vlan: String(v.vlan), name: v.name } };
              }),
            })],
          }));
        }

        // The neighbours the switch sees, LLDP and CDP in one table with the
        // protocol named — a Cisco neighbour speaking both is two rows,
        // because the two carry different identities (a MAC and a hostname).
        var neighbours = data.neighbours || [];
        if (neighbours.length) {
          body.append(ui.panel({
            title: t('snmpdev.neighbours.title'),
            note: t('snmpdev.neighbours.note'),
            children: [ui.dataTable({
              dense: true,
              columns: [
                { key: 'port', label: t('snmpdev.col.port'), width: '160px' },
                { key: 'proto', label: t('snmpdev.col.protocol'), width: '80px' },
                { key: 'remote', label: t('snmpdev.col.neighbour') },
                { key: 'rport', label: t('snmpdev.col.remotePort'), width: '160px' },
                { key: 'addr', label: t('snmpdev.col.address'), width: '140px' },
                { key: 'platform', label: t('snmpdev.col.platform') },
              ],
              rows: neighbours.map(function (n) {
                return {
                  cells: {
                    port: n.localIfName ? el('code', {}, n.localIfName) : '–',
                    proto: ui.badge('neutral', (n.protocol || 'lldp').toUpperCase()),
                    remote: n.remoteSysName || n.remoteChassisId,
                    rport: n.remotePortId || '–',
                    addr: n.remoteAddress || '–',
                    platform: n.remotePlatform || '',
                  },
                };
              }),
            })],
          }));
        }

        // The router's ARP table (IP-MIB). The first rows, newest first, with
        // the true size in the note — the search field is the way into the
        // rest.
        var arp = data.arp || [];
        if (arp.length) {
          body.append(ui.panel({
            title: t('snmpdev.arp.title'),
            note: t('snmpdev.arp.note', { shown: arp.length, total: data.arpTotal || arp.length }),
            children: [ui.dataTable({
              dense: true,
              columns: [
                { key: 'ip', label: t('snmpdev.col.ip'), width: '180px' },
                { key: 'mac', label: t('snmpdev.col.mac'), width: '160px' },
                { key: 'iface', label: t('snmpdev.col.interface'), width: '140px' },
                { key: 'seen', label: t('snmpdev.col.lastSeen') },
              ],
              rows: arp.map(function (r) {
                return {
                  cells: {
                    ip: el('code', {}, r.ip),
                    mac: el('code', {}, r.mac),
                    iface: r.ifName || '–',
                    seen: r.lastSeen ? new Date(r.lastSeen).toLocaleString() : '–',
                  },
                };
              }),
            })],
          }));
        } else if (supported && supported.indexOf('arp') < 0 && (device.collect || []).indexOf('arp') >= 0) {
          body.append(ui.inlineNote(t('snmpdev.arp.unsupported'), 'info'));
        }

        // The hardware (ENTITY-MIB): every chassis — a stack of eight is
        // eight serials — and the modules that name themselves.
        var inventory = data.inventory || [];
        if (inventory.length) {
          body.append(ui.panel({
            title: t('snmpdev.inventory.title'),
            note: t('snmpdev.inventory.note'),
            children: [ui.dataTable({
              dense: true,
              columns: [
                { key: 'name', label: t('snmpdev.col.entity'), width: '200px' },
                { key: 'cls', label: t('snmpdev.col.class'), width: '90px' },
                { key: 'model', label: t('snmpdev.col.model'), width: '180px' },
                { key: 'serial', label: t('snmpdev.col.serial'), width: '150px' },
                { key: 'rev', label: t('snmpdev.col.revisions') },
              ],
              rows: inventory.map(function (e) {
                return {
                  cells: {
                    name: e.name || e.descr || String(e.entIndex),
                    cls: ui.badge('neutral', t('snmpdev.class.' + (e.class === 'module' ? 'module' : 'chassis'))),
                    model: e.model ? el('code', {}, e.model) : '–',
                    serial: e.serial ? el('code', {}, e.serial) : '–',
                    rev: [e.hardwareRev ? 'HW ' + e.hardwareRev : null, e.firmwareRev ? 'FW ' + e.firmwareRev : null,
                      e.softwareRev ? 'SW ' + e.softwareRev : null].filter(Boolean).join(' · '),
                  },
                };
              }),
            })],
          }));
        }

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
