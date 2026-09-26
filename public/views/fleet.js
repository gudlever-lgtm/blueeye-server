// public/views/fleet.js — Fleet: one table of agents, three column sets, a
// drawer per row. A ListPage (template A) built from the contract's components
// (public/ui.js, docs/ui-contract.md).
//
// This screen absorbed three others — Agents, Interfaces and NICs — see
// docs/fleet-and-sites-consolidation.md for why and for the column sets.
//
// The short version: Fleet and Agents were the same table with two different
// definitions of health, and Interfaces was a fleet-wide screen that could only
// ever show one agent. Sub-tabs would have fixed the menu and kept the problem,
// because a tab changes the ROWS: agents, then ports, then NIC models, and the
// reader loses their place, their filter and their sort at every switch. A
// column set keeps the rows identical and changes only what is said about them.
//
//   * Health   — the measurements (loss, latency, jitter, targets, throughput).
//   * Drift    — the deployment (version, source, data quality) + the actions.
//   * Hardware — ports and NICs, summarised per agent.
//
// The interface figures cost nothing extra: mergeHealth() already writes
// ifaceStatus/ifaceCount/ifaceIssues/worstIface into health.metrics, so
// /api/fleet/health has carried them all along.
//
// Three things on this page are NOT the contract's and are passed in whole: the
// NOC header (KPI cards + the live network path), the fleet-wide traffic map
// (Leaflet, rendered once per view entry so the 10 s poll does not rebuild it
// under the reader), and the licence-gated issues rollup. They belong to the
// Health set, which is the one that answers "how is the estate right now".
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;
    var F = deps.FleetFilter;

    var SETS = ['health', 'drift', 'hardware'];
    var IFACE_TONE = { ok: 'ok', warn: 'warn', bad: 'crit', down: 'crit' };

    function view() {
      var state = deps.state;
      // One sort per column set: the columns differ, so a sort chosen on Drift
      // means nothing on Hardware and must not follow the reader there.
      if (!state.sort) state.sort = {};
      if (state.q == null) state.q = '';

      var page = ui.page();
      var headHost = el('div', {});
      var noteHost = el('div', {});
      var stripHost = el('div', {});
      var setsHost = el('div', {});
      var toolbarHost = el('div', {});
      var tableHost = el('div', {});
      var nocHost = el('div', {});
      var trafficHost = el('div', {});
      var issuesHost = el('div', {});

      // /api/fleet/health — polled. The other two are read once per view entry:
      // a version, a traffic source and a NIC firmware move in days, and have no
      // business in a ten-second poll.
      var data = null;
      var adminById = null;
      var nicByAgentId = null;
      var nicOutliers = null;
      var versions = { offered: null, source: null };

      var search = el('input', {
        type: 'search', placeholder: t('fleet.searchPh'), value: state.q,
      });
      search.addEventListener('input', function () {
        // Filtering is over rows already in hand, so it is immediate — and the
        // toolbar is not rebuilt, which would take the caret with it.
        state.q = search.value.trim().toLowerCase();
        drawTable();
      });

      page.append(headHost, noteHost, stripHost, setsHost, toolbarHost, tableHost,
        nocHost, trafficHost, issuesHost);

      function set() { return SETS.indexOf(deps.tab()) >= 0 ? deps.tab() : 'health'; }
      function sortState() {
        if (!state.sort[set()]) state.sort[set()] = { key: null, dir: 'desc' };
        return state.sort[set()];
      }

      // ---- header -----------------------------------------------------------
      // The Drift set carries a count-bearing action ("Update outdated (3)"), so
      // the header is rebuilt when the agent list arrives rather than assembled
      // empty and patched afterwards.
      function outdated() {
        if (!adminById) return [];
        var out = [];
        Object.keys(adminById).forEach(function (id) {
          var a = adminById[id];
          if (deps.selfUpdatable(a) && deps.isBehind(a, deps.updateTarget(a, versions))) out.push(a);
        });
        return out;
      }

      function drawHead() {
        var info = deps.help();
        var behind = set() === 'drift' ? outdated() : [];
        headHost.replaceChildren(ui.pageHeader({
          title: t('fleet.title'),
          lead: info.lead,
          help: { title: info.title, body: info.body },
          actions: [
            (deps.canDelete() && behind.length)
              ? ui.button('secondary', t('ag.updateOutdated', { n: behind.length }), {
                title: t('ag.updateOutdatedHint'),
                onclick: function () { deps.bulkUpdate(behind, versions.offered); },
              })
              : null,
            deps.canWrite() ? ui.button('primary', t('ag.new'), { onclick: function () { deps.newAgent(); } }) : null,
          ],
        }));
      }

      // ---- live advisories --------------------------------------------------
      // A maintenance window is a fact about the DATA in front of the reader —
      // alerts are suppressed while it runs — so it stays on screen as an inline
      // note rather than moving behind the (?).
      function drawNotes(windows) {
        var active = (windows || []).filter(function (w) {
          var now = Date.now();
          return Date.parse(w.from) <= now && now <= Date.parse(w.to);
        });
        if (!active.length) { noteHost.replaceChildren(); return; }
        noteHost.replaceChildren(ui.inlineNote(
          '🛠 ' + t('fleet.maintenance', { names: active.map(function (w) { return w.name; }).join(', ') }),
          'warn'));
      }

      // ---- StatStrip: the four metric cards ---------------------------------
      function summaryTotal(s) { return deps.summaryTotal(s); }

      function drawStrip() {
        if (!data) { stripHost.replaceChildren(); return; }
        var s = data.summary || {};
        var agents = data.agents || [];
        var total = summaryTotal(s);
        var crit = (s.bad || 0) + (s.down || 0);
        // The summary is always whole-fleet, even when the server pre-narrowed
        // the agent list, so these counts stay honest under a filter.
        var offline = typeof s.offline === 'number'
          ? s.offline
          : agents.filter(function (a) { return !a.online; }).length;
        var healthPct = total ? Math.round(((s.ok || 0) / total) * 100) : null;

        stripHost.replaceChildren(ui.statStrip([
          {
            value: healthPct == null ? '–' : healthPct + '%',
            label: t('fleet.card.health'),
            title: t('fleet.card.healthHint'),
            active: deps.getSortByHealth(),
            // Health is a SORT, not a filter: it orders the grid worst-first.
            onclick: function () { deps.setSortByHealth(!deps.getSortByHealth()); draw(); },
          },
          {
            value: String(crit), label: t('changes.group.CRIT'), tone: 'crit',
            title: t('fleet.card.filterHint'),
            active: deps.filter().severity.indexOf('CRIT') >= 0,
            onclick: function () { deps.setFilter(F.toggleSeverity(deps.filter(), 'CRIT')); draw(); },
          },
          {
            value: String(s.warn || 0), label: t('changes.group.WARN'), tone: 'warn',
            title: t('fleet.card.filterHint'),
            active: deps.filter().severity.indexOf('WARN') >= 0,
            onclick: function () { deps.setFilter(F.toggleSeverity(deps.filter(), 'WARN')); draw(); },
          },
          {
            value: String(offline), label: t('fleet.card.offline'),
            title: t('fleet.card.offlineHint'),
            active: deps.filter().offline,
            onclick: function () { deps.setFilter(F.toggleOffline(deps.filter())); draw(); },
          },
        ]));
      }

      // ---- the column-set strip ---------------------------------------------
      // Hardware hides itself when nothing in the estate can fill it: an agent
      // on a flow source reports sampled conversations, not per-interface
      // counters, and NIC data needs a Linux host new enough to collect it. A
      // set whose only content would be an explanation of its own emptiness is
      // not worth a tab.
      function hardwareUseful() {
        if (nicByAgentId && Object.keys(nicByAgentId).length) return true;
        return ((data && data.agents) || []).some(function (a) {
          return ((a.health || {}).metrics || {}).ifaceCount > 0;
        });
      }

      function drawSets() {
        var items = [['health', t('fleet.set.health')], ['drift', t('fleet.set.drift')]];
        if (hardwareUseful()) items.push(['hardware', t('fleet.set.hardware')]);
        else if (set() === 'hardware') deps.setTab('health');
        setsHost.replaceChildren(ui.tabs(items, {
          active: set(),
          ariaLabel: t('fleet.setLabel'),
          onPick: function (key) {
            if (key === set()) return;
            deps.setTab(key);
            draw();
          },
        }));
      }

      // ---- Toolbar ----------------------------------------------------------
      function drawToolbar() {
        var active = F.isActive(deps.filter()) || !!state.q;
        toolbarHost.replaceChildren(ui.toolbar({
          filters: [
            ui.filter(t('fleet.filter.site'), ui.select({
              label: t('fleet.filter.site'),
              value: deps.filter().site || '',
              options: [['', t('fleet.filter.allSites')]].concat(siteOptions()),
              onchange: function (e) {
                deps.setFilter(F.setSite(deps.filter(), e.target.value || null));
                draw();
              },
            })),
            ui.filter(t('fleet.search'), search),
          ],
          actions: active
            ? [ui.button('secondary', t('fleet.clearFilters'), {
              onclick: function () {
                deps.setFilter(F.emptyState());
                state.q = '';
                search.value = '';
                draw();
              },
            })]
            : [],
        }));
      }

      function siteOptions() {
        var seen = {};
        var out = [];
        ((data && data.agents) || []).forEach(function (a) {
          var name = a.locationName;
          if (!name || seen[name]) return;
          seen[name] = true;
          out.push([name, name]);
        });
        return out.sort(function (x, y) { return String(x[1]).localeCompare(String(y[1])); });
      }

      // ---- cells ------------------------------------------------------------
      function num(v, unit) { return v == null ? '–' : v + (unit || ''); }
      function adminOf(a) { return (adminById && adminById[a.agentId]) || null; }
      function metricsOf(a) { return (a.health && a.health.metrics) || {}; }

      function agentCell(a) {
        var dq = a.quality && a.quality.status && a.quality.status !== 'ok' && a.quality.status !== 'unknown';
        return el('span', {},
          ui.hostLink(a.displayName, function () { openRowDrawer(a, null); }),
          // The data-quality flag is a warning about the MEASUREMENT, so it
          // sits with the name it qualifies rather than in the health cell.
          dq ? el('span', {
            class: 'meta-xs',
            title: t('fleet.quality', { reason: a.quality.reason || a.quality.status }),
          }, ' ⚠') : null,
          a.displayName !== a.hostname ? el('div', { class: 'meta-xs' }, a.hostname) : null);
      }

      // One verdict, offline included. Fleet used to carry a STATUS column
      // beside this one, and an offline agent read OFFLINE and STALE side by
      // side — mergeConnection() has already folded connection state in.
      // An ACKNOWLEDGED verdict still reads CRIT — the fault has not gone away,
      // somebody is on it. So the badge is untouched and the acknowledgement is
      // a second, neutral marker beside it: the row never looks healthier than
      // it is, and the shift can see at a glance which of the red rows are
      // already claimed.
      function ackOf(a) { return (a && a.health && a.health.ack) || null; }

      function healthCell(a) {
        var badge = a.online ? deps.healthBadgeUi(a.health) : ui.badge('neutral', t('fleet.offline'));
        var ack = ackOf(a);
        if (!ack) return badge;
        return el('span', { class: 'dw-ver', title: t('fleet.ack.byAt', { by: ack.by || t('fleet.ack.someone'), at: ui.fmt.short(ack.at) }) },
          badge, ui.badge('neutral', t('fleet.ack.badge')));
      }

      // The version is what "Update outdated (3)" in the header is about.
      function versionCell(a) {
        var adm = adminOf(a);
        var v = adm && adm.capabilities && adm.capabilities.agentVersion;
        if (!v) return ui.meta('–');
        var target = deps.updateTarget(adm, versions);
        if (!deps.isBehind(adm, target)) return ui.meta('v' + v);
        // An installer-only agent is not stuck and not one click from fixed, so
        // its badge says which — grey, not amber, because nothing here will do
        // it for you.
        var oneClick = deps.selfUpdatable(adm) || deps.isWindows(adm);
        return el('span', {},
          ui.meta('v' + v), ' ',
          el('span', { title: oneClick ? t('ag.update.hint', { v: target }) : t('ag.updateInstaller.hint') },
            ui.badge(oneClick ? 'warn' : 'neutral', oneClick ? t('ag.update') : t('ag.updateInstaller'))));
      }

      function sourceCell(a) {
        var adm = adminOf(a);
        var mc = (adm && adm.monitor_config) || {};
        var src = mc.source || 'proc';
        return ui.meta(src === 'snmp' && mc.snmp ? src + ' (' + mc.snmp.host + ')' : src);
      }

      // Promoted out of the ⚠ beside the name: on the Drift set the reason a
      // measurement cannot be trusted is the column, not a tooltip.
      function qualityCell(a) {
        var q = a.quality || {};
        if (!q.status || q.status === 'unknown') return ui.meta('–');
        if (q.status === 'ok') return ui.badge('ok', t('fleet.quality.ok'));
        return el('span', {},
          ui.badge(q.status === 'warn' ? 'warn' : 'crit', t('fleet.quality.' + (q.status === 'warn' ? 'warn' : 'bad'))),
          q.reason ? el('div', { class: 'meta-xs' }, q.reason) : null);
      }

      function portFaultCell(a) {
        var m = metricsOf(a);
        if (m.ifaceCount == null) return ui.meta('–');
        if (!m.ifaceIssues) return el('span', {}, '0');
        return el('span', {},
          el('span', { class: m.ifaceStatus === 'warn' ? 'num-warn' : 'num-crit' }, String(m.ifaceIssues)),
          m.worstIface ? ui.metaXs(' ' + m.worstIface) : null);
      }

      function linkCell(a) {
        var m = metricsOf(a);
        if (!m.ifaceStatus) return ui.meta('–');
        var key = 'iface.st.' + m.ifaceStatus;
        var label = t(key);
        return ui.badge(IFACE_TONE[m.ifaceStatus] || 'neutral', label === key ? String(m.ifaceStatus) : label);
      }

      function nicsOf(a) { return (nicByAgentId && nicByAgentId[a.agentId]) || null; }
      // The ports section counts the cards too now that it lists them: an agent
      // with no measurement yet but one reported NIC has a row, and a header
      // reading "Ports" with no number over a table with a row in it is wrong.
      function portCount(a) {
        var n = nicsOf(a);
        return Math.max(metricsOf(a).ifaceCount || 0, n ? n.length : 0);
      }
      function hasDrift(a) { return !!(nicOutliers && nicOutliers[a.agentId]); }

      function firmwareCell(a) {
        var nics = nicsOf(a);
        if (!nics || !nics.length) return ui.meta('–');
        if (!hasDrift(a)) return ui.badge('ok', t('nic.majority'));
        return ui.badge('warn', t('fleet.col.firmwareDrift'));
      }

      function menuFor(a) {
        var adm = adminOf(a);
        if (!adm) return [];
        var target = deps.updateTarget(adm, versions);
        var behind = deps.isBehind(adm, target);
        var flowSource = adm.monitor_config
          && (adm.monitor_config.source === 'netflow' || adm.monitor_config.source === 'sflow');
        return [
          // The four that only look.
          { label: t('ag.act.traffic'), onclick: function () { deps.showResults(adm); } },
          flowSource ? { label: t('ag.act.flows'), onclick: function () { deps.showFlows(adm); } } : null,
          { label: t('ag.act.connection'), onclick: function () { deps.showConnection(adm); } },
          { label: t('ag.act.ping'), onclick: function () { deps.ping(adm); } },
          { label: t('ag.act.diagnose'), onclick: function () { deps.diagnose(adm); } },
          { label: t('ag.act.speed'), onclick: function () { deps.speedtest(adm); } },
          // …and the ones that change something.
          deps.canWrite() ? '-' : null,
          deps.canWrite() ? { label: t('ag.act.edit'), onclick: function () { deps.edit(adm); } } : null,
          // SNMP is optional and applies to one source out of four, so it lives
          // here rather than in the middle of the Edit form.
          deps.canWrite() ? { label: t('ag.act.snmp'), onclick: function () { deps.editSnmp(adm); } } : null,
          deps.canWrite() && deps.editPosition ? { label: t('ag.act.position'), onclick: function () { deps.editPosition(adm); } } : null,
          deps.canDelete() ? updateEntry(adm, target, behind) : null,
          deps.canDelete() ? '-' : null,
          deps.canDelete() ? { label: t('ag.act.delete'), danger: true, onclick: function () { deps.remove(adm); } } : null,
        ].filter(Boolean);
      }

      // A Windows agent is not stuck: it gets a one-liner that updates it in
      // place, rather than being told to reinstall.
      function updateEntry(adm, target, behind) {
        if (!deps.selfUpdatable(adm) && deps.isWindows(adm)) {
          // Offered whether or not the agent is behind: the one-liner reinstalls
          // in place and keeps the enrollment, and an operator who wants to
          // re-run it on a healthy host had no way to get at it from here.
          return {
            label: behind ? t('agentUpdate.win.button') : t('ag.act.winReinstall'),
            onclick: function () { deps.windowsUpdate(adm, target); },
          };
        }
        if (!deps.selfUpdatable(adm)) return null;
        return {
          label: behind ? t('ag.act.update', { v: target }) : t('ag.act.upgrade'),
          onclick: function () { deps.update(adm, target); },
        };
      }

      function actCell(a) {
        var adm = adminOf(a);
        if (!adm) return null;
        return ui.rowActions(
          deps.canWrite() ? { label: t('ag.act.run'), onclick: function () { deps.runTest(adm); } } : null,
          menuFor(a));
      }

      function toRow(a) {
        var m = metricsOf(a);
        var nics = nicsOf(a);
        return {
          a: a,
          cells: {
            agent: agentCell(a),
            health: healthCell(a),
            location: ui.meta(a.locationName || '–'),
            // The agent's last REPORT, not its last probe: Fleet showed one and
            // Agents the other, under the same heading.
            seen: a.lastReportAt ? ui.fmt.short(a.lastReportAt) : '–',
            act: actCell(a),

            loss: num(m.lossPct, '%'),
            latency: deps.latencyText(m),
            jitter: num(m.jitterMs, ' ms'),
            targets: m.targets ? m.reachable + '/' + m.targets : '–',
            speed: deps.throughputText(a.throughput),

            version: versionCell(a),
            source: sourceCell(a),
            quality: qualityCell(a),

            ports: m.ifaceCount == null ? ui.meta('–') : String(m.ifaceCount),
            portFaults: portFaultCell(a),
            link: linkCell(a),
            nic: nics && nics.length ? String(nics.length) : ui.meta('–'),
            firmware: firmwareCell(a),
          },
        };
      }

      // ---- columns per set --------------------------------------------------
      // Version sits with the fixed columns rather than in the Drift set: it is
      // the one deployment fact people look for on every screenful (and the
      // update badge rides on it), and hiding it behind a column set meant the
      // reader had to go looking for a column that used to be right there.
      var FIXED_LEFT = [
        { key: 'agent', label: t('fleet.col.agent'), width: '210px', sortable: true },
        { key: 'health', label: t('fleet.col.health'), width: '120px', sortable: true },
        { key: 'version', label: t('ag.col.version'), width: '168px', sortable: true },
      ];
      function fixedRight() {
        return [
          { key: 'location', label: t('fleet.col.location'), width: '140px', sortable: true },
          { key: 'seen', label: t('fleet.col.seen'), width: '128px', sortable: true, time: true },
        ].concat(adminById ? [{ key: 'act', label: '', width: '116px' }] : []);
      }

      var SET_COLUMNS = {
        health: function () {
          return [
            { key: 'loss', label: t('fleet.col.loss'), width: '84px', sortable: true, num: true },
            { key: 'latency', label: t('fleet.col.latency'), width: '104px', sortable: true, num: true },
            { key: 'jitter', label: t('fleet.col.jitter'), width: '92px', sortable: true, num: true },
            { key: 'targets', label: t('fleet.col.targets'), width: '92px', num: true },
            { key: 'speed', label: t('fleet.col.speed'), width: '104px', num: true },
          ];
        },
        drift: function () {
          return [
            { key: 'source', label: t('ag.col.source'), width: '150px', sortable: true },
            { key: 'quality', label: t('fleet.col.quality'), sortable: true },
          ];
        },
        hardware: function () {
          return [
            { key: 'ports', label: t('fleet.col.ports'), width: '84px', sortable: true, num: true },
            { key: 'portFaults', label: t('fleet.col.portFaults'), width: '132px', sortable: true, num: true },
            { key: 'link', label: t('fleet.col.link'), width: '104px', sortable: true },
            { key: 'nic', label: t('fleet.col.nic'), width: '76px', sortable: true, num: true },
            { key: 'firmware', label: t('fleet.col.firmware'), width: '132px', sortable: true },
          ];
        },
      };

      function columns() {
        return FIXED_LEFT.concat(SET_COLUMNS[set()]()).concat(fixedRight());
      }

      // ---- sorting ----------------------------------------------------------
      var IFACE_RANK = { down: 0, bad: 1, warn: 2, ok: 3 };
      function numOr(a, key) {
        var v = metricsOf(a)[key];
        return typeof v === 'number' ? v : -1;
      }

      var SORTERS = {
        agent: function (a) { return String(a.displayName || '').toLowerCase(); },
        health: function (a) { return (a.health && a.health.score) || 0; },
        location: function (a) { return String(a.locationName || '').toLowerCase(); },
        seen: function (a) { return Date.parse(a.lastReportAt || 0) || 0; },

        loss: function (a) { return numOr(a, 'lossPct'); },
        latency: function (a) { return numOr(a, 'rttMs'); },
        jitter: function (a) { return numOr(a, 'jitterMs'); },

        // Behind first: the reason to sort by version is to find the
        // stragglers, and a column's first click sorts descending here — so
        // "behind" has to be the HIGH value, not the low one.
        version: function (a) {
          var adm = adminOf(a);
          var v = adm && adm.capabilities && adm.capabilities.agentVersion;
          if (!v) return '0';
          return (deps.isBehind(adm, deps.updateTarget(adm, versions)) ? '2' : '1') + v;
        },
        source: function (a) {
          var adm = adminOf(a);
          return String((adm && adm.monitor_config && adm.monitor_config.source) || 'proc');
        },
        quality: function (a) {
          var s = (a.quality && a.quality.status) || 'unknown';
          return { bad: 0, warn: 1, ok: 2, unknown: 3 }[s] != null ? { bad: 0, warn: 1, ok: 2, unknown: 3 }[s] : 3;
        },

        ports: function (a) { return numOr(a, 'ifaceCount'); },
        portFaults: function (a) { return numOr(a, 'ifaceIssues'); },
        link: function (a) {
          var s = metricsOf(a).ifaceStatus;
          return s && IFACE_RANK[s] != null ? IFACE_RANK[s] : 9;
        },
        nic: function (a) { var n = nicsOf(a); return n ? n.length : -1; },
        firmware: function (a) { return hasDrift(a) ? 0 : (nicsOf(a) ? 1 : 2); },
      };

      function ordered(list) {
        var s = sortState();
        if (s.key && SORTERS[s.key]) {
          var get = SORTERS[s.key];
          var dir = s.dir === 'asc' ? 1 : -1;
          return list.slice().sort(function (x, y) {
            var a = get(x);
            var b = get(y);
            if (a < b) return -1 * dir;
            if (a > b) return 1 * dir;
            return 0;
          });
        }
        // No column chosen: the Fleet-health card decides, and its whole purpose
        // is worst-first.
        return deps.getSortByHealth() ? F.sortByHealth(list) : list;
      }

      // ---- search -----------------------------------------------------------
      // One search box for the whole screen: it matches what the reader can see
      // in ANY set, so switching set never hides a row the search just found.
      function matches(a) {
        if (!state.q) return true;
        var adm = adminOf(a);
        var m = metricsOf(a);
        return [
          a.displayName, a.hostname, a.locationName,
          (a.health || {}).status, m.worstIface,
          adm && adm.platform, adm && adm.arch,
          adm && adm.monitor_config && adm.monitor_config.source,
          adm && adm.capabilities && adm.capabilities.agentVersion,
        ].filter(function (v) { return v != null; }).join(' ').toLowerCase().indexOf(state.q) >= 0;
      }

      // ---- the drawer -------------------------------------------------------
      // A row opens here rather than navigating: the reader keeps their filter,
      // their sort and their place in the list, and eighty per cent of lookups
      // end in this panel. The agent PAGE is one button away for the rest.
      function measurementBlock(a) {
        var m = metricsOf(a);
        var thr = a.throughput;
        return ui.keyValues([
          [t('fleet.col.loss'), num(m.lossPct, '%')],
          [t('fleet.col.latency'), deps.latencyText(m)],
          [t('fleet.col.jitter'), num(m.jitterMs, ' ms')],
          [t('fleet.col.targets'), m.targets ? m.reachable + '/' + m.targets : '–'],
          [t('fleet.col.speed'), deps.throughputText(thr)],
          // The probe timestamp lives here, beside the measurements it stamps,
          // rather than competing with the agent's last report in the table.
          [t('fleet.dw.measuredAt'), m.lastTs ? ui.fmt.short(m.lastTs) : '–'],
        ]);
      }

      function verdictBlock(a) {
        var h = a.health || {};
        var ev = Array.isArray(h.evidence) ? h.evidence.slice(0, 5) : [];
        var ack = ackOf(a);
        return el('div', {},
          el('p', {}, h.reason || t('fleet.dw.noVerdict')),
          ack
            ? el('p', { class: 'meta-xs' },
              t('fleet.ack.byAt', { by: ack.by || t('fleet.ack.someone'), at: ui.fmt.short(ack.at) })
              + (ack.note ? ' — ' + ack.note : ''))
            : null,
          ev.length
            ? el('ul', { class: 'dw-evidence' }, ev.map(function (e) {
              var bits = Object.keys(e)
                .filter(function (k) { return k !== 'metric' && e[k] != null && e[k] !== ''; })
                .map(function (k) { return k + ' ' + e[k]; });
              return el('li', {}, ui.metaXs(e.metric + (bits.length ? ' · ' + bits.join(' · ') : '')));
            }))
            : null);
      }

      // The drawer's version row carries the ACTION, not just the badge. An
      // amber "update" chip beside a version reads as a button and was not one:
      // the only way to act on it was the ⋯ menu in the row underneath the open
      // drawer, which is the one place the reader is not looking. An agent the
      // server cannot push to (Docker, bare process) still gets no button —
      // its badge says "installer", and the title says why.
      function updateAction(adm) {
        if (!adm || !deps.canDelete()) return null;
        var target = deps.updateTarget(adm, versions);
        var behind = deps.isBehind(adm, target);
        // A Windows agent gets its button either way — see updateEntry().
        if (!behind && !(deps.isWindows(adm) && !deps.selfUpdatable(adm))) return null;
        if (deps.selfUpdatable(adm)) {
          return ui.button('secondary', t('ag.act.update', { v: target }), {
            size: 'xs',
            onclick: function () { deps.update(adm, target); },
          });
        }
        // A Windows agent is not stuck: it updates in place from a one-liner
        // this dialog hands over.
        if (deps.isWindows(adm)) {
          return ui.button('secondary', behind ? t('agentUpdate.win.button') : t('ag.act.winReinstall'), {
            size: 'xs',
            onclick: function () { deps.windowsUpdate(adm, target); },
          });
        }
        return null;
      }

      function versionRow(a, adm) {
        var act = updateAction(adm);
        if (!act) return versionCell(a);
        return el('span', { class: 'dw-ver' }, versionCell(a), ' ', act);
      }

      function identityBlock(a) {
        var adm = adminOf(a);
        return ui.keyValues([
          adm ? [t('fleet.dw.platform'), (adm.platform || '?') + ' / ' + (adm.arch || '?')] : null,
          adm ? [t('ag.col.version'), versionRow(a, adm)] : null,
          adm ? [t('ag.col.source'), sourceCell(a)] : null,
          [t('fleet.col.location'), a.locationName || '–'],
          [t('fleet.dw.lastReport'), a.lastReportAt ? ui.fmt.short(a.lastReportAt) : '–'],
        ]);
      }

      // The port list is the drawer's own read — the only one it makes. It is
      // NOT polled: a five-second refresh under a table somebody is reading
      // takes the row out from under them.
      function portsSection(a) {
        var host = el('div', {}, ui.loadingState(4));
        function load() {
          host.replaceChildren(ui.loadingState(4));
          deps.fetchInterfaces(a.agentId).then(function (d) {
            host.replaceChildren(
              el('div', { class: 'meta-xs' }, d.ts
                ? t('iface.measured', { source: d.source, at: ui.fmt.clock(d.ts) })
                : t('iface.neverMeasured')),
              // The admin record goes with it: on a flow source the table is
              // empty by design, and its button changes THIS agent's source.
              // The NICs go with it too: the drawer used to carry a second
              // table saying which card sits behind each of these ports, and
              // joining two tables on the interface name was the reader's job.
              deps.interfaceTable(d.interfaces, d.source, adminOf(a), nicsOf(a)));
          }, function (e) {
            // A failed port read must not take the drawer with it: the verdict
            // and the measurements above are still true and still useful.
            host.replaceChildren(ui.errorState({
              title: e && e.status === 404 ? t('fleet.dw.ports404') : t('iface.err.title'),
              body: deps.errText(e),
              detail: 'GET /api/interfaces',
              onRetry: e && e.status === 404 ? null : load,
            }));
          });
        }
        load();
        return el('div', {},
          el('div', { class: 'dw-sec-act' },
            ui.button('ghost', t('iface.refresh'), { size: 'xs', onclick: load })),
          host);
      }

      // A verdict worth claiming. `ok` needs no acknowledgement and `unknown`
      // (an agent that has never reported) must not be clearable — the server
      // refuses both, and offering the button would only earn a 409.
      var ACKABLE = { warn: 1, bad: 1, down: 1, stale: 1 };

      // "Somebody is on this." It does NOT clear the fault: the verdict is
      // recomputed from live measurements and goes green when they do. What it
      // clears is the question "has anyone looked at this red row", which until
      // now the screen had no way to answer — so every shift re-diagnosed the
      // same known problem.
      function ackButton(a, onChanged) {
        if (!deps.canWrite() || !deps.ackHealth || !deps.unackHealth) return null;
        var status = (a.health && a.health.status) || '';
        if (!ackOf(a) && !ACKABLE[status]) return null;
        var btn = ui.button('secondary', ackOf(a) ? t('fleet.ack.clear') : t('fleet.ack.do'), {
          title: ackOf(a) ? t('fleet.ack.clearHint') : t('fleet.ack.doHint'),
          onclick: function () {
            btn.disabled = true;
            var undo = !!ackOf(a);
            var p = undo ? deps.unackHealth(a.agentId) : deps.ackHealth(a.agentId);
            p.then(function (health) {
              // The POST answers with the verdict as stored, so the drawer shows
              // what the server actually holds rather than what it hoped for. An
              // undo has no body, so the marker is dropped locally.
              if (health) a.health = health;
              else if (a.health) { var h = {}; Object.keys(a.health).forEach(function (k) { if (k !== 'ack') h[k] = a.health[k]; }); a.health = h; }
            }).catch(function () { /* app.js has already said what went wrong */ })
              .then(function () {
                btn.disabled = false;
                btn.textContent = ackOf(a) ? t('fleet.ack.clear') : t('fleet.ack.do');
                btn.title = ackOf(a) ? t('fleet.ack.clearHint') : t('fleet.ack.doHint');
                if (onChanged) onChanged();
              });
          },
        });
        return btn;
      }

      function openRowDrawer(a, tr) {
        var adm = adminOf(a);
        deps.setDrawerAgent(a.agentId);
        var ctx = deps.contextActions ? deps.contextActions({ agentId: Number(a.agentId) }) : null;
        // The two places the acknowledgement shows are patched in place rather
        // than reopening the drawer: reopening would throw away the reader's
        // scroll position and re-read the port table for nothing.
        var statusHost = el('span', {}, healthCell(a));
        var verdictHost = el('div', {}, verdictBlock(a));
        var ack = ackButton(a, function () {
          statusHost.replaceChildren(healthCell(a));
          verdictHost.replaceChildren(verdictBlock(a));
          drawTable();
        });
        ui.openDrawer({
          title: a.displayName,
          status: statusHost,
          meta: [a.hostname, a.locationName || null,
            a.lastReportAt ? t('fleet.dw.seenAt', { at: ui.fmt.short(a.lastReportAt) }) : null]
            .filter(Boolean).join(' · '),
          row: tr || null,
          onClose: function () { deps.setDrawerAgent(null); },
          sections: [
            ui.drawerSection(t('fleet.dw.verdict'), verdictHost),
            ui.drawerSection(t('fleet.dw.measurements'), measurementBlock(a)),
            ui.drawerSection(t('fleet.dw.ports') + (portCount(a) ? ' (' + portCount(a) + ')' : ''),
              portsSection(a)),
            ui.drawerSection(t('fleet.dw.identity'), identityBlock(a)),
            ctx ? ui.drawerSection(t('ctx.label'), ctx) : null,
          ],
          footer: ui.drawerFooter(
            [ui.button('secondary', t('fleet.dw.open'), { onclick: function () { deps.openAgent(a.agentId); } }), ack],
            adm && deps.canWrite()
              ? [ui.button('primary', t('ag.act.run'), { onclick: function () { deps.runTest(adm); } })]
              : []),
        });
      }

      // ---- the table --------------------------------------------------------
      function drawTable() {
        // No data means either the first paint (the loading skeleton is up) or a
        // failed read (the ErrorState is up). Neither is improved by clearing it.
        if (!data) return;
        var agents = data.agents || [];
        var total = summaryTotal(data.summary) || agents.length;
        if (!total) {
          tableHost.replaceChildren(ui.panel({
            title: t('fleet.panel'),
            children: [ui.emptyState({
              icon: '◎',
              title: t('fleet.noAgents'),
              body: t('fleet.noAgentsHint'),
              action: ui.button('secondary', t('fleet.openEnrollment'), {
                onclick: function () { deps.gotoView('enrollment'); },
              }),
            })],
          }));
          return;
        }
        var filtered = F.applyFilter(agents, deps.filter()).filter(matches);
        var narrowed = F.isActive(deps.filter()) || !!state.q;
        var s = sortState();
        tableHost.replaceChildren(ui.panel({
          title: t('fleet.panel'),
          note: narrowed
            ? t('fleet.countFiltered', { shown: filtered.length, total: total })
            : t('fleet.count', { total: total }),
          children: [
            filtered.length ? ui.dataTable({
              columns: columns(),
              rows: ordered(filtered).map(toRow),
              sort: s.key ? s : null,
              onSort: function (key) {
                state.sort[set()] = s.key === key
                  ? { key: key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
                  : { key: key, dir: 'desc' };
                drawTable();
              },
              onOpen: function (row, tr) { openRowDrawer(row.a, tr); },
            }) : ui.emptyState({
              title: t('fleet.noMatch'),
              body: t('fleet.noMatchHint'),
              action: ui.button('secondary', t('fleet.clearFilters'), {
                onclick: function () {
                  deps.setFilter(F.emptyState());
                  state.q = '';
                  search.value = '';
                  draw();
                },
              }),
            }),
          ],
        }));
      }

      // The NOC header, the traffic map and the issues rollup answer "how is the
      // estate right now", so they belong to the Health set. On Drift and
      // Hardware they would be three panels about a different question.
      function drawContext() {
        var on = set() === 'health';
        nocHost.hidden = !on;
        trafficHost.hidden = !on;
        issuesHost.hidden = !on;
      }

      function draw() {
        deps.syncUrl();
        drawHead();
        drawStrip();
        drawSets();
        drawToolbar();
        drawTable();
        drawContext();
      }

      // ---- refresh ----------------------------------------------------------
      function refresh() {
        return deps.fetchHealth(data)
          .then(function (d) {
            data = d;
            nocHost.replaceChildren(deps.noc(data));
            draw();
          })
          .catch(function (e) {
            tableHost.replaceChildren(ui.panel({
              title: t('fleet.panel'),
              children: [ui.errorState({
                title: t('fleet.err.title'),
                body: deps.errText(e),
                detail: 'GET /api/fleet/health',
                onRetry: refresh,
              })],
            }));
          });
      }

      // The deployment read. Best-effort on purpose: without it the Drift set
      // and the row actions are simply absent, and the measurements — the
      // reason most people open this screen — are still there.
      function loadAdmin() {
        return deps.fetchAgents().then(function (d) {
          var by = {};
          (d.agents || []).forEach(function (a) { by[a.id] = a; });
          adminById = by;
          versions = d.versions || versions;
        }, function () { adminById = null; });
      }

      function loadNics() {
        return deps.fetchNics().then(function (inv) {
          var by = {};
          (inv.byAgent || []).forEach(function (a) { by[a.id] = a.nics || []; });
          var out = {};
          (inv.drift || []).forEach(function (model) {
            (model.firmwares || []).forEach(function (f) {
              if (!f.isOutlier) return;
              (f.agents || []).forEach(function (ag) { out[ag.id] = true; });
            });
          });
          nicByAgentId = by;
          nicOutliers = out;
        }, function () { nicByAgentId = null; nicOutliers = null; });
      }

      tableHost.replaceChildren(ui.panel({ title: t('fleet.panel'), children: [ui.loadingState(6)] }));
      trafficHost.append(deps.trafficMap());
      deps.maintenance().then(drawNotes, function () { drawNotes([]); });
      deps.issues().then(function (node) { issuesHost.replaceChildren.apply(issuesHost, node ? [node] : []); },
        function () { issuesHost.replaceChildren(); });

      return Promise.all([refresh(), loadAdmin(), loadNics()]).then(function () {
        draw();
        // A link with ?agent=12 opens on that agent: the drawer is part of the
        // address, so a reload or a pasted link lands on the same thing.
        var want = deps.drawerAgent();
        if (want != null) {
          var hit = ((data && data.agents) || []).filter(function (a) { return String(a.agentId) === String(want); })[0];
          if (hit) openRowDrawer(hit, null);
          else deps.setDrawerAgent(null);
        }
        deps.startPolling(refresh);
        return page;
      });
    }

    return { view: view };
  }

  var apiObj = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.FleetView = apiObj;
})(typeof window !== 'undefined' ? window : null);
