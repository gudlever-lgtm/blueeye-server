// public/timelineView.js — pure, framework-free helpers for the per-target
// timeline view (Phase 2) and the finding "what changed before this" list
// (Phase 3). NO DOM here: this is the state/mapping logic the renderer switches
// on, factored out so it can be unit-tested under `node --test` (the dashboard
// has no build step and no browser test harness).
//
// Dual export: attaches to `window.TimelineView` in the browser (loaded as a
// plain <script> before app.js) and to `module.exports` under Node (tests).

(function (root) {
  'use strict';

  var SEVERITIES = { INFO: 1, WARN: 1, CRIT: 1 };

  // Normalised-severity → badge CSS class (reuses the existing .badge palette).
  function severityClass(sev) {
    var s = String(sev == null ? 'INFO' : sev).toUpperCase();
    return SEVERITIES[s] ? s : 'INFO';
  }

  // Source → the chip a row wears. Every source the feeds emit needs an entry:
  // a miss falls through to the raw key, and a row labelled `incident_case`
  // is the dashboard leaking a table name at the reader.
  //
  // TERMINOLOGY: BlueEyes emits **events**. An event is a correlated condition on
  // a device (the `incident_cases` table, historically named) — it is what an
  // ITSM *incident* would be opened FROM, not the incident itself. `probe` is the
  // active-probe outage record (the `incidents` table, migration 025), and
  // `cluster` is a Situation: one condition seen across several devices.
  var SOURCE_LABELS = {
    finding: 'Finding', agent: 'Agent', playbook: 'Playbook',
    config: 'Config change', status: 'State change', topology: 'Topology change',
    event: 'Event', probe: 'Probe outage', cluster: 'Situation', interface: 'Interface',
    // Legacy source keys, kept so an older cached payload still renders a label
    // rather than a table name.
    incident: 'Event', incident_case: 'Event',
  };
  function sourceLabel(source) { return SOURCE_LABELS[source] || String(source == null ? '—' : source); }

  // Time-range presets for the selector. `custom` carries no ms (the caller
  // supplies explicit from/to).
  var RANGE_PRESETS = [
    { key: '1h', label: 'Last 1h', ms: 3600 * 1000 },
    { key: '24h', label: 'Last 24h', ms: 24 * 3600 * 1000 },
    { key: '7d', label: 'Last 7d', ms: 7 * 24 * 3600 * 1000 },
    { key: 'custom', label: 'Custom', ms: null },
  ];

  // Resolve a preset (+ optional custom bounds) to an ISO { from, to } window.
  // `nowMs` is injectable for tests. Returns null for an incomplete/invalid
  // custom range so the caller can prompt instead of firing a bad request.
  function rangeToWindow(key, nowMs, customFrom, customTo) {
    if (key === 'custom') {
      if (!customFrom || !customTo) return null;
      var cf = new Date(customFrom);
      var ct = new Date(customTo);
      if (isNaN(cf.getTime()) || isNaN(ct.getTime()) || cf.getTime() > ct.getTime()) return null;
      return { from: cf.toISOString(), to: ct.toISOString() };
    }
    var preset = null;
    for (var i = 0; i < RANGE_PRESETS.length; i += 1) {
      if (RANGE_PRESETS[i].key === key) { preset = RANGE_PRESETS[i]; break; }
    }
    var ms = preset && preset.ms ? preset.ms : RANGE_PRESETS[1].ms; // default 24h
    return { from: new Date(nowMs - ms).toISOString(), to: new Date(nowMs).toISOString() };
  }

  // Build the endpoint query string from a window (+ optional limit).
  function timelineQuery(win, limit) {
    var parts = [];
    if (win && win.from) parts.push('from=' + encodeURIComponent(win.from));
    if (win && win.to) parts.push('to=' + encodeURIComponent(win.to));
    if (limit) parts.push('limit=' + encodeURIComponent(limit));
    return parts.length ? '?' + parts.join('&') : '';
  }

  // The single source of truth for WHICH state to render. Given the async phase
  // (loading), an error, and the API payload, returns a descriptor the renderer
  // switches on — so state selection (loading/error/empty/ready, + the partial
  // flag) is testable without a DOM. Empty is a first-class state, never an error.
  function resolveState(input) {
    input = input || {};
    if (input.loading) return { state: 'loading' };
    if (input.error) {
      return { state: 'error', message: (input.error && input.error.message) || 'Failed to load timeline.' };
    }
    var data = input.data || {};
    var events = Array.isArray(data.events) ? data.events : [];
    var partial = !!data.partial;
    var failedSources = Array.isArray(data.failedSources) ? data.failedSources : [];
    if (events.length === 0) return { state: 'empty', partial: partial, failedSources: failedSources };
    return { state: 'ready', events: events, partial: partial, failedSources: failedSources };
  }

  // The part of a dotted type worth showing next to a source chip that already
  // says where the row came from. `finding.probe.latency` on a row already chipped
  // "Anomaly" only needs `probe.latency`; `event.open` only needs `open`.
  function typeDetail(type, source) {
    var t = String(type == null ? '' : type);
    var s = String(source == null ? '' : source);
    if (s && t.slice(0, s.length + 1) === s + '.') return t.slice(s.length + 1);
    return t;
  }

  // Whether the type chip earns its place. Once the source prefix is stripped, a
  // type the summary already spells out is pure duplication — and it was rendering
  // as one run-together word ("finding.probe.latencyprobe.latency on core-sw"),
  // which is worse than merely redundant.
  //
  // Matched on WORD BOUNDARIES, not as a bare substring: a short detail like
  // "open" occurs inside "Copenhagen", and a site name must never be able to
  // suppress a status chip. Dots are escaped so `probe.latency` matches literally.
  function typeIsInformative(type, source, summary) {
    var detail = typeDetail(type, source);
    if (!detail) return false;
    var escaped = detail.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp('\\b' + escaped + '\\b').test(String(summary || '').toLowerCase());
  }

  // Map a normalised timeline event to a flat row view-model (what the row
  // renderer needs, already sanitised).
  function rowModel(e) {
    e = e || {};
    var summary = e.summary || e.type || '';
    var source = e.source || null;
    return {
      time: e.timestamp || null,
      source: source,
      sourceLabel: sourceLabel(source),
      type: e.type || '',
      // What the type chip actually shows, and whether to show it at all.
      typeDetail: typeDetail(e.type, source),
      showType: typeIsInformative(e.type, source, summary),
      severity: severityClass(e.severity),
      summary: summary,
      // Correlation fields (changes feed). Absent on the per-target timelines,
      // where every row stands for exactly one record.
      count: Number(e.count) > 1 ? Number(e.count) : 1,
      firstAt: e.firstAt || null,
      family: e.family || null,
      findingCount: Number(e.findingCount) > 0 ? Number(e.findingCount) : 0,
      refId: e.ref_id != null ? e.ref_id : null,
      // The agent this event concerns. Present on cross-agent (cluster) timelines
      // so each row can deep-link to its OWN target; null/absent on single-target
      // timelines (the caller passes a fixed agentId instead).
      target: e.target != null ? e.target : null,
    };
  }

  // Deep-link target for a row. Every event belongs to one agent, and the agent
  // (device) detail page is the existing view that aggregates its findings,
  // probes and incidents — so that is the click-through target. (There are no
  // per-record detail pages for findings/probe-incidents/playbook-runs yet; when
  // they exist this is where per-source routing would go, keyed off source +
  // refId.)
  function deepLink(event, agentId) {
    if (agentId == null) return null;
    return { view: 'agent', id: agentId, source: event ? event.source : null, refId: event ? event.ref_id : null };
  }

  // Distinct sources present in an event list, in first-seen order — powers the
  // "filter by source" control on the cluster timeline.
  function distinctSources(events) {
    var seen = {}; var out = [];
    (Array.isArray(events) ? events : []).forEach(function (e) {
      if (e && e.source && !seen[e.source]) { seen[e.source] = 1; out.push(e.source); }
    });
    return out;
  }

  // Filter an event list to one source (empty/null source → all events).
  function filterBySource(events, source) {
    if (!source) return Array.isArray(events) ? events.slice() : [];
    return (Array.isArray(events) ? events : []).filter(function (e) { return e && e.source === source; });
  }

  // Human notice for a partial response (some sources unavailable). Never hidden.
  function partialNotice(failedSources) {
    var list = Array.isArray(failedSources) && failedSources.length ? failedSources.join(', ') : 'some sources';
    return 'Some data sources were unavailable (' + list + '); this timeline may be incomplete.';
  }

  // --- render layer (DOM) ---------------------------------------------------
  // Kept here (taking an injected `document`) rather than in app.js so the
  // rendered output is unit-testable under jsdom — the DOM is where the bugs a
  // pure-logic test can't see actually live. app.js wires fetch + navigation.

  function elem(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text; // textContent — never innerHTML — so content is inert
    return n;
  }

  // One timeline row. `opts`: { agentId, onOpen(id,link), formatTime(iso)->str }.
  function renderRow(doc, event, opts) {
    opts = opts || {};
    var m = rowModel(event);
    var fmt = typeof opts.formatTime === 'function' ? opts.formatTime : function (t) { return t == null ? '' : String(t); };
    var li = elem(doc, 'li', 'tl tl-src-' + (m.source || 'x'));
    // Fixed agentId (single-target timeline) wins; otherwise fall back to the
    // event's own target (cross-agent cluster timeline), so each row links to the
    // agent it actually concerns. A targetless event (e.g. cluster state change)
    // is not clickable.
    var linkAgent = opts.agentId != null ? opts.agentId : m.target;
    var link = linkAgent != null ? deepLink(event, linkAgent) : null;
    if (link && typeof opts.onOpen === 'function') {
      li.className += ' clickable';
      li.title = 'Open device (' + m.sourceLabel + (m.refId != null ? ' #' + m.refId : '') + ')';
      li.addEventListener('click', function () { opts.onOpen(link.id, link); });
    }
    li.appendChild(elem(doc, 'span', 'tl-time muted', fmt(m.time)));
    li.appendChild(elem(doc, 'span', 'badge ' + m.severity + ' tl-sev', m.severity));
    li.appendChild(elem(doc, 'span', 'badge tl-src', m.sourceLabel));
    if (m.showType) li.appendChild(elem(doc, 'span', 'tl-type muted', m.typeDetail));
    li.appendChild(elem(doc, 'span', 'tl-desc', m.summary));
    return li;
  }

  // Render a resolved state (from resolveState) into `container`, replacing its
  // contents. `opts`: { agentId, onOpen, formatTime, onRetry, emptyText }.
  function renderInto(doc, container, view, opts) {
    opts = opts || {};
    while (container.firstChild) container.removeChild(container.firstChild);
    if (view.state === 'loading') { container.appendChild(elem(doc, 'p', 'muted', 'Loading…')); return; }
    if (view.state === 'error') {
      container.appendChild(elem(doc, 'p', 'error', view.message));
      if (typeof opts.onRetry === 'function') {
        var btn = elem(doc, 'button', 'small', 'Retry');
        btn.addEventListener('click', opts.onRetry);
        container.appendChild(btn);
      }
      return;
    }
    if (view.partial) container.appendChild(elem(doc, 'div', 'tl-partial callout', '⚠ ' + partialNotice(view.failedSources)));
    if (view.state === 'empty') {
      container.appendChild(elem(doc, 'p', 'muted', opts.emptyText || 'No events in this window.'));
      return;
    }
    var ul = elem(doc, 'ul', 'timeline');
    for (var i = 0; i < view.events.length; i += 1) ul.appendChild(renderRow(doc, view.events[i], opts));
    container.appendChild(ul);
  }

  var apiObj = {
    severityClass: severityClass,
    sourceLabel: sourceLabel,
    SOURCE_LABELS: SOURCE_LABELS,
    typeDetail: typeDetail,
    typeIsInformative: typeIsInformative,
    RANGE_PRESETS: RANGE_PRESETS,
    rangeToWindow: rangeToWindow,
    timelineQuery: timelineQuery,
    resolveState: resolveState,
    rowModel: rowModel,
    deepLink: deepLink,
    distinctSources: distinctSources,
    filterBySource: filterBySource,
    partialNotice: partialNotice,
    renderRow: renderRow,
    renderInto: renderInto,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.TimelineView = apiObj;
})(typeof window !== 'undefined' ? window : null);
