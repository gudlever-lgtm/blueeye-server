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

  var SOURCE_LABELS = { finding: 'Finding', incident: 'Incident', agent: 'Agent', playbook: 'Playbook' };
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

  // Map a normalised timeline event to a flat row view-model (what the row
  // renderer needs, already sanitised).
  function rowModel(e) {
    e = e || {};
    return {
      time: e.timestamp || null,
      source: e.source || null,
      sourceLabel: sourceLabel(e.source),
      type: e.type || '',
      severity: severityClass(e.severity),
      summary: e.summary || e.type || '',
      refId: e.ref_id != null ? e.ref_id : null,
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

  // Human notice for a partial response (some sources unavailable). Never hidden.
  function partialNotice(failedSources) {
    var list = Array.isArray(failedSources) && failedSources.length ? failedSources.join(', ') : 'some sources';
    return 'Some data sources were unavailable (' + list + '); this timeline may be incomplete.';
  }

  var apiObj = {
    severityClass: severityClass,
    sourceLabel: sourceLabel,
    RANGE_PRESETS: RANGE_PRESETS,
    rangeToWindow: rangeToWindow,
    timelineQuery: timelineQuery,
    resolveState: resolveState,
    rowModel: rowModel,
    deepLink: deepLink,
    partialNotice: partialNotice,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.TimelineView = apiObj;
})(typeof window !== 'undefined' ? window : null);
