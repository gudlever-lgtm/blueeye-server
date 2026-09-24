// public/views/pathLocation.js — Path & location, as a DashboardPage (template B).
//
// Two questions a technician on the phone asks most: "where is this device
// plugged in?" and "which switches does A cross to reach B?". Both come from
// the server (GET /api/devices/locate, GET /api/topology/l2-path — see
// src/topology/deviceLocator.js and docs/l2-path.md); this screen only draws
// them in the reader's language.
//
// Layout: PageHeader → a Panel for the path (two inputs, the hop list drawn as
// a vertical path: endpoint, switch, switch, …, endpoint — with a GAP drawn as
// its own step when LLDP/CDP does not connect two halves) → a Panel for
// "where is it" → a Panel with the device inventory (operator+; a viewer is
// told why it is empty rather than shown an empty table).
//
// Every uncertainty the server returns is drawn as an inline note ABOVE the
// path. They are the point: "an unmanaged switch or missing LLDP between X
// and Y" is the sentence somebody drives to site on, and a clean-looking
// diagram with the caveat hidden would be the wrong answer drawn confidently.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var KINDS = ['agent', 'switch', 'discovered', 'host'];
    var PAGE = 50;

    // A key this build has no string for falls back to the server's own
    // sentence rather than rendering the key itself.
    function tr(key, params, fallback) {
      var v = t(key, params || {});
      return v === key ? (fallback == null ? '' : String(fallback)) : v;
    }
    function dash(v) { return v == null || v === '' ? '—' : String(v); }

    function speed(mbps) {
      if (mbps == null) return null;
      var n = Number(mbps);
      if (!isFinite(n) || n <= 0) return null;
      return n >= 1000 ? t('l2p.speed.gbps', { n: +(n / 1000).toFixed(1) }) : t('l2p.speed.mbps', { n: n });
    }
    function statusTone(s) {
      if (s === 'up') return 'ok';
      if (s === 'down' || s === 'lowerLayerDown') return 'crit';
      return 'neutral';
    }
    function num(v, digits) {
      if (v == null || !isFinite(Number(v))) return '—';
      return String(+Number(v).toFixed(digits == null ? 1 : digits));
    }

    // The uncertainty's own words, in the reader's language where the catalogue
    // has them. The parameters are cut from the evidence the server sent.
    function uncertaintyText(u, labels) {
      var ev = u.evidence || {};
      var p = {};
      switch (u.code) {
        case 'missingLink':
        case 'noAdjacency':
          p = { from: dash(ev.fromName), fromPort: dash(ev.fromPort), to: dash(ev.toName), toPort: dash(ev.toPort) };
          break;
        case 'fdbDisagrees':
          p = { name: dash(ev.name), seenOn: dash(ev.seenOn), expected: dash(ev.expected) };
          break;
        case 'differentVlans':
        case 'vlanUnknown':
          p = { from: dash(ev.from), to: dash(ev.to) };
          break;
        case 'gatewayNotFound':
          p = { gateway: dash(ev.gateway) };
          break;
        case 'uplinkOnly':
          p = { mac: dash(ev.mac) };
          break;
        case 'notInFdb':
          p = { macs: (ev.macs || []).join(', ') || '—' };
          break;
        case 'sharedPort':
          p = { port: dash(ev.ifName), n: dash(ev.portMacCount) };
          break;
        case 'neighbourOnPort':
          p = { port: dash(ev.ifName), names: (ev.neighbours || []).map(function (n) { return n.sysName || n.chassisId; }).filter(Boolean).join(', ') || '—' };
          break;
        case 'ipMultipleMacs':
          p = { n: (ev.macs || []).length };
          break;
        default:
          p = {};
      }
      var text = tr('l2p.unc.' + u.code, p, u.message);
      var who = u.endpoint && labels ? labels[u.endpoint] : null;
      return who ? who + ': ' + text : text;
    }

    function notes(list, labels) {
      return (list || []).map(function (u) {
        return ui.inlineNote(uncertaintyText(u, labels), u.severity === 'warn' ? 'warn' : 'info');
      });
    }

    // ---- the path diagram ------------------------------------------------------
    function endpointStep(role, e) {
      if (!e) return null;
      var loc = e.location;
      var mac = e.macs && e.macs[0];
      var bits = [];
      if (e.ips && e.ips.length) bits.push(e.ips.slice(0, 3).join(', '));
      if (mac) bits.push(mac.mac + (mac.vendor ? ' (' + mac.vendor + ')' : ''));
      if (loc && loc.vlan != null) bits.push(t('l2p.vlan', { vlan: loc.vlan }));
      if (e.site && e.site.name) bits.push(e.site.name);
      return el('li', { class: 'l2p-step l2p-end' },
        el('div', { class: 'l2p-head' },
          ui.badge('info', tr('l2p.role.' + role, {}, role)),
          el('strong', {}, dash(e.label)),
          loc ? null : ui.badge('warn', t('l2p.notLocated'))),
        bits.length ? ui.metaXs(bits.join(' · ')) : null);
    }

    function portLine(dir, p) {
      var port = p && p.port;
      var head = el('div', { class: 'l2p-port' },
        el('span', { class: 'l2p-dir' }, tr('l2p.dir.' + dir, {}, dir)),
        el('span', { class: 'l2p-ifname' }, p && p.ifName ? p.ifName : '—'),
        p && p.role ? ui.badge(p.role === 'gap' ? 'warn' : 'neutral', tr('l2p.portRole.' + p.role, {}, p.role)) : null,
        port && port.operStatus ? ui.badge(statusTone(port.operStatus), port.operStatus) : null);
      var meta = [];
      if (port && port.alias) meta.push(port.alias);
      var sp = port ? speed(port.speedMbps) : null;
      if (sp) meta.push(sp);
      var c = port && port.counters;
      if (c) {
        meta.push(t('l2p.counters', {
          errIn: num(c.inErrPps, 2), errOut: num(c.outErrPps, 2),
          discIn: num(c.inDiscPps, 2), discOut: num(c.outDiscPps, 2),
          utilIn: num(c.inUtilPct), utilOut: num(c.outUtilPct),
        }));
      } else if (port && port.known) {
        meta.push(t('l2p.noCounters'));
      } else if (p && p.ifName && port && !port.known) {
        meta.push(t('l2p.portUnknown'));
      }
      var warn = c && ((Number(c.inErrPps) || 0) + (Number(c.outErrPps) || 0) + (Number(c.inDiscPps) || 0) + (Number(c.outDiscPps) || 0) > 0
        || (Number(c.inUtilPct) || 0) >= 80 || (Number(c.outUtilPct) || 0) >= 80);
      return el('div', { class: 'l2p-portline' + (warn ? ' is-warn' : '') }, head, meta.length ? ui.metaXs(meta.join(' · ')) : null);
    }

    function switchStep(h) {
      var where = [h.siteName, h.sysLocation].filter(Boolean).join(' · ');
      return el('li', { class: 'l2p-step l2p-hop' },
        el('div', { class: 'l2p-head' },
          ui.hostLink(dash(h.name), function () { deps.openSwitch(h.deviceId); }),
          h.host ? ui.metaXs(h.host) : null,
          (h.linkProtocols || []).map(function (p) { return ui.badge('neutral', String(p).toUpperCase()); }),
          h.vlans && h.vlans.length ? ui.metaXs(t('l2p.vlans', { vlans: h.vlans.join(', ') })) : null),
        where ? ui.metaXs(where) : null,
        portLine('in', h.ingress),
        portLine('out', h.egress));
    }

    function gapStep(g) {
      var names = (g.neighbours || []).map(function (n) { return n.sysName || n.chassisId; }).filter(Boolean);
      return el('li', { class: 'l2p-step l2p-gap' },
        el('div', { class: 'l2p-head' },
          ui.badge('warn', tr('l2p.gap.' + g.reason, {}, g.reason)),
          el('span', {}, t('l2p.gap.between', {
            from: dash(g.from && g.from.name), fromPort: dash(g.from && g.from.ifName),
            to: dash(g.to && g.to.name), toPort: dash(g.to && g.to.ifName),
          }))),
        names.length ? ui.metaXs(t('l2p.gap.neighbours', { names: names.join(', ') })) : null);
    }

    function segmentSteps(seg, data) {
      var out = [];
      if (data.segments.length > 1) {
        out.push(el('li', { class: 'l2p-step l2p-part' },
          ui.metaXs(t('l2p.segment', { from: tr('l2p.role.' + seg.from, {}, seg.from), to: tr('l2p.role.' + seg.to, {}, seg.to) }))));
      }
      (seg.hops || []).forEach(function (h) {
        out.push(h.type === 'gap' ? gapStep(h) : switchStep(h));
      });
      return out;
    }

    function drawPath(host, data) {
      var labels = {
        from: data.from ? data.from.label : t('l2p.role.from'),
        to: data.to ? data.to.label : t('l2p.role.to'),
        gateway: data.gateway ? data.gateway.label : t('l2p.role.gateway'),
      };
      var v = data.vlans || {};
      var vlanNote = v.shared === true
        ? ui.inlineNote(t('l2p.vlan.shared', { vlan: v.from }), 'info')
        : v.shared === false
          ? null // the differentVlans uncertainty says it, with the gateway rule
          : ui.inlineNote(t('l2p.vlan.unknown'), 'info');
      var steps = [endpointStep('from', data.from)];
      data.segments.forEach(function (s, i) {
        steps = steps.concat(segmentSteps(s, data));
        if (data.segments.length > 1 && i < data.segments.length - 1) steps.push(endpointStep('gateway', data.gateway));
      });
      steps.push(endpointStep('to', data.to));
      var cards = [
        { value: data.segments.reduce(function (n, s) { return n + s.hops.filter(function (h) { return h.type === 'switch'; }).length; }, 0), label: t('l2p.stat.switches') },
        { value: data.segments.reduce(function (n, s) { return n + s.hops.filter(function (h) { return h.type === 'gap'; }).length; }, 0), label: t('l2p.stat.gaps'), tone: data.complete ? undefined : 'warn' },
        { value: (data.uncertainties || []).length, label: t('l2p.stat.uncertain'), tone: (data.uncertainties || []).some(function (u) { return u.severity === 'warn'; }) ? 'warn' : undefined },
        { value: (data.graph && data.graph.links) || 0, label: t('l2p.stat.links') },
      ];
      host.replaceChildren(
        ui.statStrip(cards),
        el('div', { class: 'l2p-notes' }, [vlanNote].concat(notes(data.uncertainties, labels))),
        data.segments.length
          ? el('ol', { class: 'l2p-path', 'aria-label': t('l2p.path.aria') }, steps)
          : ui.emptyState({ kind: 'nodata', title: t('l2p.path.none'), body: t('l2p.path.noneBody') }));
    }

    // ---- where is it -----------------------------------------------------------
    function drawLocate(host, d) {
      var loc = d.location;
      var port = d.port;
      var mac = d.macs && d.macs[0];
      var rows = [
        [t('l2p.kv.identity'), el('span', {}, dash(d.label), d.hostname && d.hostname !== d.label ? ' (' + d.hostname + ')' : '')],
        [t('l2p.kv.site'), dash(d.site && d.site.name)],
        [t('l2p.kv.switch'), loc ? ui.hostLink(dash(loc.deviceName), function () { deps.openSwitch(loc.deviceId); }) : t('l2p.notLocated')],
        loc && !loc.self ? [t('l2p.kv.port'), el('span', {}, dash(loc.ifName),
          port && port.alias ? ' — ' + port.alias : '',
          port && port.operStatus ? [' ', ui.badge(statusTone(port.operStatus), port.operStatus)] : null)] : null,
        loc && loc.sysLocation ? [t('l2p.kv.sysLocation'), loc.sysLocation] : null,
        loc && loc.vlan != null ? [t('l2p.kv.vlan'), d.vlanName ? loc.vlan + ' (' + d.vlanName + ')' : String(loc.vlan)] : null,
        [t('l2p.kv.ips'), (d.ips || []).join(', ') || '—'],
        [t('l2p.kv.mac'), mac ? mac.mac : '—'],
        [t('l2p.kv.vendor'), mac ? (mac.vendor || (mac.locallyAdministered ? t('l2p.vendor.random') : t('l2p.vendor.unknown'))) : '—'],
        [t('l2p.kv.firstSeen'), ui.fmt.abs(d.firstSeen)],
        [t('l2p.kv.lastSeen'), d.lastSeen ? ui.fmt.rel(d.lastSeen) : '—'],
        [t('l2p.kv.reportedBy'), (d.reportedBy || []).slice(0, 6).map(function (r) {
          var who = r.agentName || r.deviceName || (r.agentId != null ? '#' + r.agentId : r.deviceId != null ? '#' + r.deviceId : '');
          return tr('l2p.source.' + r.source, {}, r.source) + (who ? ' ' + who : '') + (r.ifName ? ' ' + r.ifName : '');
        }).join(' · ') || '—'],
        d.agentId != null ? [t('l2p.kv.agent'), ui.hostLink(dash(d.label), function () { deps.openAgent(d.agentId); })] : null,
      ];
      host.replaceChildren(
        el('div', { class: 'l2p-notes' }, notes(d.uncertainties)),
        ui.keyValues(rows));
    }

    function view() {
      var state = deps.state;
      var page = ui.page();
      var pathHost = el('div', {});
      var locHost = el('div', {});
      var invHost = el('div', {});
      var info = deps.help();

      function input(id, value, placeholder) {
        var i = el('input', { id: id, type: 'text', placeholder: placeholder, autocomplete: 'off', spellcheck: 'false' });
        i.value = value || '';
        return i;
      }

      // ---- the path panel ----
      var fromIn = input('l2p-from', state.from, t('l2p.placeholder'));
      var toIn = input('l2p-to', state.to, t('l2p.placeholder'));
      var gwIn = input('l2p-gw', state.gateway, t('l2p.placeholder'));
      var pathErr = el('span', {});
      var findBtn = ui.button('primary', t('l2p.path.run'), { onclick: runPath });
      [fromIn, toIn, gwIn].forEach(function (i) {
        i.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); runPath(); } });
      });
      var pathResult = el('div', { class: 'l2p-result' });

      function runPath() {
        state.from = fromIn.value.trim();
        state.to = toIn.value.trim();
        state.gateway = gwIn.value.trim();
        if (!state.from || !state.to) {
          pathErr.replaceChildren(el('span', { class: 'field-error' }, t('l2p.path.need')));
          return Promise.resolve();
        }
        pathErr.replaceChildren();
        findBtn.disabled = true;
        pathResult.replaceChildren(ui.loadingState(4));
        return Promise.resolve()
          .then(function () { return deps.fetchPath({ from: state.from, to: state.to, gateway: state.gateway || null }); })
          .then(function (data) { drawPath(pathResult, data || { segments: [] }); })
          .catch(function (e) {
            pathResult.replaceChildren(e && e.status === 404
              ? ui.emptyState({ kind: 'nodata', title: t('l2p.err.notFound'), body: deps.errText(e) })
              : ui.errorState({ title: t('l2p.err.path'), body: deps.errText(e), detail: 'GET /api/topology/l2-path', onRetry: runPath }));
          })
          .then(function () { findBtn.disabled = false; });
      }

      // ---- the locate panel ----
      var qIn = input('l2p-q', state.q, t('l2p.placeholder'));
      var locErr = el('span', {});
      var locBtn = ui.button('secondary', t('l2p.locate.run'), { onclick: runLocate });
      qIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); runLocate(); } });
      var locResult = el('div', { class: 'l2p-result' });

      function runLocate() {
        state.q = qIn.value.trim();
        if (!state.q) {
          locErr.replaceChildren(el('span', { class: 'field-error' }, t('l2p.locate.need')));
          return Promise.resolve();
        }
        locErr.replaceChildren();
        locResult.replaceChildren(ui.loadingState(3));
        return Promise.resolve()
          .then(function () { return deps.fetchLocate(state.q); })
          .then(function (d) { drawLocate(locResult, d || {}); })
          .catch(function (e) {
            locResult.replaceChildren(e && e.status === 404
              ? ui.emptyState({ kind: 'nodata', title: t('l2p.err.notFound'), body: deps.errText(e) })
              : ui.errorState({ title: t('l2p.err.locate'), body: deps.errText(e), detail: 'GET /api/devices/locate', onRetry: runLocate }));
          });
      }

      // ---- the inventory panel ----
      var inv = { offset: 0, kind: state.invKind || '', q: state.invQ || '' };
      var kindSel = ui.select({
        id: 'l2p-kind', label: t('l2p.inv.kind'), value: inv.kind,
        options: [['', t('l2p.inv.kind.all')]].concat(KINDS.map(function (k) { return [k, tr('l2p.kind.' + k, {}, k)]; })),
        onchange: function (e) { inv.kind = e.target.value; state.invKind = inv.kind; inv.offset = 0; loadInventory(); },
      });
      var filterIn = el('input', { type: 'search', 'aria-label': t('l2p.inv.filter'), placeholder: t('l2p.inv.filter') });
      filterIn.value = inv.q;
      var filterTimer = null;
      filterIn.addEventListener('input', function () {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(function () { inv.q = filterIn.value.trim(); state.invQ = inv.q; inv.offset = 0; loadInventory(); }, 300);
      });
      var invBody = el('div', {});

      function locationCell(i) {
        var l = i.location;
        if (!l) return ui.metaXs(t('l2p.notLocated'));
        if (l.self) return ui.metaXs(t('l2p.inv.isSwitch'));
        return el('span', {},
          ui.hostLink(dash(l.deviceName), function () { deps.openSwitch(l.deviceId); }),
          ' ', el('span', { class: 'l2p-ifname' }, dash(l.ifName)),
          l.sharedPort ? [' ', ui.badge('warn', t('l2p.inv.shared', { n: l.portMacCount }))] : null);
      }
      function nameCell(i) {
        if (i.kind === 'agent') return ui.hostLink(dash(i.name), function () { deps.openAgent(i.id); });
        if (i.kind === 'switch') return ui.hostLink(dash(i.name), function () { deps.openSwitch(i.id); });
        return el('span', {}, dash(i.name));
      }

      function drawInventory(data) {
        var items = data.items || [];
        var from = items.length ? data.offset + 1 : 0;
        var to = data.offset + items.length;
        var prev = ui.button('secondary', t('l2p.inv.prev'), {
          size: 'xs', disabled: data.offset <= 0,
          onclick: function () { inv.offset = Math.max(0, data.offset - PAGE); loadInventory(); },
        });
        var next = ui.button('secondary', t('l2p.inv.next'), {
          size: 'xs', disabled: to >= data.total,
          onclick: function () { inv.offset = data.offset + PAGE; loadInventory(); },
        });
        var caps = Object.keys(data.capped || {}).filter(function (k) { return data.capped[k]; });
        invBody.replaceChildren(
          data.partial ? ui.inlineNote(t('l2p.inv.partial'), 'warn') : null,
          caps.length ? ui.inlineNote(t('l2p.inv.capped', { sources: caps.join(', ') }), 'info') : null,
          items.length ? ui.dataTable({
            columns: [
              { key: 'name', label: t('l2p.inv.col.name'), width: '20%' },
              { key: 'kind', label: t('l2p.inv.col.kind'), width: '110px' },
              { key: 'addr', label: t('l2p.inv.col.addr') },
              { key: 'where', label: t('l2p.inv.col.where') },
              { key: 'site', label: t('l2p.inv.col.site'), width: '120px' },
              { key: 'seen', label: t('l2p.inv.col.seen'), width: '120px', time: true },
            ],
            rows: items.map(function (i) {
              var m = i.macs && i.macs[0];
              return {
                key: i.key,
                item: i,
                cells: {
                  name: nameCell(i),
                  kind: ui.badge('neutral', tr('l2p.kind.' + i.kind, {}, i.kind)),
                  addr: ui.metaXs([(i.ips || []).slice(0, 2).join(', '), m ? m.mac + (m.vendor ? ' (' + m.vendor + ')' : '') : ''].filter(Boolean).join(' · ') || '—'),
                  where: locationCell(i),
                  site: el('span', {}, dash(i.site && i.site.name)),
                  seen: ui.metaXs(i.lastSeen ? ui.fmt.rel(i.lastSeen) : '—'),
                },
              };
            }),
            // Opening a row asks "where is it" about it, in the panel above.
            onOpen: function (row) {
              var i = row.item;
              var q = (i.ips && i.ips[0]) || (i.macs && i.macs[0] && i.macs[0].mac) || i.name;
              qIn.value = q;
              runLocate();
            },
          }) : ui.emptyState({ kind: inv.q || inv.kind ? 'nodata' : 'none', title: t('l2p.inv.empty') }),
          el('div', { class: 'l2p-pager' }, ui.metaXs(t('l2p.inv.range', { from: from, to: to, total: data.total })), prev, next));
      }

      function loadInventory() {
        if (!deps.canInventory()) {
          invBody.replaceChildren(ui.emptyState({ title: t('l2p.inv.forbidden'), body: t('l2p.inv.forbiddenBody') }));
          return Promise.resolve();
        }
        invBody.replaceChildren(ui.loadingState(5));
        return Promise.resolve()
          .then(function () { return deps.fetchInventory({ limit: PAGE, offset: inv.offset, kind: inv.kind || null, q: inv.q || null }); })
          .then(function (data) { drawInventory(data || { items: [], total: 0, offset: 0 }); })
          .catch(function (e) {
            invBody.replaceChildren(e && e.status === 403
              ? ui.emptyState({ title: t('l2p.inv.forbidden'), body: t('l2p.inv.forbiddenBody') })
              : ui.errorState({ title: t('l2p.err.inventory'), body: deps.errText(e), detail: 'GET /api/devices/inventory', onRetry: loadInventory }));
          });
      }

      page.append(
        ui.pageHeader({
          title: t('l2p.title'),
          lead: t('l2p.lead'),
          help: { title: info.title, body: info.body },
        }),
        pathHost, locHost, invHost);

      pathHost.append(ui.panel({
        title: t('l2p.path.title'),
        note: t('l2p.path.note'),
        children: [
          ui.formSection({
            fields: [
              ui.field({ id: 'l2p-from', label: t('l2p.path.from'), control: fromIn, errorNode: pathErr }),
              ui.field({ id: 'l2p-to', label: t('l2p.path.to'), control: toIn }),
              ui.field({ id: 'l2p-gw', label: t('l2p.path.gateway'), hint: t('l2p.path.gatewayHint'), control: gwIn }),
            ],
          }),
          ui.formActions([findBtn]),
          pathResult,
        ],
      }));
      locHost.append(ui.panel({
        title: t('l2p.locate.title'),
        note: t('l2p.locate.note'),
        children: [
          ui.formSection({
            single: true,
            fields: [ui.field({ id: 'l2p-q', label: t('l2p.locate.q'), control: qIn, errorNode: locErr })],
          }),
          ui.formActions([locBtn]),
          locResult,
        ],
      }));
      invHost.append(ui.panel({
        title: t('l2p.inv.title'),
        note: t('l2p.inv.note'),
        children: [
          ui.toolbar({ filters: [ui.filter(t('l2p.inv.kind'), kindSel), filterIn] }),
          invBody,
        ],
      }));

      // Arriving from search (or a reload with the fields filled) runs at once.
      if (state.from && state.to) runPath();
      if (state.q) runLocate();
      loadInventory();
      return Promise.resolve(page);
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.PathLocationPage = apiObj;
})(typeof window !== 'undefined' ? window : null);
