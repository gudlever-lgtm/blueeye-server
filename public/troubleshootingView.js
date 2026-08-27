// public/troubleshootingView.js — pure, framework-free helpers for the
// consolidated Troubleshooting Dashboard. NO DOM here: this is the state and
// mapping logic the renderer switches on, factored out so it can be unit-tested
// under `node --test` (the dashboard has no build step and no browser test
// harness).
//
// Dual export: attaches to `window.TroubleshootingView` in the browser (loaded
// as a plain <script> before app.js) and to `module.exports` under Node (tests).

(function (root) {
  'use strict';

  var STATES = { ok: 1, down: 1, unreachable_downstream: 1 };
  var STATE_LABELS = {
    ok: 'OK',
    down: 'Down',
    unreachable_downstream: 'Unreachable downstream',
  };

  function normalizeState(state) {
    var s = String(state == null ? 'ok' : state);
    return STATES[s] ? s : 'ok';
  }

  // State → CSS modifier. Green = ok, red = down, grey = we cannot hear it.
  function stateClass(state) { return 'ts-' + normalizeState(state); }
  function stateLabel(state) { return STATE_LABELS[normalizeState(state)]; }

  var SEVERITIES = { INFO: 1, WARN: 1, CRIT: 1 };
  function severityClass(sev) {
    var s = String(sev == null ? 'INFO' : sev).toUpperCase();
    return SEVERITIES[s] ? s : 'INFO';
  }

  // --- key figures ---------------------------------------------------------
  // The four cards, in reading order. `hint` is the honest sub-line: pairing
  // activeFaults against rootCauses is what makes the rollup legible — "47 raw
  // alarms, 3 actual causes" — so the card says so rather than leaving the
  // operator to divide two numbers.
  function kpiCards(summary) {
    var s = summary || {};
    var faults = Number(s.activeFaults) || 0;
    var causes = Number(s.rootCauses) || 0;
    var down = Number(s.devicesDown) || 0;
    var unreachable = Number(s.devicesUnreachable) || 0;
    return [
      {
        key: 'activeFaults',
        label: 'Active faults',
        value: faults,
        hint: causes > 0 ? 'raw alarms across ' + causes + ' root cause' + (causes === 1 ? '' : 's') : 'no correlated causes',
      },
      {
        key: 'affectedDevices',
        label: 'Affected devices',
        value: Number(s.affectedDevices) || 0,
        hint: down + ' down · ' + unreachable + ' unreachable downstream',
      },
      {
        key: 'rootCauses',
        label: 'Root causes',
        value: causes,
        hint: faults > 0 && causes > 0 ? 'collapsed from ' + faults + ' alarm' + (faults === 1 ? '' : 's') : 'correlated across agents',
      },
      {
        key: 'anomalies',
        label: 'Baseline deviations',
        value: Number(s.anomalies) || 0,
        hint: 'flow pairs off their weekday/hour baseline',
      },
    ];
  }

  // --- root causes ---------------------------------------------------------
  // The blast-radius one-liner the panel shows under each cause. Names the real
  // counts and never rounds them into vagueness.
  function blastRadiusText(rc) {
    var r = (rc && rc.blastRadius) || {};
    var isolated = (r.directlyIsolated || []).length;
    var dependents = (r.dependencyAffected || []).length;
    if (!isolated && !dependents) return null;
    var parts = [];
    if (isolated) parts.push('→ ' + isolated + ' device' + (isolated === 1 ? '' : 's') + ' unreachable');
    if (dependents) parts.push((parts.length ? '' : '→ ') + dependents + ' dependent service' + (dependents === 1 ? '' : 's') + ' affected');
    return parts.join(' · ');
  }

  function rootCauseModel(rc) {
    var affected = (rc && rc.affectedDeviceIds) || [];
    return {
      id: rc && rc.id,
      severity: severityClass(rc && rc.severity),
      cause: (rc && rc.cause) || 'Correlated anomalies.',
      affectedDeviceIds: affected,
      affectedText: affected.length + ' device' + (affected.length === 1 ? '' : 's') + ' affected',
      blastRadiusCount: Number(rc && rc.blastRadiusCount) || 0,
      blastText: blastRadiusText(rc),
      confidence: (rc && rc.confidence) || null,
      classification: (rc && rc.classification) || null,
      status: (rc && rc.status) || null,
      firstSeen: (rc && rc.firstSeen) || null,
      // "Show path" needs a node to walk the topology from; the backend picks a
      // stable one so a deep-link keeps working across refreshes.
      pathAnchorId: rc && rc.primaryDeviceId != null ? rc.primaryDeviceId : null,
    };
  }

  // --- raw fault list ------------------------------------------------------
  // The rows behind the "Active faults" figure. This list is opt-in: the
  // overview read does not carry it, GET /api/troubleshooting/faults pages it in
  // when the operator asks. These helpers keep the mapping and the counter
  // wording testable; the DOM lives in app.js.

  // One row, joined to the topology's node labels so the operator reads a device
  // name rather than an agent id. A fault whose finding retention has already
  // purged still gets a row — the cluster counts it, so hiding it would make the
  // "x of y" counter unreachable — flagged `missing` and with nothing invented.
  function faultRowModel(fault, labelById) {
    var f = fault || {};
    var labels = labelById || {};
    var host = f.hostId == null ? null : String(f.hostId);
    return {
      findingId: f.findingId == null ? null : f.findingId,
      clusterId: f.clusterId == null ? null : f.clusterId,
      severity: severityClass(f.severity),
      missing: !!f.missing,
      acked: !!f.acked,
      hostId: host,
      deviceLabel: host == null ? '—' : (labels[host] || ('agent ' + host)),
      metric: f.metric || '—',
      createdAt: f.createdAt || null,
      // The cause text is the cluster's, repeated per row on purpose: sorted by
      // cluster, the repetition is what shows where one cause ends and the next
      // begins.
      cause: f.cause || null,
      explanation: f.explanation || null,
    };
  }

  // The loading counter, as an i18n key + params so the caller renders it
  // through t(). Three honest states: the first page in flight (no total known
  // yet), a later page in flight (say how far we got), and settled.
  function faultProgress(state) {
    var s = state || {};
    var loaded = Number(s.loaded) || 0;
    var total = Number(s.total) || 0;
    if (s.loading && loaded === 0) return { key: 'tshoot.faults.loadingFirst', params: {} };
    if (s.loading) return { key: 'tshoot.faults.loading', params: { loaded: loaded, total: total } };
    return { key: 'tshoot.faults.progress', params: { loaded: loaded, total: total } };
  }

  // How many rows the next page will ask for — the remainder, capped at the page
  // size, so the button never promises more than is left.
  function faultsRemaining(state, pageSize) {
    var s = state || {};
    var left = (Number(s.total) || 0) - (Number(s.loaded) || 0);
    if (left <= 0) return 0;
    var size = Number(pageSize) > 0 ? Number(pageSize) : left;
    return Math.min(left, size);
  }

  // --- "What changed?" -----------------------------------------------------
  // The change events immediately BEFORE a root cause fired. Change-vs-symptom
  // uses the same split the per-target timeline settled on: a topology change or
  // an agent reconnect/enrol acted on the network; an agent going offline is the
  // problem manifesting, not a change that caused it.
  var CHANGE_TYPES = { 'agent.online': 1, 'agent.enrolled': 1 };
  function isChangeEvent(event) {
    if (!event) return false;
    if (event.source === 'topology' || event.source === 'playbook' || event.source === 'config') return true;
    return !!CHANGE_TYPES[event.type];
  }

  // Events in [since - lookbackMs, since]. Returns newest-first, as stored.
  // An absent/unparseable `since` yields [] rather than the whole timeline —
  // showing every change ever would answer a different question than the one
  // the operator asked.
  function changesBefore(timeline, since, lookbackMs) {
    var events = Array.isArray(timeline) ? timeline : [];
    var at = since ? Date.parse(since) : NaN;
    if (isNaN(at)) return [];
    var window = typeof lookbackMs === 'number' && lookbackMs > 0 ? lookbackMs : 30 * 60 * 1000;
    var out = [];
    for (var i = 0; i < events.length; i += 1) {
      var e = events[i];
      var ts = e && e.timestamp ? Date.parse(e.timestamp) : NaN;
      if (isNaN(ts)) continue;
      if (ts > at || ts < at - window) continue;
      if (!isChangeEvent(e)) continue;
      out.push(e);
    }
    return out;
  }

  // --- timeline brush ------------------------------------------------------
  // Bounds of the timeline, used to scale the brush. Returns null when there is
  // nothing to draw, so the caller renders an empty state instead of a chart
  // with an infinite axis.
  function timelineBounds(timeline) {
    var events = Array.isArray(timeline) ? timeline : [];
    var min = null;
    var max = null;
    for (var i = 0; i < events.length; i += 1) {
      var ts = events[i] && events[i].timestamp ? Date.parse(events[i].timestamp) : NaN;
      if (isNaN(ts)) continue;
      if (min === null || ts < min) min = ts;
      if (max === null || ts > max) max = ts;
    }
    if (min === null) return null;
    // A single event has zero width; give the brush a minute either side so the
    // marker is selectable rather than a degenerate point.
    if (min === max) return { fromMs: min - 30000, toMs: max + 30000 };
    return { fromMs: min, toMs: max };
  }

  // Events inside the brushed window (inclusive). An unset window passes
  // everything through.
  function eventsInWindow(timeline, fromMs, toMs) {
    var events = Array.isArray(timeline) ? timeline : [];
    if (typeof fromMs !== 'number' || typeof toMs !== 'number') return events.slice();
    var lo = Math.min(fromMs, toMs);
    var hi = Math.max(fromMs, toMs);
    var out = [];
    for (var i = 0; i < events.length; i += 1) {
      var ts = events[i] && events[i].timestamp ? Date.parse(events[i].timestamp) : NaN;
      if (isNaN(ts) || ts < lo || ts > hi) continue;
      out.push(events[i]);
    }
    return out;
  }

  // --- topology layout -----------------------------------------------------
  // Deterministic ring layout with a light spring relaxation. Deterministic
  // matters: an operator comparing two refreshes must see the same graph, and
  // the unit tests need a stable answer.
  function layoutNodes(nodes, links, width, height) {
    var list = Array.isArray(nodes) ? nodes : [];
    var pos = {};
    var n = Math.max(1, list.length);
    var w = width || 760;
    var h = height || 460;
    var radius = Math.min(w, h) / 2.6;
    for (var i = 0; i < list.length; i += 1) {
      var angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      pos[list[i].id] = {
        x: w / 2 + radius * Math.cos(angle),
        y: h / 2 + radius * Math.sin(angle),
      };
    }
    if (list.length <= 2) return pos;

    // Pull linked nodes together a little so adjacency reads visually.
    var edges = Array.isArray(links) ? links : [];
    for (var pass = 0; pass < 12; pass += 1) {
      for (var e = 0; e < edges.length; e += 1) {
        var a = pos[edges[e].source];
        var b = pos[edges[e].target];
        if (!a || !b) continue;
        var dx = (b.x - a.x) * 0.02;
        var dy = (b.y - a.y) * 0.02;
        a.x += dx; a.y += dy;
        b.x -= dx; b.y -= dy;
      }
    }
    // Keep everything on canvas.
    for (var id in pos) {
      if (!Object.prototype.hasOwnProperty.call(pos, id)) continue;
      pos[id].x = Math.max(30, Math.min(w - 30, pos[id].x));
      pos[id].y = Math.max(30, Math.min(h - 30, pos[id].y));
    }
    return pos;
  }

  // Node ids on a blast-radius path, for highlighting "Show path" on the graph.
  // Accepts both tiers' path shapes: L2 paths are plain ids, dependency paths
  // are { hostId, viaPort } steps.
  function pathNodeIds(paths) {
    var out = [];
    var seen = {};
    var list = Array.isArray(paths) ? paths : [];
    for (var i = 0; i < list.length; i += 1) {
      var steps = Array.isArray(list[i] && list[i].path) ? list[i].path : [];
      for (var j = 0; j < steps.length; j += 1) {
        var step = steps[j];
        var id = step && typeof step === 'object' ? step.hostId : step;
        if (id == null || seen[id]) continue;
        seen[id] = 1;
        out.push(Number(id));
      }
    }
    return out;
  }

  var apiObj = {
    normalizeState: normalizeState,
    stateClass: stateClass,
    stateLabel: stateLabel,
    severityClass: severityClass,
    kpiCards: kpiCards,
    blastRadiusText: blastRadiusText,
    rootCauseModel: rootCauseModel,
    faultRowModel: faultRowModel,
    faultProgress: faultProgress,
    faultsRemaining: faultsRemaining,
    isChangeEvent: isChangeEvent,
    changesBefore: changesBefore,
    timelineBounds: timelineBounds,
    eventsInWindow: eventsInWindow,
    layoutNodes: layoutNodes,
    pathNodeIds: pathNodeIds,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.TroubleshootingView = apiObj;
})(typeof window !== 'undefined' ? window : null);
