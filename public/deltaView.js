// public/deltaView.js — pure logic for the Delta / Changes view (topology change
// feed). NO DOM: the change-type filter catalogue + its URL round-trip, and the
// combined filter that AND-composes the view's own change-type filter with the
// SHARED global filter (severity + site). Unit-tested under node --test.
//
// Records come from GET /api/topology/changes: timeline-shaped events
// { timestamp, source:'topology', type:'topology.<changeType>', severity,
//   summary, ref_id, agentId }. We reuse that record shape — no second changes
// format — and layer the change-type filter on top.
//
// Dual export: window.DeltaView (browser <script>) + module.exports (tests).

(function (root) {
  'use strict';

  var CHANGE_TYPES = [
    { key: 'neighbour_added', label: 'Neighbour added' },
    { key: 'neighbour_removed', label: 'Neighbour removed' },
    { key: 'link_state_changed', label: 'Link state changed' },
    { key: 'port_moved', label: 'Port moved' },
    { key: 'flapping', label: 'Flapping' },
  ];
  var VALID = {};
  CHANGE_TYPES.forEach(function (t) { VALID[t.key] = 1; });

  // 'topology.link_state_changed' → 'link_state_changed'.
  function changeTypeOf(event) {
    var t = event && event.type ? String(event.type) : '';
    return t.indexOf('topology.') === 0 ? t.slice('topology.'.length) : t;
  }

  function normalizeTypes(list) {
    var seen = {};
    var out = [];
    (list || []).forEach(function (t) {
      var k = String(t == null ? '' : t).trim();
      if (VALID[k] && !seen[k]) { seen[k] = 1; out.push(k); }
    });
    return out;
  }

  // Parse the change-type filter from a URL query string. Absent/empty ⇒ [] which
  // means "all types" (no restriction). Forgiving: junk tokens are dropped.
  function parseChangeTypes(search) {
    var qs = String(search == null ? '' : search).replace(/^\?/, '');
    if (!qs) return [];
    var params;
    try { params = new URLSearchParams(qs); } catch (e) { return []; }
    var raw = params.get('changeTypes');
    if (raw == null || raw === '') return [];
    return normalizeTypes(raw.split(','));
  }

  // The change-type portion of the URL as a { changeTypes } patch. All-or-none
  // selected ⇒ dropped (the default "all" needs no param).
  function changeTypesPatch(types) {
    var norm = normalizeTypes(types);
    var all = norm.length === 0 || norm.length === CHANGE_TYPES.length;
    return { changeTypes: all ? null : norm.join(',') };
  }

  // A change's severity token, upper-cased ('INFO' | 'WARN' | 'CRIT').
  function severityToken(event) {
    return String((event && event.severity) || 'INFO').toUpperCase();
  }

  // AND-compose: the view's own change-type filter, the SHARED global severity
  // filter (tokens like ['CRIT','WARN'] matched against the change's own
  // severity), and the SHARED global site filter (pre-resolved to a set of the
  // agent ids in that site; null ⇒ no site restriction).
  //   opts = { types:[], severityTokens:[], siteAgentIds:Set|null }
  function filterChanges(events, opts) {
    var o = opts || {};
    var types = normalizeTypes(o.types);
    var sev = (o.severityTokens || []).map(function (s) { return String(s).toUpperCase(); });
    var site = o.siteAgentIds || null;
    return (Array.isArray(events) ? events : []).filter(function (e) {
      if (!e) return false;
      if (types.length && types.indexOf(changeTypeOf(e)) === -1) return false;
      if (sev.length && sev.indexOf(severityToken(e)) === -1) return false;
      if (site && !site.has(Number(e.agentId))) return false;
      return true;
    });
  }

  // Count changes per type over a set of events (for the filter chips' badges).
  function countByType(events) {
    var counts = {};
    CHANGE_TYPES.forEach(function (t) { counts[t.key] = 0; });
    (Array.isArray(events) ? events : []).forEach(function (e) {
      var k = changeTypeOf(e);
      if (counts[k] != null) counts[k] += 1;
    });
    return counts;
  }

  var apiObj = {
    CHANGE_TYPES: CHANGE_TYPES,
    changeTypeOf: changeTypeOf,
    normalizeTypes: normalizeTypes,
    parseChangeTypes: parseChangeTypes,
    changeTypesPatch: changeTypesPatch,
    severityToken: severityToken,
    filterChanges: filterChanges,
    countByType: countByType,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.DeltaView = apiObj;
})(typeof window !== 'undefined' ? window : null);
