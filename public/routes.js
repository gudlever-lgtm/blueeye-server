// public/routes.js — the dashboard's URL contract.
//
// The dashboard is a single-page app: every screen used to live behind a
// module-level `currentView` variable with no address of its own, so a reload
// always landed on Changes, a screen could not be linked to, and there was no
// such thing as an unknown route. This module gives every view a path.
//
// It is the ONE place that knows view ↔ path, and both sides read it:
//   * public/app.js  — parses location on boot, pushes state on navigation.
//   * src/app.js     — decides whether an HTML request is a real app path
//                      (200 + the shell) or an unknown one (404 + the shell,
//                      where the client renders the not-found view).
//
// Sub-tabs live in the PATH (/probes/connection, /settings/retention) rather
// than in the query string, because several views already own the query for
// their own filters (fleet ?severity, topology ?layer, delta ?changeTypes) and
// rewrite it wholesale. Keeping tabs out of the query means those writers stay
// exactly as they are — they all preserve window.location.pathname.
//
// Dual export: window.AppRoutes (browser <script>) + module.exports (server + tests).

(function (root) {
  'use strict';

  // view key → { path, tabs?, tabKey?, param? }
  //   tabs    the sub-tab segments this view accepts, first = default
  //   tabKey  the name match() reports the chosen sub-tab under
  //   param   this view takes a trailing id (/agents/12) reported as `id`
  var VIEWS = {
    changes: { path: '/changes' },
    fleet: { path: '/fleet' },
    overview: { path: '/traffic' },
    map: { path: '/sites' },
    geo: { path: '/destinations' },

    agents: { path: '/agents' },
    agent: { path: '/agents', param: true },
    interfaces: { path: '/interfaces' },
    nics: { path: '/nics', tabs: ['models', 'agents'], tabKey: 'nicsTab' },

    probes: { path: '/probes', tabs: ['run', 'connection', 'burst', 'packages'], tabKey: 'probesTab' },
    transactions: { path: '/transaction-tests', tabs: ['list', 'matrix'], tabKey: 'txTab' },
    flows: { path: '/flows' },
    topology: { path: '/topology' },
    pathLocation: { path: '/path-location' },
    delta: { path: '/topology-delta' },
    diagnose: { path: '/diagnose' },
    deviceLog: { path: '/device-log' },
    snmpDevice: { path: '/snmp-devices', param: true },
    troubleshooting: { path: '/troubleshooting' },
    investigation: { path: '/investigate' },

    serviceAssurance: {
      path: '/service-assurance',
      tabs: ['health', 'journeys', 'applications', 'tests', 'runs', 'history', 'schedules', 'monitors'],
      tabKey: 'serviceAssuranceTab',
    },

    findings: { path: '/analysis' },
    events: { path: '/events' },
    event: { path: '/events', param: true },
    clusters: { path: '/situations' },
    cluster: { path: '/situations', param: true },
    reporting: {
      path: '/reporting',
      tabs: ['findings', 'sla', 'nis2', 'generator', 'schedules', 'audit'],
      tabKey: 'reportingSection',
    },

    guide: {
      path: '/guides',
      tabs: ['monitoring', 'fleet', 'diagnostics', 'assurance', 'insights'],
      tabKey: 'guideTrack',
    },

    locations: { path: '/locations' },
    location: { path: '/locations', param: true },
    enrollment: { path: '/enrollment' },
    discovery: { path: '/discovery' },
    coverage: { path: '/coverage' },
    auditLog: { path: '/audit-log' },
    logs: { path: '/logs' },
    userLogs: { path: '/user-logs' },
    screening: { path: '/test-settings' },
    users: { path: '/users' },
    license: { path: '/license' },
    settings: {
      path: '/settings',
      tabs: ['users', 'auth', 'apitokens', 'agentkey', 'analyse', 'alerting', 'severity', 'thresholds', 'runbooks',
        'integrations', 'cmdb', 'ai', 'maintenance', 'database', 'retention', 'types', 'map',
        'updates', 'agents', 'snmp', 'screening', 'assurance', 'appearance', 'license'],
      tabKey: 'settingsTab',
    },
    // An article is a destination, so it has an address. The list is pinned to
    // DOCS in public/app.js by test/docsPage.test.js — a new article without a
    // route here fails the build rather than becoming unlinkable.
    docs: {
      path: '/docs',
      tabs: [
      'what-is', 'tour', 'assurance', 'assurance-monitors', 'agent-offline',
      'site-unhealthy', 'latency-loss', 'interface', 'findings', 'situations',
      'dependencies', 'blast-radius', 'topology-changes', 'flow-baselines', 'adhoc',
      'assurance-worker', 'discovery', 'servicenow', 'cmdb', 'alerting', 'sso', 'auth-lockout',
      'enroll-key', 'retention',
      ],
      tabKey: 'docsTopic',
    },
    about: { path: '/about' },

    // The component reference: it is the
    // visual reference for docs/ui-contract.md and a test surface for the
    // components, neither of which stops being useful after the migration.
    kitchenSink: { path: '/ui-kitchen-sink' },
  };

  // The view the bare '/' opens, and the view an unknown path renders.
  var HOME = 'changes';
  var NOT_FOUND = 'notFound';

  // Views whose path is only reachable with the role below (the nav rail hides
  // them too, but a typed URL does not go through the nav). Checked in the
  // client — the server has no session on an HTML request.
  var MIN_ROLE = {
    delta: 'operator', troubleshooting: 'operator', investigation: 'operator',
    enrollment: 'operator', serviceAssurance: 'operator',
    discovery: 'admin', coverage: 'admin', auditLog: 'admin', logs: 'admin', userLogs: 'admin', users: 'admin', screening: 'admin',
    kitchenSink: 'admin',
  };

  function normalise(pathname) {
    var p = String(pathname || '/');
    var q = p.indexOf('?');
    if (q >= 0) p = p.slice(0, q);
    var h = p.indexOf('#');
    if (h >= 0) p = p.slice(0, h);
    if (p.charAt(0) !== '/') p = '/' + p;
    // Trailing slash is the same screen, except for the root itself.
    if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
    return p;
  }

  // '/probes/connection' → { view: 'probes', tabKey: 'probesTab', tab: 'connection' }
  // '/agents/12'         → { view: 'agent', id: 12 }
  // '/nope'              → null
  function match(pathname) {
    var p = normalise(pathname);
    if (p === '/' || p === '/index.html') return { view: HOME, path: VIEWS[HOME].path };

    var keys = Object.keys(VIEWS);
    var best = null;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var spec = VIEWS[key];
      if (p === spec.path) {
        // A view with sub-tabs opens on its default when the path names none.
        if (spec.param) continue; // /agents alone belongs to `agents`, not `agent`
        best = { view: key, path: spec.path };
        if (spec.tabs) { best.tabKey = spec.tabKey; best.tab = spec.tabs[0]; }
        return best;
      }
      if (p.indexOf(spec.path + '/') !== 0) continue;
      var rest = p.slice(spec.path.length + 1);
      if (rest.indexOf('/') >= 0) continue; // one segment only
      if (spec.tabs && spec.tabs.indexOf(rest) >= 0) {
        return { view: key, path: spec.path, tabKey: spec.tabKey, tab: rest };
      }
      if (spec.param && /^[0-9]+$/.test(rest)) {
        return { view: key, path: spec.path, id: Number(rest) };
      }
    }
    return null;
  }

  // The address of a view, with its sub-tab or id where it has one.
  function pathFor(view, opts) {
    var spec = VIEWS[view];
    if (!spec) return '/';
    var o = opts || {};
    if (spec.param && o.id != null) return spec.path + '/' + o.id;
    if (spec.tabs && o.tab && spec.tabs.indexOf(o.tab) >= 0) return spec.path + '/' + o.tab;
    return spec.path;
  }

  // Does this pathname address a screen at all? Used by the server to answer
  // 200 or 404 for the same shell.
  function isAppPath(pathname) { return match(pathname) !== null; }

  // Is this address inside the dashboard's namespace, even if it names no
  // screen? '/agents/abc' is: the person typed a page address and got the id
  // wrong, so they should get the not-found PAGE, not the agents API's 401.
  // '/api/nis2/…' is not, so the documents the API renders are left alone.
  function ownsPath(pathname) {
    var p = normalise(pathname);
    if (p === '/' || p === '/index.html') return true;
    var keys = Object.keys(VIEWS);
    for (var i = 0; i < keys.length; i++) {
      var base = VIEWS[keys[i]].path;
      if (p === base || p.indexOf(base + '/') === 0) return true;
    }
    return false;
  }

  var apiObj = {
    VIEWS: VIEWS,
    HOME: HOME,
    NOT_FOUND: NOT_FOUND,
    MIN_ROLE: MIN_ROLE,
    normalise: normalise,
    match: match,
    pathFor: pathFor,
    isAppPath: isAppPath,
    ownsPath: ownsPath,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.AppRoutes = apiObj;
})(typeof window !== 'undefined' ? window : null);
