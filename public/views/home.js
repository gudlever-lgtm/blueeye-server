// public/views/home.js — Overview, as a DashboardPage (template B).
//
// The landing screen, and the answer to one question: is the network all
// right, and if not, where do I go next? The dashboard has twenty-odd
// screens; arriving on any one of them means reading a list before knowing
// whether there is anything to read. This page is the layer above them —
// counts first, then the three lists that are worth looking at on arrival,
// each row a link into the screen that owns it.
//
// It adds no server surface: the three reads are the ones the Fleet,
// Troubleshooting and Changes screens already make, and app.js hands them in.
// Each read is independent and best-effort — a source that fails takes its own
// panel down and says so, rather than blanking the screen a shift starts on.
//
// Repo convention: createX(deps). app.js passes its own helpers in.

(function (root) {
  'use strict';

  // ---- the priority queue -------------------------------------------------
  //
  // ONE ranked list, built from the records that already exist. The page used
  // to show three lists side by side — root causes, unhealthy agents, recent
  // changes — which left the reader to work out which of the three mattered
  // most this minute. That is the one question somebody opening a NOC screen
  // cannot answer for themselves, because it needs all three lists at once.
  //
  // Nothing new is stored and no new endpoint exists: a row IS a situation
  // (event_clusters), an event (event_cases) or a correlated root cause, and
  // opening it opens that record, with its own status, history and work log.
  //
  // The score, and why each term is in it (docs/mission-control.md):
  //
  //   severity    ×1000  CRIT before WARN before INFO. Nothing outranks it.
  //   impact      ×50    how many devices or members it covers, capped at 9 —
  //                      past that the difference stops being actionable.
  //   unattended  +300   nobody has picked it up. An open thing outranks one
  //                      somebody is already on, which is the whole point of
  //                      a queue.
  //   evidence    +120   OBSERVED outranks SUSPECTED at the same severity. A
  //                      hypothesis is worth showing and worth showing lower.
  //   age         +hours capped at 24. A tie-breaker, not a driver: an old
  //                      INFO must never climb over a fresh CRIT.
  //
  // Impact here is what the system COMPUTED, never what anyone verified — the
  // row says "affects N devices", not "N devices are down".
  var SEV_RANK = { CRIT: 3, WARN: 2, INFO: 1 };

  // Catalogue keys for the things the queue names. Through a map, never
  // concatenated at the t() call: the gate sweeps the source for literal keys,
  // and a key it cannot see is a key nobody notices is missing from a locale.
  var SOURCE_LABEL = {
    fleet: 'home.source.fleet',
    tshoot: 'home.source.tshoot',
    changes: 'home.source.changes',
    events: 'home.source.events',
    situations: 'home.source.situations',
  };
  var STATUS_LABEL = {
    open: 'home.queue.state.open',
    investigating: 'home.queue.state.investigating',
    acknowledged: 'home.queue.state.acknowledged',
  };

  function hoursSince(iso, now) {
    var ms = Date.parse(iso || '');
    if (!isFinite(ms)) return 0;
    return Math.max(0, (now - ms) / 3600000);
  }

  function score(row, now) {
    var sev = SEV_RANK[row.severity] || 1;
    var impact = Math.min(9, Number(row.impactCount) || 0);
    return sev * 1000
      + impact * 50
      + (row.attended ? 0 : 300)
      + (row.basis === 'observed' ? 120 : 0)
      + Math.min(24, hoursSince(row.since, now));
  }

  // Everything that wants a technician's attention, worst first. Pure, and
  // exported — the ordering is the product decision on this screen, so it is
  // tested directly rather than through five panels of DOM.
  function attentionRows(src) {
    var now = src.now || Date.now();
    var rows = [];

    // 1. Situations — findings correlated ACROSS agents. The widest thing the
    //    analysis knows about, so it leads at equal severity.
    (src.situations || []).forEach(function (c) {
      rows.push({
        kind: 'situation',
        id: c.id,
        severity: c.alertLastSeverity || 'WARN',
        title: c.suspectedCommonCause || null,
        impactCount: Number(c.alertMemberCount) || (c.memberFindingIds || []).length,
        since: c.detectedAt,
        status: c.status,
        attended: c.status === 'acknowledged',
        // A cluster's cause is a SUSPICION the correlator formed; its
        // confidence is the correlator's own, and it travels with the row.
        basis: 'suspected',
        confidence: c.confidence || null,
      });
    });

    // 2. Events — the per-device cases an operator actually works, with the
    //    status and the work log already on them.
    (src.events || []).forEach(function (e) {
      if (e.status !== 'open' && e.status !== 'investigating') return;
      rows.push({
        kind: 'event',
        id: e.id,
        severity: e.severity || 'WARN',
        title: e.title || null,
        where: e.agentName || e.agentHostname || null,
        site: e.locationName || null,
        impactCount: 1,
        since: e.firstEventAt,
        status: e.status,
        attended: e.status === 'investigating',
        // A case is grouped from findings that fired — measured, not guessed.
        basis: 'observed',
      });
    });

    // 3. Root causes — the live correlation from Troubleshooting. A
    //    hypothesis by construction, and labelled as one.
    (src.causes || []).forEach(function (rc, i) {
      rows.push({
        kind: 'cause',
        id: rc.id != null ? rc.id : 'rc' + i,
        severity: rc.severity || 'WARN',
        title: rc.cause || null,
        impactCount: (rc.affectedDeviceIds || []).length,
        since: rc.firstSeen,
        status: null,
        attended: false,
        basis: 'suspected',
      });
    });

    // 4. Offline agents — not a measurement, the ABSENCE of one. It belongs
    //    here because somebody has to act on it, and it is CRIT because
    //    every other number from that site is now unknown rather than fine.
    (src.agents || []).forEach(function (a) {
      if (a.online) return;
      rows.push({
        kind: 'agent',
        id: a.agentId,
        severity: 'CRIT',
        title: a.displayName || a.hostname || String(a.agentId),
        site: a.locationName || null,
        impactCount: 1,
        since: a.lastReportAt,
        status: null,
        attended: false,
        // Nothing is being measured here, so there is nothing to observe.
        basis: 'nodata',
      });
    });

    rows.forEach(function (r) { r.score = score(r, now); });
    rows.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      // A stable tail, so two equal rows do not swap places on every poll.
      return String(a.kind + a.id) < String(b.kind + b.id) ? -1 : 1;
    });
    return rows;
  }

  function create(deps) {
    var el = deps.el;
    var t = deps.t;
    var ui = deps.ui;

    var SEV_TONE = { CRIT: 'crit', WARN: 'warn', INFO: 'info' };
    // How many rows each list shows. The point of the page is the shortlist;
    // every panel's footer action opens the full screen.
    var ROWS = 6;

    // A key built from data goes through a variable, never concatenated inside
    // the translate call: the gate sweeps the source for literal keys.
    function severityLabel(sev) { var k = 'changes.group.' + sev; var v = t(k); return v === k ? String(sev) : v; }

    function view() {
      var page = ui.page();
      var stripHost = el('div', {});
      var noteHost = el('div', {});
      var queueHost = el('div', {});
      var gapHost = el('div', {});
      var changeHost = el('div', {});
      // One slot per source: null until it answers, an Error when it failed.
      // Five now: the ranked queue needs the situations and the events as well,
      // and each of the five still stands on its own — one failing takes its own
      // contribution out and SAYS so, rather than quietly shortening the queue.
      var SOURCES = ['fleet', 'tshoot', 'changes', 'events', 'situations'];
      var data = {};
      var failed = {};
      SOURCES.forEach(function (k) { data[k] = null; failed[k] = null; });

      var info = deps.help();
      var refresh = ui.button('secondary', t('home.refresh'), { onclick: function () { load(); } });
      page.append(ui.pageHeader({
        title: t('home.title'),
        lead: t('home.lead'),
        help: { title: info.title, body: info.body },
        actions: [refresh],
      }), stripHost, noteHost, queueHost, gapHost, changeHost);

      // ---- the counts --------------------------------------------------------
      function drawStrip() {
        var f = (data.fleet && data.fleet.summary) || {};
        var s = (data.tshoot && data.tshoot.summary) || {};
        var ch = (data.changes && data.changes.events) || [];
        var problems = (Number(f.bad) || 0) + (Number(f.down) || 0) + (Number(f.warn) || 0);
        var hint = t('home.stat.hint');
        var cards = [
          { value: data.fleet ? (f.total || 0) : '—', label: t('home.stat.agents'), title: hint, onclick: function () { deps.go('fleet'); } },
          {
            value: data.fleet ? (f.offline || 0) : '—', label: t('home.stat.offline'),
            tone: f.offline ? 'crit' : undefined, title: hint, onclick: function () { deps.go('fleet'); },
          },
          {
            value: data.fleet ? problems : '—', label: t('home.stat.problems'),
            tone: problems ? 'warn' : undefined, title: hint, onclick: function () { deps.go('fleet'); },
          },
          {
            value: data.tshoot ? (s.rootCauses || 0) : '—', label: t('home.stat.causes'),
            tone: s.rootCauses ? 'crit' : undefined, title: hint, onclick: function () { deps.go('troubleshooting'); },
          },
          {
            value: data.tshoot ? (s.activeFaults || 0) : '—', label: t('home.stat.faults'),
            tone: s.activeFaults ? 'warn' : undefined, title: hint, onclick: function () { deps.go('troubleshooting'); },
          },
          { value: data.changes ? ch.length : '—', label: t('home.stat.changes'), title: hint, onclick: function () { deps.go('changes'); } },
        ];
        stripHost.replaceChildren(ui.statStrip(cards));
      }

      // A count whose source failed reads as a dash above, and the note says
      // which source — never a reassuring zero.
      function drawNote() {
        var out = [];
        Object.keys(failed).forEach(function (k) { if (failed[k]) out.push(t('home.source.' + k)); });
        var partial = data.tshoot && data.tshoot.partial;
        if (!out.length && !partial) { noteHost.replaceChildren(); return; }
        noteHost.replaceChildren(ui.inlineNote(out.length
          ? t('home.note.failed', { sources: out.join(', ') })
          : t('home.note.partial'), 'warn'));
      }

      // ---- a panel that knows its source may have failed --------------------
      function sourcePanel(key, title, action, build) {
        var body;
        if (failed[key]) {
          body = ui.errorState({
            title: t('home.err.title'),
            body: deps.errText(failed[key]),
            detail: deps.endpoint[key],
            onRetry: load,
          });
        } else if (!data[key]) body = ui.loadingState(3);
        else body = build();
        return ui.panel({ title: title, actions: [action], children: [body] });
      }

      // ---- the queue ----------------------------------------------------------
      // A panel whose body needs SEVERAL sources: it draws what answered and
      // says which sources are missing from it, rather than failing whole.
      function multiPanel(keys, title, action, build) {
        var down = keys.filter(function (k) { return failed[k]; });
        var waiting = keys.filter(function (k) { return !failed[k] && !data[k]; });
        if (down.length === keys.length) {
          return ui.panel({
            title: title,
            actions: [action],
            children: [ui.errorState({
              title: t('home.err.title'),
              body: deps.errText(failed[keys[0]]),
              detail: deps.endpoint[keys[0]],
              onRetry: load,
            })],
          });
        }
        if (waiting.length === keys.length) {
          return ui.panel({ title: title, actions: [action], children: [ui.loadingState(3)] });
        }
        var kids = [];
        if (down.length) {
          kids.push(ui.inlineNote(t('home.queue.incomplete', {
            sources: down.map(function (k) { return t(SOURCE_LABEL[k]); }).join(', '),
          }), 'warn'));
        }
        kids.push(build());
        return ui.panel({ title: title, actions: [action], children: kids });
      }

      // Opens the RECORD behind a row, which is where its status, its history
      // and its work log live. A root cause has no record of its own yet, so it
      // opens the screen that owns the correlation.
      function openRow(row) {
        if (row.kind === 'situation' && deps.openCluster) return deps.openCluster(row.id);
        if (row.kind === 'event' && deps.openEvent) return deps.openEvent(row.id);
        if (row.kind === 'agent') return deps.openAgent(row.id);
        return deps.go('troubleshooting');
      }

      // What the row IS, so nobody has to guess whether they are reading a
      // measurement or a theory about one.
      var KIND_LABEL = {
        situation: 'home.queue.kind.situation',
        event: 'home.queue.kind.event',
        cause: 'home.queue.kind.cause',
        agent: 'home.queue.kind.agent',
      };
      // Observed / suspected / no data. The middle one is the reason this
      // column exists: a suspected cause presented like a measured one is how
      // a technician ends up replacing the wrong switch.
      var BASIS = {
        observed: { tone: 'neutral', label: 'home.basis.observed', hint: 'home.basis.observedHint' },
        suspected: { tone: 'warn', label: 'home.basis.suspected', hint: 'home.basis.suspectedHint' },
        nodata: { tone: 'neutral', label: 'home.basis.nodata', hint: 'home.basis.nodataHint' },
      };

      function rowTitle(row) {
        if (row.title) return String(row.title);
        var k = KIND_LABEL[row.kind];
        return k ? t(k) : String(row.kind);
      }

      function rowWhere(row) {
        var parts = [];
        if (row.where) parts.push(String(row.where));
        if (row.site) parts.push(String(row.site));
        if (!parts.length && row.impactCount > 1) return t('home.causes.devices', { n: row.impactCount });
        return parts.length ? parts.join(' · ') : '—';
      }

      function drawQueue() {
        queueHost.replaceChildren(multiPanel(
          ['situations', 'events', 'tshoot', 'fleet'],
          t('home.queue.title'),
          ui.button('secondary', t('home.queue.all'), { size: 'xs', onclick: function () { deps.go('events'); } }),
          function () {
            var rows = attentionRows({
              situations: (data.situations && data.situations.clusters) || [],
              events: (data.events && data.events.events) || [],
              causes: (data.tshoot && data.tshoot.rootCauses) || [],
              agents: (data.fleet && data.fleet.agents) || [],
            });
            if (!rows.length) {
              // "Nothing in the queue" is only the truth when every source
              // answered. With one down it is "nothing we could see", and the
              // note above this body already says which source is missing.
              var allIn = ['situations', 'events', 'tshoot', 'fleet'].every(function (k) { return !failed[k]; });
              return ui.emptyState({
                kind: allIn ? 'ok' : 'nodata',
                title: allIn ? t('home.queue.empty') : t('home.queue.emptyPartial'),
                body: allIn ? t('home.queue.emptyBody') : t('home.queue.emptyPartialBody'),
              });
            }
            return ui.dataTable({
              columns: [
                { key: 'sev', label: t('home.col.sev'), width: '92px' },
                { key: 'what', label: t('home.col.what') },
                { key: 'basis', label: t('home.col.basis'), width: '120px' },
                { key: 'where', label: t('home.col.where'), width: '22%' },
                { key: 'for', label: t('home.col.for'), width: '110px' },
                { key: 'state', label: t('home.col.state'), width: '120px' },
              ],
              rows: rows.slice(0, ROWS).map(function (row) {
                var basis = BASIS[row.basis] || BASIS.observed;
                var state = row.status
                  ? ui.badge(row.attended ? 'info' : 'neutral', t(STATUS_LABEL[row.status] || 'home.queue.state.open'))
                  : ui.metaXs('—');
                return {
                  key: row.kind + ':' + row.id,
                  cells: {
                    sev: ui.badge(SEV_TONE[row.severity] || 'info', severityLabel(row.severity)),
                    what: ui.hostLink(rowTitle(row), function () { openRow(row); }),
                    basis: ui.badge(basis.tone, t(basis.label)),
                    where: ui.metaXs(rowWhere(row)),
                    for: ui.metaXs(row.since ? ui.fmt.rel(row.since) : '—'),
                    state: state,
                  },
                  title: t(basis.hint),
                };
              }),
            });
          }
        ));
      }

      // ---- what we cannot see -------------------------------------------------
      // The honest counterpart to the queue. An agent that is offline, stale or
      // degraded is not a healthy agent with a warning badge: every number that
      // came from it is now UNKNOWN, and a screen that shows the last value it
      // sent as if it were current is worse than one that shows nothing.
      function drawGaps() {
        gapHost.replaceChildren(sourcePanel('fleet', t('home.gaps.title'),
          ui.button('secondary', t('home.agents.all'), { size: 'xs', onclick: function () { deps.go('fleet'); } }),
          function () {
            var agents = data.fleet.agents || [];
            var blind = agents.filter(function (a) {
              return !a.online || ((a.health && a.health.status) || 'ok') !== 'ok';
            });
            if (!blind.length) {
              return ui.emptyState({ kind: 'ok', title: t('home.gaps.empty'), body: t('home.gaps.emptyBody') });
            }
            var lead = ui.inlineNote(t('home.gaps.lead', {
              blind: blind.length, total: agents.length,
            }), 'warn');
            var table = ui.dataTable({
              columns: [
                { key: 'agent', label: t('home.col.agent') },
                { key: 'data', label: t('home.col.data'), width: '130px' },
                { key: 'health', label: t('home.col.health'), width: '120px' },
                { key: 'site', label: t('home.col.site'), width: '22%' },
                { key: 'seen', label: t('home.col.seen'), width: '140px' },
              ],
              rows: blind.slice(0, ROWS).map(function (a) {
                return {
                  key: String(a.agentId),
                  cells: {
                    agent: ui.hostLink(String(a.displayName || a.hostname || a.agentId), function () { deps.openAgent(a.agentId); }),
                    // Offline = nothing is arriving. Online but not OK = what
                    // arrives cannot be relied on. Neither is "fine".
                    data: a.online
                      ? ui.badge('warn', t('home.gaps.state.partial'))
                      : ui.badge('crit', t('home.gaps.state.none')),
                    health: a.online ? deps.healthBadge(a.health) : ui.badge('neutral', t('home.agents.offline')),
                    site: ui.metaXs(a.locationName || '—'),
                    seen: ui.metaXs(a.lastReportAt ? ui.fmt.rel(a.lastReportAt) : t('home.agents.never')),
                  },
                };
              }),
            });
            return el('div', {}, lead, table);
          }));
      }

      // ---- what changed ------------------------------------------------------
      function drawChanges() {
        changeHost.replaceChildren(sourcePanel('changes', t('home.changes.title'),
          ui.button('secondary', t('home.changes.all'), { size: 'xs', onclick: function () { deps.go('changes'); } }),
          function () {
            var events = (data.changes.events || []).slice(0, ROWS);
            if (!events.length) {
              return ui.emptyState({ kind: 'nodata', title: t('home.changes.empty'), body: t('home.changes.emptyBody') });
            }
            return ui.dataTable({
              columns: [
                { key: 'sev', label: t('home.col.sev'), width: '120px' },
                { key: 'what', label: t('home.col.what') },
                { key: 'when', label: t('home.col.when'), width: '140px' },
              ],
              rows: events.map(function (ev, i) {
                return {
                  key: String(ev.ackKey || i),
                  cells: {
                    sev: ui.badge(SEV_TONE[ev.severity] || 'info', severityLabel(ev.severity)),
                    what: ui.hostLink(String(ev.summary || '—'), function () { deps.go('changes'); }),
                    when: ui.metaXs(ui.fmt.short(ev.timestamp)),
                  },
                };
              }),
            });
          }));
      }

      function drawAll() {
        drawStrip();
        drawNote();
        drawQueue();
        drawGaps();
        drawChanges();
      }

      // Three independent reads: one failure never stops the other two, which
      // is the whole reason this page is worth arriving on.
      function load() {
        refresh.disabled = true;
        data = {};
        failed = {};
        SOURCES.forEach(function (k) { data[k] = null; failed[k] = null; });
        drawAll();
        var one = function (key) {
          return Promise.resolve()
            .then(function () { return deps.fetch[key](); })
            .then(function (res) { data[key] = res || {}; })
            .catch(function (e) { failed[key] = e; });
        };
        return Promise.all(SOURCES.map(one))
          .then(function () { refresh.disabled = false; drawAll(); });
      }

      load();
      return Promise.resolve(page);
    }

    return { view: view };
  }

  // attentionRows is exported so the ORDERING can be tested as the product
  // decision it is, rather than inferred from five panels of DOM.
  var apiObj = { create: create, attentionRows: attentionRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.HomePage = apiObj;
})(typeof window !== 'undefined' ? window : null);
