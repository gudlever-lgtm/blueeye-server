// public/fleetFilter.js — pure, framework-free filter logic for the fleet
// Overview's active metric-card filters. NO DOM here: this is the state that the
// four clickable metric cards (Fleet health / Kritiske / Advarsler / Offline),
// the filter-chips row and the grid all read from, factored out so it can be
// unit-tested under `node --test` (the dashboard has no build step and no
// browser test harness) and so the exact same state round-trips through the URL
// query string — a filtered Overview can be shared as a deep-link and renders
// pre-filtered on page load.
//
// Filter shape (shared by all consumers, persisted in the URL query string):
//   { severity: [], site: null, healthBelow: null, offline: false }
// Combined with AND across dimensions; `severity` is an array so CRIT+WARN can be
// active at once (OR within the dimension). Severity tokens map onto health
// statuses: CRIT ⇒ bad|down, WARN ⇒ warn.
//
// Dual export: attaches to `window.FleetFilter` in the browser (loaded as a
// plain <script> before app.js) and to `module.exports` under Node (tests).

(function (root) {
  'use strict';

  // Severity token → the health statuses it stands for. Only these tokens are
  // valid; anything else (a typo, a stale link, `?severity=BOGUS`) is dropped.
  var SEVERITY_STATUSES = { CRIT: ['bad', 'down'], WARN: ['warn'] };
  var SEVERITY_LABEL = { CRIT: 'Kritiske', WARN: 'Advarsler' };
  var SEVERITY_ORDER = ['CRIT', 'WARN'];

  function emptyState() {
    return { severity: [], site: null, healthBelow: null, offline: false };
  }

  // True when at least one filter dimension is set (⇒ the count line + chips row
  // become visible; the grid is narrowed).
  function isActive(state) {
    return activeCount(state) > 0;
  }
  function activeCount(state) {
    if (!state) return 0;
    return (state.severity ? state.severity.length : 0)
      + (state.site ? 1 : 0)
      + (state.offline ? 1 : 0)
      + (state.healthBelow != null ? 1 : 0);
  }

  // Only keep known severity tokens, upper-cased, de-duplicated, in a stable
  // order — so `?severity=warn,CRIT,bogus,WARN` normalises to ['CRIT','WARN'].
  function normalizeSeverity(list) {
    var seen = {};
    var out = [];
    (list || []).forEach(function (t) {
      var tok = String(t == null ? '' : t).trim().toUpperCase();
      if (SEVERITY_STATUSES[tok] && !seen[tok]) { seen[tok] = 1; out.push(tok); }
    });
    out.sort(function (a, b) { return SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b); });
    return out;
  }

  // Parse a URL query string (`location.search`, with or without the leading
  // '?') into a filter state. Forgiving by design: unknown severity tokens and
  // unparseable numbers are ignored, never thrown, so a bad deep-link degrades
  // to "no filter" instead of an error.
  function parseQuery(search) {
    var state = emptyState();
    var qs = String(search == null ? '' : search).replace(/^\?/, '');
    if (!qs) return state;
    var params;
    try { params = new URLSearchParams(qs); } catch (e) { return state; }
    var sev = params.get('severity');
    if (sev != null && sev !== '') state.severity = normalizeSeverity(sev.split(','));
    var site = params.get('site');
    if (site != null && site.trim() !== '') state.site = site.trim();
    var below = params.get('healthBelow');
    if (below != null && below !== '') {
      var n = Number(below);
      if (Number.isFinite(n)) state.healthBelow = n;
    }
    var off = params.get('offline');
    if (off === '1' || off === 'true') state.offline = true;
    return state;
  }

  // Serialise a filter state back to a query string (no leading '?'; '' when no
  // filter is active). The inverse of parseQuery for every valid state.
  function toQuery(state) {
    var params = new URLSearchParams();
    var sev = normalizeSeverity(state && state.severity);
    if (sev.length) params.set('severity', sev.join(','));
    if (state && state.site) params.set('site', state.site);
    if (state && state.healthBelow != null) params.set('healthBelow', String(state.healthBelow));
    if (state && state.offline) params.set('offline', '1');
    return params.toString();
  }

  // A 0–100 health score for an agent, worst→best, so the "Fleet health" card
  // can sort the grid by it (ascending ⇒ worst agents first). Derived from the
  // discrete verdict, then nudged by the agent's own loss/latency so ties within
  // a status break sensibly. Explainable, no ML — same spirit as the verdict.
  var STATUS_SCORE = { bad: 0, down: 8, warn: 40, unknown: 30, stale: 55, ok: 100 };
  function healthScore(agent) {
    var h = (agent && agent.health) || {};
    var base = STATUS_SCORE[h.status];
    if (base == null) base = 30;
    var m = h.metrics || {};
    var penalty = 0;
    if (typeof m.lossPct === 'number' && isFinite(m.lossPct)) penalty += Math.min(20, m.lossPct / 5);
    if (typeof m.latencyZ === 'number' && isFinite(m.latencyZ)) penalty += Math.min(10, Math.max(0, m.latencyZ));
    var s = base - penalty;
    if (s < 0) s = 0;
    if (s > 100) s = 100;
    return Math.round(s);
  }

  // The site (location) a filter value refers to matches an agent by location
  // name (case-insensitive) or by numeric location id — so both `?site=vest` and
  // `?site=3` work.
  function matchSite(agent, site) {
    if (!site) return true;
    var want = String(site).trim().toLowerCase();
    if (agent && agent.locationName != null && String(agent.locationName).toLowerCase() === want) return true;
    if (agent && agent.locationId != null && String(agent.locationId) === want) return true;
    return false;
  }

  function matchSeverity(agent, severity) {
    if (!severity || !severity.length) return true;
    var status = (agent && agent.health && agent.health.status) || 'unknown';
    for (var i = 0; i < severity.length; i += 1) {
      var statuses = SEVERITY_STATUSES[severity[i]];
      if (statuses && statuses.indexOf(status) !== -1) return true;
    }
    return false;
  }

  // AND across dimensions; an empty state matches every agent.
  function matchAgent(agent, state) {
    if (!state) return true;
    if (!matchSeverity(agent, state.severity)) return false;
    if (!matchSite(agent, state.site)) return false;
    if (state.offline && agent && agent.online) return false;
    if (state.healthBelow != null && healthScore(agent) >= state.healthBelow) return false;
    return true;
  }

  function applyFilter(agents, state) {
    return (agents || []).filter(function (a) { return matchAgent(a, state); });
  }

  // A copy of `agents` ordered by health score ascending (worst first). Stable:
  // equal scores keep their incoming order.
  function sortByHealth(agents) {
    return (agents || []).map(function (a, i) { return { a: a, i: i, s: healthScore(a) }; })
      .sort(function (x, y) { return x.s - y.s || x.i - y.i; })
      .map(function (w) { return w.a; });
  }

  // One descriptor per active filter, for the chips row. `kind`/`value` identify
  // the chip so removeChip can drop exactly that filter.
  function chips(state) {
    var out = [];
    if (!state) return out;
    normalizeSeverity(state.severity).forEach(function (tok) {
      out.push({ kind: 'severity', value: tok, label: SEVERITY_LABEL[tok] || tok });
    });
    if (state.site) out.push({ kind: 'site', value: state.site, label: String(state.site) });
    if (state.offline) out.push({ kind: 'offline', value: true, label: 'Offline' });
    if (state.healthBelow != null) out.push({ kind: 'healthBelow', value: state.healthBelow, label: 'Health < ' + state.healthBelow });
    return out;
  }

  // Immutable state transitions (each returns a fresh state) so callers never
  // mutate shared objects by accident.
  function toggleSeverity(state, token) {
    var tok = String(token || '').toUpperCase();
    var next = clone(state);
    var idx = next.severity.indexOf(tok);
    if (idx === -1) { if (SEVERITY_STATUSES[tok]) next.severity = next.severity.concat(tok); }
    else next.severity = next.severity.slice(0, idx).concat(next.severity.slice(idx + 1));
    next.severity = normalizeSeverity(next.severity);
    return next;
  }
  function toggleOffline(state) {
    var next = clone(state);
    next.offline = !next.offline;
    return next;
  }
  function setSite(state, site) {
    var next = clone(state);
    next.site = site || null;
    return next;
  }
  function removeChip(state, chip) {
    if (!chip) return clone(state);
    if (chip.kind === 'severity') return toggleSeverity(state, chip.value);
    var next = clone(state);
    if (chip.kind === 'site') next.site = null;
    else if (chip.kind === 'offline') next.offline = false;
    else if (chip.kind === 'healthBelow') next.healthBelow = null;
    return next;
  }

  function clone(state) {
    var s = state || {};
    return {
      severity: (s.severity || []).slice(),
      site: s.site != null ? s.site : null,
      healthBelow: s.healthBelow != null ? s.healthBelow : null,
      offline: !!s.offline,
    };
  }

  var apiObj = {
    SEVERITY_STATUSES: SEVERITY_STATUSES,
    SEVERITY_LABEL: SEVERITY_LABEL,
    emptyState: emptyState,
    isActive: isActive,
    activeCount: activeCount,
    normalizeSeverity: normalizeSeverity,
    parseQuery: parseQuery,
    toQuery: toQuery,
    healthScore: healthScore,
    matchAgent: matchAgent,
    applyFilter: applyFilter,
    sortByHealth: sortByHealth,
    chips: chips,
    toggleSeverity: toggleSeverity,
    toggleOffline: toggleOffline,
    setSite: setSite,
    removeChip: removeChip,
    clone: clone,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.FleetFilter = apiObj;
})(typeof window !== 'undefined' ? window : null);
