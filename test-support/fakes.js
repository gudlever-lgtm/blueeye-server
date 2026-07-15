'use strict';

// Safety net: make sure a JWT secret exists before the app/config is loaded,
// in case a test file forgets to set one. Individual test files still set
// these at their very top to be explicit.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';

const { createApp } = require('../src/app');
const { createLogRing } = require('../src/logger');
const { issueToken } = require('../src/auth/jwt');
const { createSettingsService } = require('../src/services/settings');
const { createSecretBox } = require('../src/lib/secretBox');
const { createConnectorRegistry } = require('../src/integrations/connectors');
const { createCmdbConnectorRegistry } = require('../src/cmdb/connectors');
const { createPlanService } = require('../src/license/planService');
const { createUsageService } = require('../src/services/usageService');
const { createAuditLogger } = require('../src/services/complianceLogger');

// ---- Repositories ---------------------------------------------------------

// A fake locations repository. Each method has a sensible default and can be
// overridden per test — e.g. point one at `throwingAsync()` to drive a 500.
function makeLocationsRepo(overrides = {}) {
  return {
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    findByName: overrides.findByName || (async () => null),
    create:
      overrides.create ||
      (async (input) => ({
        id: 1,
        ...input,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })),
    update: overrides.update || (async () => null),
    remove: overrides.remove || (async () => false),
  };
}

// A fake users repository.
function makeUsersRepo(overrides = {}) {
  return {
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    findByEmail: overrides.findByEmail || (async () => null),
    findByEmailWithHash: overrides.findByEmailWithHash || (async () => null),
    create:
      overrides.create ||
      (async (input) => ({
        id: 1,
        email: input.email,
        role: input.role,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })),
    update: overrides.update || (async () => null),
    remove: overrides.remove || (async () => false),
    countByRole: overrides.countByRole || (async () => 1),
    getPreferences: overrides.getPreferences || (async () => ({})),
    updatePreferences: overrides.updatePreferences || (async (id, patch) => ({ ...patch })),
  };
}

// A fake agents repository.
function makeAgentsRepo(overrides = {}) {
  return {
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    findForGeo: overrides.findForGeo || (async () => []),
    updateManaged:
      overrides.updateManaged || (async (id, patch) => ({ id, ...patch })),
    setLocation:
      overrides.setLocation || (async (id, locationId) => ({ id, location_id: locationId ?? null })),
    setCapabilities:
      overrides.setCapabilities || (async (id, capabilities) => ({ id, capabilities })),
    remove: overrides.remove || (async () => false),
    setStatus: overrides.setStatus || (async () => {}),
    touchLastSeen: overrides.touchLastSeen || (async () => {}),
  };
}

// A fake agent-tokens repository.
function makeAgentTokensRepo(overrides = {}) {
  return {
    findActiveByHash: overrides.findActiveByHash || (async () => null),
    touchLastUsed: overrides.touchLastUsed || (async () => {}),
  };
}

// A fake results repository.
function makeResultsRepo(overrides = {}) {
  return {
    createMany: overrides.createMany || (async () => 0),
    findByAgentId: overrides.findByAgentId || (async () => []),
    latestByLocation: overrides.latestByLocation || (async () => []),
    latestPerAgent: overrides.latestPerAgent || (async () => []),
    rangeByLocation: overrides.rangeByLocation || (async () => []),
  };
}

// A fake probe-results repository (records inserted rows; benign empty reads).
function makeProbeResultsRepo(overrides = {}) {
  const rows = [];
  return {
    rows,
    createMany: overrides.createMany || (async (agentId, results) => { for (const r of results) rows.push({ agentId, ...r }); return results.length; }),
    findByAgent: overrides.findByAgent || (async () => []),
    latestByAgent: overrides.latestByAgent || (async () => []),
    fleetHealth: overrides.fleetHealth || (async () => []),
    availability: overrides.availability || (async () => []),
  };
}

// A fake incidents repository (in-memory, stateful) — supports the derivation
// service (findActive/open/resolve) AND the report routes (list/findById). Rows
// are kept snake_case internally; list/findById return the camelCase API shape.
function makeIncidentsRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : new Date(v).toISOString()));
  const mapOut = (r) => ({
    id: r.id,
    locationId: r.location_id ?? null,
    locationName: r.location_name ?? null,
    agentId: r.agent_id,
    agentName: r.agent_name ?? null,
    metric: r.metric,
    severity: r.severity,
    startedAt: iso(r.started_at),
    resolvedAt: iso(r.resolved_at),
    durationSeconds: r.duration_seconds ?? null,
    affectedTarget: r.affected_target,
    status: r.resolved_at == null ? 'active' : 'resolved',
    createdAt: iso(r.created_at || r.started_at),
  });
  return {
    rows,
    findActive: overrides.findActive || (async (agentId, metric, target) => {
      const r = rows.find((x) => x.agent_id === agentId && x.metric === metric && x.affected_target === target && x.resolved_at == null);
      return r ? { id: r.id, startedAt: iso(r.started_at), severity: r.severity } : null;
    }),
    open: overrides.open || (async (inc) => {
      const id = (seq += 1);
      rows.push({ id, location_id: null, resolved_at: null, duration_seconds: null, created_at: new Date(), ...inc });
      return id;
    }),
    resolve: overrides.resolve || (async (id, resolvedAt) => {
      const r = rows.find((x) => x.id === id && x.resolved_at == null);
      if (!r) return false;
      r.resolved_at = resolvedAt;
      r.duration_seconds = Math.max(0, Math.round((new Date(resolvedAt).getTime() - new Date(r.started_at).getTime()) / 1000));
      return true;
    }),
    updateSeverity: overrides.updateSeverity || (async (id, severity) => {
      const r = rows.find((x) => x.id === id && x.resolved_at == null);
      if (!r) return false;
      r.severity = severity;
      return true;
    }),
    findById: overrides.findById || (async (id) => { const r = rows.find((x) => x.id === id); return r ? mapOut(r) : null; }),
    list: overrides.list || (async () => rows.map(mapOut)),
  };
}

// A fake incident_cases repository (in-memory) — the first-class incident entity
// wrapping findings (migration 047). Mirrors incidentCasesRepository's surface.
function makeIncidentCasesRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  const rank = { INFO: 0, WARN: 1, CRIT: 2 };
  const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : new Date(v).toISOString()));
  const mapOut = (r) => ({
    id: r.id,
    hostId: r.host_id,
    title: r.title,
    status: r.status,
    severity: r.severity,
    primaryFindingId: r.primary_finding_id ?? null,
    configChangeId: r.config_change_id ?? null,
    firstEventAt: iso(r.first_event_at),
    lastEventAt: iso(r.last_event_at),
    resolvedAt: iso(r.resolved_at),
    createdBy: r.created_by,
    closedBy: r.closed_by ?? null,
    createdAt: iso(r.created_at || r.first_event_at),
  });
  return {
    rows,
    create: overrides.create || (async (c) => {
      const id = (seq += 1);
      rows.push({
        id, status: 'open', severity: 'INFO', primary_finding_id: null, config_change_id: null,
        resolved_at: null, created_by: 'system', closed_by: null, created_at: new Date(), ...c,
      });
      return id;
    }),
    setConfigChange: overrides.setConfigChange || (async (id, configSnapshotId) => {
      const r = rows.find((x) => x.id === Number(id) && (x.config_change_id == null));
      if (!r) return false;
      r.config_change_id = configSnapshotId;
      return true;
    }),
    findById: overrides.findById || (async (id) => { const r = rows.find((x) => x.id === Number(id)); return r ? mapOut(r) : null; }),
    findOpenByHost: overrides.findOpenByHost || (async (hostId) => {
      const open = rows
        .filter((x) => x.host_id === hostId && (x.status === 'open' || x.status === 'investigating'))
        .sort((a, b) => new Date(b.last_event_at) - new Date(a.last_event_at) || b.id - a.id);
      return open[0] ? mapOut(open[0]) : null;
    }),
    updateActivity: overrides.updateActivity || (async (id, { lastEventAt, severity = null }) => {
      const r = rows.find((x) => x.id === Number(id));
      if (!r) return false;
      if (new Date(lastEventAt) > new Date(r.last_event_at)) r.last_event_at = lastEventAt;
      if (severity && (rank[severity] ?? -1) > (rank[r.severity] ?? -1)) r.severity = severity;
      return true;
    }),
    updateStatus: overrides.updateStatus || (async (id, { from, to, closedBy = null, at = null }) => {
      const r = rows.find((x) => x.id === Number(id) && x.status === from);
      if (!r) return false;
      r.status = to;
      if (to === 'resolved') r.resolved_at = at;
      if (to === 'closed') r.closed_by = closedBy;
      if (to === 'open') { r.resolved_at = null; r.closed_by = null; }
      return true;
    }),
    listResolvedClosed: overrides.listResolvedClosed || (async ({ excludeId = null, limit = 100, statuses = ['resolved', 'closed'] } = {}) => rows
      .filter((r) => (Array.isArray(statuses) && statuses.length ? statuses : ['resolved', 'closed']).includes(r.status) && (excludeId == null || r.id !== Number(excludeId)))
      .sort((a, b) => new Date(b.last_event_at) - new Date(a.last_event_at) || b.id - a.id)
      .slice(0, limit)
      .map((r) => ({ ...mapOut(r), primaryMetric: r.primary_metric ?? null, closedByEmail: r.closed_by_email ?? null, platform: r.platform ?? null }))),
    listStaleInvestigating: overrides.listStaleInvestigating || (async (olderThan) => rows
      .filter((r) => r.status === 'investigating' && new Date(r.last_event_at) < new Date(olderThan))
      .sort((a, b) => new Date(a.last_event_at) - new Date(b.last_event_at))
      .map(mapOut)),
    list: overrides.list || (async (f = {}) => rows
      .filter((r) => (!f.status || r.status === f.status)
        && (!f.severity || r.severity === f.severity)
        && (!f.hostId || r.host_id === f.hostId))
      .sort((a, b) => new Date(b.last_event_at) - new Date(a.last_event_at) || b.id - a.id)
      .map(mapOut)),
  };
}

// A fake incident_clusters repository (in-memory) — cross-agent clusters
// (migration 056). Mirrors incidentClustersRepository's surface.
function makeIncidentClustersRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : new Date(v).toISOString()));
  const mapOut = (r) => ({
    id: r.id,
    confidence: r.confidence,
    memberFindingIds: Array.isArray(r.member_finding_ids) ? r.member_finding_ids : [],
    suspectedCommonCause: r.suspected_common_cause ?? null,
    advisory: r.advisory ?? null,
    status: r.status,
    detectedAt: iso(r.detected_at),
    resolvedAt: iso(r.resolved_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  });
  return {
    rows,
    create: overrides.create || (async (c) => {
      const id = (seq += 1);
      rows.push({
        id, confidence: 'low', member_finding_ids: [], suspected_common_cause: null, advisory: null,
        status: 'open', resolved_at: null, created_at: new Date(), updated_at: new Date(),
        ...c,
        member_finding_ids: c.memberFindingIds || [],
        suspected_common_cause: c.suspectedCommonCause ?? null,
        detected_at: c.detectedAt,
      });
      return id;
    }),
    findById: overrides.findById || (async (id) => { const r = rows.find((x) => x.id === Number(id)); return r ? mapOut(r) : null; }),
    listOpen: overrides.listOpen || (async () => rows
      .filter((r) => r.status === 'open')
      .sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at) || b.id - a.id)
      .map(mapOut)),
    updateMembership: overrides.updateMembership || (async (id, { confidence, memberFindingIds, suspectedCommonCause, detectedAt }) => {
      const r = rows.find((x) => x.id === Number(id) && x.status === 'open');
      if (!r) return false;
      r.confidence = confidence;
      r.member_finding_ids = memberFindingIds || [];
      r.suspected_common_cause = suspectedCommonCause ?? null;
      if (new Date(detectedAt) > new Date(r.detected_at)) r.detected_at = detectedAt;
      return true;
    }),
    setAdvisory: overrides.setAdvisory || (async (id, advisory) => {
      const r = rows.find((x) => x.id === Number(id) && x.status === 'open' && (x.advisory == null));
      if (!r) return false;
      r.advisory = advisory;
      return true;
    }),
    updateStatus: overrides.updateStatus || (async (id, { from, to, at = null }) => {
      const r = rows.find((x) => x.id === Number(id) && x.status === from);
      if (!r) return false;
      r.status = to;
      if (to === 'resolved' || to === 'closed') r.resolved_at = at;
      if (to === 'open') r.resolved_at = null;
      return true;
    }),
    listStaleOpen: overrides.listStaleOpen || (async (olderThan) => rows
      .filter((r) => r.status === 'open' && new Date(r.detected_at) < new Date(olderThan))
      .sort((a, b) => new Date(a.detected_at) - new Date(b.detected_at))
      .map(mapOut)),
    list: overrides.list || (async (f = {}) => rows
      .filter((r) => (!f.status || r.status === f.status))
      .sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at) || b.id - a.id)
      .map(mapOut)),
  };
}

// A fake remediation-playbooks repository (in-memory). Mirrors
// remediationPlaybooksRepository's surface for the recommendation read-model.
// Seed playbooks with `create()` and runs with `recordRun()`.
function makeRemediationPlaybooksRepo(overrides = {}) {
  const playbooks = [];
  const runs = [];
  let pbSeq = 0;
  let runSeq = 0;
  const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : new Date(v).toISOString()));
  const mapPb = (p) => ({
    id: p.id,
    name: p.name,
    triggerCondition: p.trigger_condition,
    actionType: p.action_type,
    autoTrigger: !!p.auto_trigger,
    manualActionText: p.manual_action_text ?? null,
    enabled: p.enabled == null ? true : !!p.enabled,
    createdAt: iso(p.created_at || new Date()),
  });
  const mapRun = (r) => {
    const pb = playbooks.find((p) => p.id === r.playbook_id);
    return {
      id: r.id,
      incidentCaseId: r.incident_case_id,
      playbookId: r.playbook_id,
      status: r.status,
      resultText: r.result_text ?? null,
      ranBy: r.ran_by ?? null,
      ranAt: iso(r.ran_at || new Date()),
      playbookName: pb ? pb.name : null,
      playbookActionType: pb ? pb.action_type : null,
    };
  };
  return {
    playbooks,
    runs,
    create: overrides.create || (async (p) => {
      const id = (pbSeq += 1);
      playbooks.push({ id, auto_trigger: 0, manual_action_text: null, enabled: 1, created_at: new Date(), ...p });
      return id;
    }),
    recordRun: overrides.recordRun || (async ({ incidentCaseId, playbookId, status = 'pending', resultText = null, ranBy = null, ranAt = null }) => {
      const id = (runSeq += 1);
      runs.push({ id, incident_case_id: incidentCaseId, playbook_id: playbookId, status, result_text: resultText, ran_by: ranBy, ran_at: ranAt || new Date() });
      return id;
    }),
    matchByAnomalyType: overrides.matchByAnomalyType || (async (anomalyType) => {
      if (anomalyType == null || anomalyType === '') return null;
      const hit = playbooks
        .filter((p) => (p.enabled == null ? true : !!p.enabled) && p.trigger_condition === anomalyType)
        .sort((a, b) => b.id - a.id)[0];
      return hit ? mapPb(hit) : null;
    }),
    findById: overrides.findById || (async (id) => { const p = playbooks.find((x) => x.id === Number(id)); return p ? mapPb(p) : null; }),
    list: overrides.list || (async () => playbooks.slice().sort((a, b) => b.id - a.id).map(mapPb)),
    listRunsForIncident: overrides.listRunsForIncident || (async (incidentCaseId) => runs
      .filter((r) => r.incident_case_id === Number(incidentCaseId))
      .sort((a, b) => new Date(b.ran_at) - new Date(a.ran_at) || b.id - a.id)
      .map(mapRun)),
  };
}

// A fake incident-case service (records calls; groups nothing by default).
function makeIncidentCaseService(overrides = {}) {
  const calls = [];
  return {
    calls,
    assignFinding: overrides.assignFinding || (async (finding) => { calls.push(finding); return null; }),
  };
}

// A fake config-snapshots repository (in-memory). Mirrors
// configSnapshotsRepository's surface for the device-config history/diff.
function makeConfigSnapshotsRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : new Date(v).toISOString()));
  const mapOut = (r, withText) => {
    const o = { id: r.id, deviceId: r.device_id, capturedAt: iso(r.captured_at), capturedVia: r.captured_via, createdAt: iso(r.created_at || r.captured_at) };
    if (withText) o.configText = r.config_text;
    return o;
  };
  const before = (a, b) => new Date(a.captured_at) - new Date(b.captured_at) || a.id - b.id;
  return {
    rows,
    insert: overrides.insert || (async ({ deviceId, configText, capturedVia = 'manual', capturedAt = null }) => {
      const id = (seq += 1);
      rows.push({ id, device_id: deviceId, config_text: configText, captured_via: capturedVia, captured_at: capturedAt || new Date(), created_at: new Date() });
      return id;
    }),
    findById: overrides.findById || (async (id) => { const r = rows.find((x) => x.id === Number(id)); return r ? mapOut(r, true) : null; }),
    listForDevice: overrides.listForDevice || (async (deviceId, { limit = 50, withText = false } = {}) => rows
      .filter((r) => r.device_id === deviceId)
      .sort((a, b) => before(b, a))
      .slice(0, limit)
      .map((r) => mapOut(r, withText))),
    previousBefore: overrides.previousBefore || (async (deviceId, id) => {
      const cur = rows.find((x) => x.id === Number(id));
      if (!cur) return null;
      const prev = rows
        .filter((r) => r.device_id === deviceId && r.id !== cur.id && before(r, cur) < 0)
        .sort((a, b) => before(b, a));
      return prev[0] ? mapOut(prev[0], true) : null;
    }),
    latestForDeviceBetween: overrides.latestForDeviceBetween || (async (deviceId, from, to) => {
      const match = rows
        .filter((r) => r.device_id === deviceId && new Date(r.captured_at) > new Date(from) && new Date(r.captured_at) <= new Date(to))
        .sort((a, b) => before(b, a));
      return match[0] ? mapOut(match[0], true) : null;
    }),
  };
}

// A fake incident-thresholds repository (in-memory) seeded with the same global
// defaults as migration 023, so the derivation service behaves as in production.
function makeIncidentThresholdsRepo(overrides = {}) {
  const rows = overrides.rows || [
    { id: 1, location_id: null, metric: 'reachability', warning_value: null, critical_value: null, debounce_count: 3 },
    { id: 2, location_id: null, metric: 'latency', warning_value: 150, critical_value: 300, debounce_count: 3 },
    { id: 3, location_id: null, metric: 'packet_loss', warning_value: 2, critical_value: 5, debounce_count: 3 },
  ];
  let seq = rows.length;
  return {
    rows,
    getEffective: overrides.getEffective || (async (locationId, metric) => {
      const loc = rows.find((r) => r.location_id === locationId && r.metric === metric);
      if (loc) return loc;
      return rows.find((r) => r.location_id == null && r.metric === metric) || null;
    }),
    listGlobal: overrides.listGlobal || (async () => rows.filter((r) => r.location_id == null)),
    listByLocation: overrides.listByLocation || (async (id) => rows.filter((r) => r.location_id === id)),
    findById: overrides.findById || (async (id) => rows.find((r) => r.id === id) || null),
    upsert: overrides.upsert || (async ({ location_id = null, metric, warning_value = null, critical_value = null, debounce_count = 3 }) => {
      let r = rows.find((x) => x.location_id === location_id && x.metric === metric);
      if (r) { Object.assign(r, { warning_value, critical_value, debounce_count }); return r; }
      r = { id: (seq += 1), location_id, metric, warning_value, critical_value, debounce_count };
      rows.push(r);
      return r;
    }),
  };
}

// A fake incident-derivation service (records calls; derives nothing by default).
function makeIncidentService(overrides = {}) {
  const calls = [];
  return {
    calls,
    processAgent: overrides.processAgent || (async (agentId) => { calls.push({ agentId }); return { opened: 0, resolved: 0 }; }),
  };
}

// A fake enrollment-codes repository.
function makeEnrollmentCodesRepo(overrides = {}) {
  return {
    create:
      overrides.create ||
      (async ({ code, location_id, created_by, maxUses = 1 }) => ({
        id: 1,
        code,
        location_id: location_id ?? null,
        created_by,
        expires_at: '2026-01-01T01:00:00.000Z',
        used_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
        max_uses: maxUses,
        uses_remaining: maxUses,
      })),
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    findByCode: overrides.findByCode || (async () => null),
    remove: overrides.remove || (async () => false),
  };
}

// A fake enrollment store (the atomic claim-and-enroll operation). The default
// honours bulk codes statefully so route-level N/N+1 tests work: seed remaining
// uses via overrides.remaining (default 1).
function makeEnrollmentStore(overrides = {}) {
  let remaining = overrides.remaining ?? 1;
  let nextId = 1;
  return {
    claimAndEnroll:
      overrides.claimAndEnroll ||
      (async () => {
        if (remaining <= 0) return { status: 'used' };
        remaining -= 1;
        return { status: 'ok', agentId: nextId++ };
      }),
  };
}

// A fake artifact store (one published linux-amd64 binary by default). Pass
// overrides to simulate an empty store or a throwing get() for 500 paths.
function makeArtifactStore(overrides = {}) {
  const entries = overrides.entries || {
    'linux-amd64': { platform: 'linux-amd64', filename: 'blueeye-agent-linux-amd64', path: '/dev/null', size: 3, sha256: 'a'.repeat(64), contentType: 'application/octet-stream' },
  };
  return {
    reload: overrides.reload || (() => {}),
    list: overrides.list || (() => Object.values(entries).map(({ path: _p, ...rest }) => rest)),
    get: overrides.get || ((p) => entries[String(p || '')] || null),
    has: overrides.has || ((p) => Boolean(entries[String(p || '')])),
    checksums: overrides.checksums || (() => { const o = {}; for (const k of Object.keys(entries)) o[k] = entries[k].sha256; return o; }),
    get size() { return Object.keys(entries).length; },
  };
}

// A fake agent-source store (one published source bundle by default). Pass
// { present: false } to simulate a server with no source configured, or a
// throwing meta()/buffer() to drive a 500.
function makeSourceStore(overrides = {}) {
  const has = overrides.present !== false;
  const sha = overrides.sha256 || 'c'.repeat(64);
  const buf = overrides.buf || Buffer.from('fake-agent-source-tarball');
  return {
    reload: overrides.reload || (() => {}),
    available: overrides.available || (() => has),
    buffer: overrides.buffer || (() => (has ? buf : null)),
    meta: overrides.meta || (() => (has ? { filename: 'blueeye-agent-source.tgz', contentType: 'application/gzip', size: buf.length, sha256: sha } : null)),
    uninstallScript: overrides.uninstallScript || (() => (has ? '#!/bin/sh\n# fake uninstall\n' : null)),
    sourceVersion: overrides.sourceVersion || (() => (has ? '0.1.0' : null)),
    get sha256() { return has ? sha : null; },
    get size() { return has ? buf.length : 0; },
  };
}

// A fake signed-release store. Records add() calls so a test can assert what was
// stored after a verified upload. latest()/get() default to "no releases".
function makeReleaseStore(overrides = {}) {
  const added = [];
  return {
    added,
    add: overrides.add || ((r) => { const meta = { ...r, createdAt: new Date().toISOString() }; added.push(meta); return meta; }),
    has: overrides.has || ((v) => added.some((r) => r.version === v)),
    list: overrides.list || (() => added.slice()),
    latest: overrides.latest || (() => (added.length ? added[added.length - 1] : null)),
    get: overrides.get || ((v) => added.find((r) => r.version === v) || null),
    reload: overrides.reload || (() => {}),
  };
}

// A fake agent-action audit repo (in-memory). Records 'requested' rows and lets
// complete() flip them terminal, so route tests can assert what was audited.
function makeAuditRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    record: overrides.record || (async (r) => { const id = (seq += 1); rows.push({ id, state: 'requested', requested_at: new Date().toISOString(), completed_at: null, result_detail: null, ...r }); return id; }),
    complete: overrides.complete || (async (id, { state, resultDetail = null }) => {
      const row = rows.find((x) => x.id === id && x.state === 'requested');
      if (!row) return false;
      row.state = state; row.result_detail = resultDetail; row.completed_at = new Date().toISOString();
      return true;
    }),
    findByAgent: overrides.findByAgent || (async (agentId) => rows.filter((x) => x.agentId === agentId).slice().reverse()),
    findByActor: overrides.findByActor || (async (userId) => rows.filter((x) => x.actorUserId === userId).slice().reverse()),
    findAll: overrides.findAll || (async () => rows.slice().reverse()),
  };
}

// A fake unified audit-events repo (in-memory). Mirrors the real repo's two
// write paths: record() always adds a row; recordRecurring() folds repeats onto
// one row keyed by dedupKey (bumping occurrences + self-measuring the interval).
function makeAuditEventsRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  const iso = (v) => (v == null ? null : (v instanceof Date ? v.toISOString() : new Date(v).toISOString()));
  return {
    rows,
    record: overrides.record || (async (e) => {
      const id = (seq += 1);
      const now = new Date().toISOString();
      rows.push({
        id, ts: now, actorType: e.actorType || 'user', actorId: e.actorId ?? null,
        actorLabel: e.actorLabel ?? null, actorRole: e.actorRole ?? null, action: e.action,
        targetType: e.targetType ?? null, targetId: e.targetId == null ? null : String(e.targetId),
        targetLabel: e.targetLabel ?? null, method: e.method ?? null, path: e.path ?? null,
        status: e.status ?? null, ip: e.ip ?? null, detail: e.detail ?? null,
        repeatIntervalMs: e.repeatIntervalMs ?? null, occurrences: 1,
        firstSeenAt: now, lastSeenAt: now, dedupKey: null,
      });
      return id;
    }),
    recordRecurring: overrides.recordRecurring || (async (e) => {
      if (!e.dedupKey) throw new Error('recordRecurring requires a dedupKey');
      const existing = rows.find((r) => r.dedupKey === e.dedupKey);
      const now = new Date();
      if (existing) {
        existing.occurrences += 1;
        if (existing.repeatIntervalMs == null) {
          existing.repeatIntervalMs = e.repeatIntervalMs
            ?? Math.max(0, Math.round((now.getTime() - new Date(existing.lastSeenAt).getTime())));
        }
        existing.lastSeenAt = now.toISOString();
        return;
      }
      const id = (seq += 1);
      rows.push({
        id, ts: now.toISOString(), actorType: e.actorType || 'agent', actorId: e.actorId ?? null,
        actorLabel: e.actorLabel ?? null, actorRole: e.actorRole ?? null, action: e.action,
        targetType: e.targetType ?? null, targetId: e.targetId == null ? null : String(e.targetId),
        targetLabel: e.targetLabel ?? null, method: null, path: null, status: null, ip: null,
        detail: e.detail ?? null, repeatIntervalMs: e.repeatIntervalMs ?? null, occurrences: 1,
        firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), dedupKey: e.dedupKey,
      });
    }),
    findAll: overrides.findAll || (async ({ actorType = null, action = null, limit = 100, offset = 0 } = {}) => {
      let out = rows.slice().sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
      if (actorType) out = out.filter((r) => r.actorType === actorType);
      if (action) out = out.filter((r) => r.action === action);
      return out.slice(offset, offset + Math.min(limit, 500)).map((r) => ({ ...r, ts: iso(r.ts) }));
    }),
    findByTarget: overrides.findByTarget || (async ({ targetType = null, targetId = null, from = null, to = null } = {}) => rows
      .filter((r) => (!targetType || r.targetType === targetType)
        && (targetId == null || r.targetId === String(targetId))
        && (!from || new Date(r.lastSeenAt) >= new Date(from))
        && (!to || new Date(r.lastSeenAt) <= new Date(to)))
      .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? -1 : 1))
      .map((r) => ({ ...r, ts: iso(r.ts) }))),
    distinctActions: overrides.distinctActions || (async () => [...new Set(rows.map((r) => r.action))].sort()),
  };
}

// A fake unified audit-log repo (in-memory). record() appends; list() filters by
// category/actor newest-first; categories() returns the distinct set.
function makeAuditLogRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    record: overrides.record || (async (e) => { const id = (seq += 1); rows.push({ id, created_at: new Date().toISOString(), outcome: 'success', ...e }); return id; }),
    list: overrides.list || (async ({ category = null, actorUserId = null, limit = 100 } = {}) =>
      rows.filter((r) => (!category || r.category === category) && (actorUserId == null || r.actorUserId === actorUserId))
        .slice().reverse().slice(0, limit)),
    categories: overrides.categories || (async () => [...new Set(rows.map((r) => r.category))].sort()),
    listByTarget: overrides.listByTarget || (async ({ category = null, target, limit = 200 } = {}) => rows
      .filter((r) => String(r.target) === String(target) && (!category || r.category === category))
      .slice(0, limit)),
    verifyChain: overrides.verifyChain || (async () => ({ ok: true, checked: rows.length, brokenAt: null })),
  };
}

// A fake API-tokens repo (in-memory). Mirrors apiTokensRepository's surface so
// both the admin routes and the auth middleware can be tested without a DB.
function makeApiTokensRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    create: overrides.create || (async ({ name, tokenHash, tokenPrefix, role = 'viewer', createdByUserId = null, expiresAt = null }) => {
      const row = { id: (seq += 1), name, token_prefix: tokenPrefix, token_hash: tokenHash, role, created_by_user_id: createdByUserId, created_at: new Date().toISOString(), last_used_at: null, expires_at: expiresAt, revoked_at: null };
      rows.push(row);
      const { token_hash, ...pub } = row;
      return { ...pub, revoked: false, expired: false };
    }),
    findById: overrides.findById || (async (id) => { const r = rows.find((x) => x.id === id); if (!r) return null; const { token_hash, ...pub } = r; return { ...pub, revoked: r.revoked_at != null, expired: false }; }),
    findAll: overrides.findAll || (async () => rows.map((r) => { const { token_hash, ...pub } = r; return { ...pub, revoked: r.revoked_at != null, expired: false }; })),
    findActiveByHash: overrides.findActiveByHash || (async (hash) => { const r = rows.find((x) => x.token_hash === hash); if (!r || r.revoked_at != null) return null; return { id: r.id, name: r.name, role: r.role, expires_at: r.expires_at, revoked_at: r.revoked_at }; }),
    touch: overrides.touch || (async (id) => { const r = rows.find((x) => x.id === id); if (r) r.last_used_at = new Date().toISOString(); }),
    revoke: overrides.revoke || (async (id) => { const r = rows.find((x) => x.id === id && x.revoked_at == null); if (!r) return false; r.revoked_at = new Date().toISOString(); return true; }),
  };
}

// A fake db with a ping() used by GET /health.
function makeDb(overrides = {}) {
  return {
    pool: overrides.pool || {},
    ping: overrides.ping || (async () => {}),
    close: overrides.close || (async () => {}),
  };
}

// A fake agent commander (push commands to agents over the WS). Defaults to
// "delivered to 1 connection"; sendCommandAndWait resolves with a benign ack.
function makeAgentCommander(overrides = {}) {
  return {
    sendCommand: overrides.sendCommand || (() => 1),
    sendCommandAndWait:
      overrides.sendCommandAndWait ||
      (async () => ({
        delivered: 1,
        acked: true,
        reply: { agentVersion: '0.1.0', sources: ['proc'], managed: 'systemd', accepted: true, runtime: 'systemd' },
      })),
    // Connection diagnosis + forced re-dial (GET /connection, POST /reconnect).
    // Defaults to "connected with one healthy session".
    getConnectionInfo:
      overrides.getConnectionInfo ||
      (() => ({
        connected: true,
        sockets: 1,
        session: { ip: '10.0.0.5', connectedAt: new Date().toISOString(), disconnectedAt: null, closeCode: null },
        licenseRejectedAt: null,
        authFailures: [],
        licenseAcceptsNew: true,
      })),
    disconnectAgent: overrides.disconnectAgent || (() => 1),
  };
}

// A fake system-info service (storage/disk + MySQL/TSDB database size).
function makeSystemInfo(overrides = {}) {
  return {
    getStorage:
      overrides.getStorage ||
      (async () => ({
        at: '2026-01-01T00:00:00.000Z',
        disk: { path: '/data', available: true, totalBytes: 100, usedBytes: 40, freeBytes: 60, usedPercent: 40 },
        database: { name: 'blueeye', totalBytes: 10, dataBytes: 8, indexBytes: 2, tableCount: 3, tables: [] },
        // TSDB off by default (the telemetry node isn't wired in most tests).
        tsdb: { configured: false },
        ingest: { minutes: 3, rows: 5, bytes: 1024, bytesPerDay: Math.round((1024 / 3) * 1440) },
      })),
    getIngest: overrides.getIngest || (async () => ({ minutes: 3, rows: 5, bytes: 1024, bytesPerDay: Math.round((1024 / 3) * 1440) })),
    getDisk: overrides.getDisk || (async () => ({ path: '/data', available: true })),
    getDatabase: overrides.getDatabase || (async () => ({ name: 'blueeye', totalBytes: 0, tables: [] })),
    getTsdb: overrides.getTsdb || (async () => ({ configured: false })),
  };
}

// A fake TimescaleDB client mirroring src/tsdb.js: a normalized
// `query(sql, params) -> rows[]` plus `databaseName`. `handler` receives the SQL
// and returns the rows for that query (default: empty). Used to exercise
// systemInfo.getTsdb without a real PostgreSQL/TimescaleDB node.
function makeTsdb(overrides = {}) {
  const handler = overrides.query || (async () => []);
  return {
    databaseName: overrides.databaseName || 'blueeye_telemetry',
    query: handler,
    ping: overrides.ping || (async () => {}),
    close: overrides.close || (async () => {}),
  };
}

// A fake license manager (defaults to a healthy, generous license).
function makeLicenseManager(overrides = {}) {
  const status = () => ({ status: 'valid', licensed: true, maxAgents: 1000, plan: overrides.plan || '', validUntil: overrides.validUntil || null, serverId: 'test-server' });
  return {
    isLicensed: overrides.isLicensed || (() => true),
    getMaxAgents: overrides.getMaxAgents || (() => 1000),
    getPlan: overrides.getPlan || (() => overrides.plan || ''),
    canAcceptNewConnection: overrides.canAcceptNewConnection || (() => true),
    getStatus: overrides.getStatus || status,
    getFeatures: overrides.getFeatures || (() => ({ analysis: true, assistant: true, alerting: true, geo: true })),
    validateOnce: overrides.validateOnce || (async () => (overrides.getStatus || status)()),
  };
}

// A fake feature gate. Allow-all by default so module tests are unaffected; pass
// { features: { geo: false, ... } } (or a custom isFeatureEnabled) to simulate a
// license that doesn't include a feature.
function makeFeatureGate(overrides = {}) {
  // Everything entitled by default (the four legacy modules + the packaged plan
  // keys exercised by routes). summary() keeps its legacy 4-key shape; plan keys
  // are only surfaced via isFeatureEnabled. Tests that need a denial pass an
  // explicit `features` map (or `isFeatureEnabled`).
  const enabled = overrides.features || {
    analysis: true, assistant: true, alerting: true, geo: true,
    sso_ldap: true, sso_oidc: true, sso_saml: true,
    dashboard_advanced: true,
    rbac: true, audit_log: true, api_access: true,
    reports_csv: true, reports_pdf: true, reports_compliance: true,
    alerts_email: true, alerts_webhook: true,
  };
  return {
    isFeatureEnabled: overrides.isFeatureEnabled || ((f) => enabled[f] === true),
    summary: overrides.summary || (() => ({ analysis: !!enabled.analysis, assistant: !!enabled.assistant, alerting: !!enabled.alerting, geo: !!enabled.geo })),
  };
}

// A fake analysis finding store (in-memory). Mirrors FindingStore's surface.
function makeFindingStore(overrides = {}) {
  const rows = [];
  return {
    rows,
    save: overrides.save || (async (f) => { const saved = { ...f, id: f.id || `f${rows.length + 1}`, acked: false }; rows.push(saved); return saved; }),
    list: overrides.list || (async (hostId, since) => rows.filter((f) => (!hostId || f.hostId === hostId) && (!since || new Date(f.createdAt || 0) >= new Date(since)))),
    listByIncidentCase: overrides.listByIncidentCase || (async (incidentCaseId) => rows
      .filter((f) => f.incidentCaseId === incidentCaseId)
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))),
    get: overrides.get || (async (id) => rows.find((f) => f.id === id) || null),
    ack: overrides.ack || (async (id) => { const f = rows.find((x) => x.id === id); if (!f) return false; f.acked = true; return true; }),
    setCorrelations: overrides.setCorrelations || (async (id, ids) => { const f = rows.find((x) => x.id === id); if (!f) return false; f.correlatedWith = Array.isArray(ids) ? ids : []; return true; }),
    setIncidentCase: overrides.setIncidentCase || (async (id, incidentCaseId) => { const f = rows.find((x) => x.id === id); if (!f) return false; f.incidentCaseId = incidentCaseId ?? null; return true; }),
  };
}

// A fake analysis pipeline (records calls; produces nothing by default).
function makeAnalysisPipeline(overrides = {}) {
  const calls = [];
  return {
    calls,
    processResults: overrides.processResults || (async (hostId, payloads) => { calls.push({ hostId, payloads }); return []; }),
  };
}

// A fake probe-analysis pipeline (records calls; produces nothing by default).
function makeProbePipeline(overrides = {}) {
  const calls = [];
  return {
    calls,
    processAgent: overrides.processAgent || (async (agentId) => { calls.push({ agentId }); return []; }),
  };
}

// A fake flows repository (records inserted rows; benign empty reads).
function makeFlowsRepo(overrides = {}) {
  const rows = [];
  return {
    rows,
    insertMany: overrides.insertMany || (async (records) => { for (const r of records) rows.push(r); return records.length; }),
    aggregateExternalDestinations: overrides.aggregateExternalDestinations || (async () => []),
    destinationExists: overrides.destinationExists || (async () => false),
    agentIdsForDestination: overrides.agentIdsForDestination || (async () => []),
    selectFlows: overrides.selectFlows || (async () => ({ byAsn: [], byDirection: [], byProto: [], series: [], totals: { bytes: 0, flowCount: 0, records: 0 } })),
    exploreFlows: overrides.exploreFlows || (async () => ({ topTalkers: [], byPort: [], byProto: [], series: [], scans: [], totals: { bytes: 0, packets: 0, flowCount: 0, records: 0 } })),
    topologyEdges: overrides.topologyEdges || (async () => []),
    agentIdsForIp: overrides.agentIdsForIp || (async () => []),
    agentIdsForPort: overrides.agentIdsForPort || (async () => []),
    asnSeries: overrides.asnSeries || (async () => []),
  };
}

// A fake flow pipeline (records calls; stores nothing by default).
function makeFlowPipeline(overrides = {}) {
  const calls = [];
  return {
    calls,
    processResults: overrides.processResults || (async (agentId, payloads) => { calls.push({ agentId, payloads }); return 0; }),
  };
}

// A fake alerting dispatcher (records dispatch calls; knows three channels).
function makeDispatcher(overrides = {}) {
  const calls = [];
  const clusterCalls = [];
  return {
    calls,
    clusterCalls,
    dispatch: overrides.dispatch || (async (finding, group) => { calls.push({ finding, group }); return { dispatched: true, results: [] }; }),
    dispatchCluster: overrides.dispatchCluster || (async (cluster, group) => { clusterCalls.push({ cluster, group }); return { dispatched: true, results: [] }; }),
    describe: overrides.describe || (() => ({ enabled: false, cooldownMs: 0, channels: {} })),
    channelNames: overrides.channelNames || (() => ['email', 'webhook', 'syslog']),
    test: overrides.test || (async (channel) => ({ channel, ok: true, detail: 'test' })),
  };
}

// A fake durable alert-dispatch log (in-memory, stateful) — mirrors
// alertDispatchLogRepository's surface for cluster-alert dedup + member referencing.
function makeAlertDispatchLogRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    record: overrides.record || (async (row) => { const id = (seq += 1); rows.push({ id, ...row }); return id; }),
    existsForCluster: overrides.existsForCluster || (async (clusterId) => rows.some((r) => r.subjectType === 'cluster' && String(r.subjectId) === String(clusterId))),
    listAlertedFindings: overrides.listAlertedFindings || (async (findingIds) => {
      const want = new Set((Array.isArray(findingIds) ? findingIds : []).map(String));
      return [...new Set(rows.filter((r) => r.subjectType === 'finding' && want.has(String(r.subjectId))).map((r) => String(r.subjectId)))];
    }),
    list: overrides.list || (async ({ subjectType = null } = {}) => rows.filter((r) => !subjectType || r.subjectType === subjectType)),
  };
}

// A real settings service backed by an in-memory store, so PUT validation and
// the effective-map overlay behave exactly as in production.
function makeSettingsService(overrides = {}) {
  const store = new Map(overrides.initial ? Object.entries(overrides.initial) : []);
  const settingsRepo = {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    set: async (k, v) => { store.set(k, v); return v; },
  };
  const config = {
    geo: { tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', tileAttribution: 'test', tileMaxZoom: 19, geocodeUrl: 'https://nominatim.example' },
    tsdb: { enabled: true, host: 'tsdb.example', port: 5432, user: 'blueeye_tsdb', password: 'super-secret-pw', database: 'blueeye_telemetry', connectionLimit: 10, connectionTimeoutMs: 5000 },
  };
  return createSettingsService({ settingsRepo, config });
}

// A fake AI assistant. Disabled by default (explain rejects with FeatureDisabled)
// so the endpoint answers 403 unless a test opts in with its own explain.
function makeAssistant(overrides = {}) {
  const disabled = () => { const e = new Error('The AI assistant is disabled'); e.name = 'FeatureDisabled'; throw e; };
  return {
    isEnabled: overrides.isEnabled || (() => Boolean(
      overrides.explain || overrides.summarizeLocation ||
      overrides.explainDiagnostic || overrides.narrateInvestigation ||
      overrides.askIncident || overrides.suggestRemediation || overrides.generateNis2Draft)),
    status: overrides.status || (() => ({ enabled: false, configured: false, baseUrl: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest' })),
    explain: overrides.explain || (async () => disabled()),
    explainDiagnostic: overrides.explainDiagnostic || (async () => disabled()),
    summarizeLocation: overrides.summarizeLocation || (async () => disabled()),
    narrateInvestigation: overrides.narrateInvestigation || (async () => disabled()),
    generateNis2Draft: overrides.generateNis2Draft || (async () => disabled()),
    askIncident: overrides.askIncident || (async () => disabled()),
    suggestRemediation: overrides.suggestRemediation || (async () => disabled()),
  };
}

// A fake test-packages repository (in-memory list; benign defaults).
function makeTestPackagesRepo(overrides = {}) {
  return {
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    findEnabledScheduled: overrides.findEnabledScheduled || (async () => []),
    create: overrides.create || (async (p) => ({ id: 1, last_run_at: null, last_run_summary: null, ...p })),
    update: overrides.update || (async (id, p) => ({ id, ...p })),
    remove: overrides.remove || (async () => false),
    setLastRun: overrides.setLastRun || (async () => {}),
  };
}

// A fake speed-test results repository (records inserts; benign empty reads).
function makeSpeedtestResultsRepo(overrides = {}) {
  const rows = [];
  return {
    rows,
    create: overrides.create || (async (agentId, r) => { rows.push({ agentId, ...r }); return rows.length; }),
    findByAgent: overrides.findByAgent || (async () => []),
    latestPerAgent: overrides.latestPerAgent || (async () => []),
  };
}

// A fake transactions repository (in-memory, stateful). Mirrors the real
// createTransactionsRepository contract (migration 046): tests (type
// http/tcp/dns/icmp + config incl. thresholds), agent assignments (join),
// results, and MAD baselines. Secrets are write-only — `secret_names` exposed,
// values only via testsForAgent/findByIdWithSecrets.
function makeTransactionsRepo(overrides = {}) {
  const rows = [];          // tests
  const assignments = [];   // { test_id, agent_id }
  const resultRows = [];    // { time, test_id, agent_id, status, latency_ms, step_timings, step_failed, deviation, detail }
  const baselines = [];     // { test_id, agent_id, step, median_ms, mad_ms, sample_count }
  let seq = 0;
  const agentIdsFor = (testId) => assignments.filter((a) => a.test_id === testId).map((a) => a.agent_id).sort((x, y) => x - y);
  const shape = (r, withSecrets = false) => {
    if (!r) return null;
    const base = {
      id: r.id, name: r.name, type: r.type, target: r.target ?? null, config: r.config || {},
      secret_names: Object.keys(r.secrets || {}), interval_sec: r.interval_sec ?? 60,
      enabled: r.enabled !== false, agent_ids: agentIdsFor(r.id),
      created_by: r.created_by ?? null, created_at: r.created_at,
    };
    if (withSecrets) base.secrets = { ...(r.secrets || {}) };
    return base;
  };
  return {
    rows, assignments, resultRows, baselines,
    list: overrides.list || (async () => rows.map((r) => shape(r))),
    findById: overrides.findById || (async (id) => shape(rows.find((r) => r.id === id)) || null),
    findByIdWithSecrets: overrides.findByIdWithSecrets || (async (id) => shape(rows.find((r) => r.id === id), true) || null),
    create: overrides.create || (async (p) => {
      const id = (seq += 1);
      const row = {
        id, name: p.name, type: p.type, target: p.target ?? null, config: p.config || {},
        secrets: p.secrets ? { ...p.secrets } : {}, interval_sec: p.interval_sec ?? 60,
        enabled: p.enabled !== false, created_by: p.created_by ?? null, created_at: '2026-01-01T00:00:00.000Z',
      };
      rows.push(row);
      return shape(row);
    }),
    update: overrides.update || (async (id, p) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      if (p.name !== undefined) row.name = p.name;
      if (p.type !== undefined) row.type = p.type;
      if (p.target !== undefined) row.target = p.target;
      if (p.config !== undefined) row.config = p.config;
      if (p.secrets !== undefined) row.secrets = p.secrets ? { ...p.secrets } : {};
      if (p.interval_sec !== undefined) row.interval_sec = p.interval_sec;
      if (p.enabled !== undefined) row.enabled = p.enabled;
      return shape(row);
    }),
    remove: overrides.remove || (async (id) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      for (let j = assignments.length - 1; j >= 0; j -= 1) if (assignments[j].test_id === id) assignments.splice(j, 1);
      return true;
    }),
    agentsFor: overrides.agentsFor || (async (testId) => agentIdsFor(testId)),
    setAgents: overrides.setAgents || (async (testId, agentIds) => {
      for (let j = assignments.length - 1; j >= 0; j -= 1) if (assignments[j].test_id === testId) assignments.splice(j, 1);
      for (const aid of agentIds) assignments.push({ test_id: testId, agent_id: aid });
      return agentIds.slice();
    }),
    testsForAgent: overrides.testsForAgent || (async (agentId) => rows
      .filter((r) => r.enabled !== false && assignments.some((a) => a.test_id === r.id && a.agent_id === agentId))
      .map((r) => shape(r, true))),
    assignedTestIds: overrides.assignedTestIds || (async (agentId) => new Set(assignments.filter((a) => a.agent_id === agentId).map((a) => a.test_id))),
    insertResults: overrides.insertResults || (async (batch) => { resultRows.push(...batch); return batch.length; }),
    results: overrides.results || (async ({ testId, agentId = null }) => resultRows
      .filter((r) => r.test_id === testId && (agentId == null || r.agent_id === agentId))),
    heatmap: overrides.heatmap || (async () => []),
    trend: overrides.trend || (async () => []),
    recentStatuses: overrides.recentStatuses || (async (testId, agentId, limit = 10) => resultRows
      .filter((r) => r.test_id === testId && r.agent_id === agentId)
      .slice(-limit).reverse().map((r) => r.status)),
    latestStatusPerAgent: overrides.latestStatusPerAgent || (async (testId) => {
      const byAgent = new Map();
      for (const r of resultRows.filter((x) => x.test_id === testId)) byAgent.set(r.agent_id, r);
      return [...byAgent.values()].map((r) => ({ agent_id: r.agent_id, status: r.status, time: r.time }));
    }),
    getBaseline: overrides.getBaseline || (async (testId, agentId, step) => baselines.find((b) => b.test_id === testId && b.agent_id === agentId && b.step === step) || null),
    upsertBaseline: overrides.upsertBaseline || (async (b) => {
      const ex = baselines.find((x) => x.test_id === b.test_id && x.agent_id === b.agent_id && x.step === b.step);
      if (ex) Object.assign(ex, b); else baselines.push({ ...b });
    }),
    assignedPairs: overrides.assignedPairs || (async () => assignments.map((a) => ({ test_id: a.test_id, agent_id: a.agent_id }))),
    okResultsSince: overrides.okResultsSince || (async ({ testId, agentId }) => resultRows
      .filter((r) => r.test_id === testId && r.agent_id === agentId && r.status === 'ok')
      .map((r) => ({ latency_ms: r.latency_ms, step_timings: r.step_timings || null }))),
  };
}

// A real in-memory log ring (small capacity) so the Logs route exercises the
// actual buffer behaviour. Seed records via .record(...) in a test.
function makeLogRing(overrides = {}) {
  return createLogRing({ capacity: overrides.capacity || 100 });
}

// A fake test-package runner; defaults to a benign run summary.
function makeTestPackageRunner(overrides = {}) {
  return {
    run: overrides.run || (async () => ({ at: '2026-01-01T00:00:00.000Z', targeted: 0, reached: 0, delivered: 0, items: 0 })),
    resolveTargetIds: overrides.resolveTargetIds || (() => []),
  };
}

// A real secret box with a fixed test key, so route encryption + dispatcher
// decryption round-trip exactly as in production.
function makeSecretBox(overrides = {}) {
  return createSecretBox({ key: overrides.key || 'test-secret-box-key-do-not-use-in-prod' });
}

// A real connector registry with an injected fetch (default: a benign 200), so
// the integrations route exercises the actual per-type config validation.
function makeConnectorRegistry(overrides = {}) {
  const fetchImpl = overrides.fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) }));
  return createConnectorRegistry({ fetchImpl });
}

// The CMDB connector registry (ServiceNow / Nautobot / custom) with an injected
// fetch, so the CMDB settings/search/test routes exercise the real connectors.
function makeCmdbConnectorRegistry(overrides = {}) {
  const fetchImpl = overrides.fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({}) }));
  return createCmdbConnectorRegistry({ fetchImpl });
}

// A fake integrations repository (stateful, in-memory). Mirrors the real safe-row
// vs. with-secret split so the CRUD route behaves end-to-end.
function makeIntegrationsRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  const safe = (r) => (r ? {
    id: r.id, type: r.type, name: r.name, base_url: r.base_url, auth_type: r.auth_type,
    enabled: r.enabled, config_json: r.config_json, created_at: r.created_at, updated_at: r.updated_at,
  } : null);
  return {
    rows,
    findAll: overrides.findAll || (async () => rows.map(safe)),
    findEnabled: overrides.findEnabled || (async () => rows.filter((r) => r.enabled).map(safe)),
    findById: overrides.findById || (async (id) => safe(rows.find((r) => r.id === id)) || null),
    findByIdWithSecret: overrides.findByIdWithSecret || (async (id) => { const r = rows.find((x) => x.id === id); return r ? { ...r } : null; }),
    findEnabledWithSecret: overrides.findEnabledWithSecret || (async () => rows.filter((r) => r.enabled).map((r) => ({ ...r }))),
    findByName: overrides.findByName || (async (name) => safe(rows.find((r) => r.name === name)) || null),
    create: overrides.create || (async (input) => {
      const id = (seq += 1);
      const row = {
        id, type: input.type, name: input.name, base_url: input.baseUrl, auth_type: input.authType,
        credentials_encrypted: input.credentialsEncrypted ?? null, enabled: input.enabled !== false,
        config_json: input.config || {}, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      };
      rows.push(row);
      return safe(row);
    }),
    update: overrides.update || (async (id, patch) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.baseUrl !== undefined) row.base_url = patch.baseUrl;
      if (patch.authType !== undefined) row.auth_type = patch.authType;
      if (patch.enabled !== undefined) row.enabled = patch.enabled;
      if (patch.config !== undefined) row.config_json = patch.config;
      if (patch.credentialsEncrypted !== undefined) row.credentials_encrypted = patch.credentialsEncrypted;
      return safe(row);
    }),
    remove: overrides.remove || (async (id) => { const i = rows.findIndex((r) => r.id === id); if (i < 0) return false; rows.splice(i, 1); return true; }),
  };
}

// A fake integration-audit repository (in-memory). Records dispatcher fires.
function makeIntegrationAuditRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    record: overrides.record || (async (r) => { const id = (seq += 1); rows.push({ id, created_at: new Date().toISOString(), ...r }); return id; }),
    findByIntegration: overrides.findByIntegration || (async (iid) => rows.filter((r) => r.integrationId === iid).slice().reverse()),
    findAll: overrides.findAll || (async () => rows.slice().reverse()),
  };
}

// A fake integrations dispatcher (records emits; benign test-fire). emitFinding /
// emitAgentEvent push synchronously so route tests can assert the wiring even
// though the routes fire-and-forget.
function makeIntegrationsDispatcher(overrides = {}) {
  const calls = [];
  return {
    calls,
    emit: overrides.emit || (async (event) => { calls.push(event); return { dispatched: 0, results: [] }; }),
    emitFinding: overrides.emitFinding || (async (finding) => { calls.push({ kind: 'finding', finding }); return { dispatched: 0, results: [] }; }),
    emitAgentEvent: overrides.emitAgentEvent || (async (kind, agent) => { calls.push({ kind: `agent.${kind}`, agent }); return { dispatched: 0, results: [] }; }),
    testFire: overrides.testFire || (async () => ({ ok: true, status: 201, detail: 'created (201)' })),
  };
}

// A fake CMDB config repository (stateful, in-memory singleton). Mirrors the real
// safe vs. with-secret split + the singleton upsert (editing clears verified_at).
// Seed a starting row with { row: { ... , credentials_encrypted } }.
function makeCmdbConfigRepo(overrides = {}) {
  let row = overrides.row || null; // a full (with-secret) row or null
  const safe = (r) => (r ? {
    id: r.id, type: r.type, base_url: r.base_url, auth_type: r.auth_type, config_json: r.config_json || {},
    enabled: r.enabled, verified_at: r.verified_at ?? null, updated_by: r.updated_by ?? null,
    created_at: r.created_at || '2026-01-01T00:00:00.000Z', updated_at: r.updated_at || '2026-01-01T00:00:00.000Z',
  } : null);
  return {
    get: overrides.get || (async () => safe(row)),
    getWithSecret: overrides.getWithSecret || (async () => (row ? { ...safe(row), credentials_encrypted: row.credentials_encrypted ?? null } : null)),
    upsert: overrides.upsert || (async (patch) => {
      if (!row) {
        row = {
          id: 1, type: patch.type, base_url: patch.baseUrl, auth_type: patch.authType ?? 'none',
          config_json: patch.config || {}, credentials_encrypted: patch.credentialsEncrypted ?? null,
          enabled: Boolean(patch.enabled), verified_at: null, updated_by: patch.updatedBy ?? null,
        };
        return safe(row);
      }
      row.verified_at = null; // editing invalidates the previous connection test
      if (patch.type !== undefined) row.type = patch.type;
      if (patch.baseUrl !== undefined) row.base_url = patch.baseUrl;
      if (patch.authType !== undefined) row.auth_type = patch.authType;
      if (patch.config !== undefined) row.config_json = patch.config;
      if (patch.credentialsEncrypted !== undefined) row.credentials_encrypted = patch.credentialsEncrypted;
      if (patch.enabled !== undefined) row.enabled = Boolean(patch.enabled);
      if (patch.updatedBy !== undefined) row.updated_by = patch.updatedBy;
      return safe(row);
    }),
    markVerified: overrides.markVerified || (async (at = new Date()) => {
      if (!row) return null;
      row.verified_at = at instanceof Date ? at.toISOString() : at;
      return safe(row);
    }),
  };
}

// A fake agent↔CMDB-asset links repository (stateful, in-memory). One row per
// agent, keyed by agent_id; set() upserts, remove() reports whether a row existed.
function makeAgentCmdbLinksRepo(overrides = {}) {
  const rows = overrides.rows || [];
  return {
    rows,
    get: overrides.get || (async (agentId) => rows.find((r) => r.agent_id === agentId) || null),
    set: overrides.set || (async (agentId, { cmdbAssetId, cmdbAssetName, cmdbAssetLocation = null, linkedBy = null }) => {
      let r = rows.find((x) => x.agent_id === agentId);
      if (r) { r.cmdb_asset_id = cmdbAssetId; r.cmdb_asset_name = cmdbAssetName; r.cmdb_asset_location = cmdbAssetLocation; r.linked_by = linkedBy; }
      else { r = { agent_id: agentId, cmdb_asset_id: cmdbAssetId, cmdb_asset_name: cmdbAssetName, cmdb_asset_location: cmdbAssetLocation, linked_by: linkedBy, linked_at: '2026-01-01T00:00:00.000Z' }; rows.push(r); }
      return { ...r };
    }),
    remove: overrides.remove || (async (agentId) => { const i = rows.findIndex((x) => x.agent_id === agentId); if (i < 0) return false; rows.splice(i, 1); return true; }),
  };
}

// A fake LDAP config repository (stateful, in-memory). Mirrors the safe vs.
// with-secret split + the upsert merge semantics of the real repo.
function makeLdapConfigRepo(overrides = {}) {
  let row = overrides.row || null; // a full (with-secret) row or null
  const safe = (r) => (r ? {
    id: r.id, host: r.host, port: r.port, use_tls: r.use_tls, bind_dn: r.bind_dn, base_dn: r.base_dn,
    user_filter: r.user_filter, group_filter: r.group_filter, enabled: r.enabled,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  } : null);
  return {
    get: overrides.get || (async () => safe(row)),
    getWithSecret: overrides.getWithSecret || (async () => (row ? { ...row, ...safe(row) } : null)),
    upsert: overrides.upsert || (async (patch) => {
      const prev = row || { id: 1, bind_pw_encrypted: null };
      row = {
        id: prev.id || 1,
        host: patch.host !== undefined ? patch.host : prev.host,
        port: patch.port !== undefined ? patch.port : (prev.port ?? 389),
        use_tls: patch.useTls !== undefined ? !!patch.useTls : !!prev.use_tls,
        bind_dn: patch.bindDn !== undefined ? patch.bindDn : (prev.bind_dn ?? null),
        bind_pw_encrypted: patch.bindPwEncrypted !== undefined ? patch.bindPwEncrypted : (prev.bind_pw_encrypted ?? null),
        base_dn: patch.baseDn !== undefined ? patch.baseDn : prev.base_dn,
        user_filter: patch.userFilter !== undefined ? patch.userFilter : (prev.user_filter ?? '(sAMAccountName={{username}})'),
        group_filter: patch.groupFilter !== undefined ? patch.groupFilter : (prev.group_filter ?? null),
        enabled: patch.enabled !== undefined ? !!patch.enabled : !!prev.enabled,
      };
      return safe(row);
    }),
  };
}

// A fake LDAP role-map repository (stateful, in-memory).
function makeLdapRoleMapRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    findAll: overrides.findAll || (async () => rows.slice()),
    findById: overrides.findById || (async (id) => rows.find((r) => r.id === id) || null),
    findByGroup: overrides.findByGroup || (async (dn) => rows.find((r) => r.ldap_group_dn === dn) || null),
    create: overrides.create || (async ({ groupDn, role }) => { const r = { id: (seq += 1), ldap_group_dn: groupDn, blueeye_role: role, created_at: '2026-01-01T00:00:00.000Z' }; rows.push(r); return r; }),
    update: overrides.update || (async (id, { groupDn, role }) => { const r = rows.find((x) => x.id === id); if (!r) return null; if (groupDn !== undefined) r.ldap_group_dn = groupDn; if (role !== undefined) r.blueeye_role = role; return r; }),
    remove: overrides.remove || (async (id) => { const i = rows.findIndex((r) => r.id === id); if (i < 0) return false; rows.splice(i, 1); return true; }),
  };
}

// A fake LDAP login-audit repository (in-memory).
function makeLdapLoginAuditRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    record: overrides.record || (async (r) => { const id = (seq += 1); rows.push({ id, created_at: new Date().toISOString(), ...r }); return id; }),
    findAll: overrides.findAll || (async () => rows.slice().reverse()),
  };
}

// A fake LDAP auth service. DISABLED by default so existing local-login tests are
// unaffected; opt in via overrides (isEnabled/authenticate).
function makeLdapAuth(overrides = {}) {
  return {
    isEnabled: overrides.isEnabled || (async () => false),
    authenticate: overrides.authenticate || (async () => ({ enabled: false })),
    testConnection: overrides.testConnection || (async () => ({ ok: true, detail: 'bound' })),
    resolveRole: overrides.resolveRole || (async () => ({ role: null, matched: 0 })),
  };
}

// ---- SSO (OIDC / SAML) ----------------------------------------------------

// A fake claim/attribute → role map repository (stateful, in-memory). Backs both
// the OIDC (claim_value) and SAML role-map routes — same shape, same surface.
function makeSsoRoleMapRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    findAll: overrides.findAll || (async () => rows.slice()),
    findById: overrides.findById || (async (id) => rows.find((r) => r.id === id) || null),
    findByClaim: overrides.findByClaim || (async (v) => rows.find((r) => r.claim_value === v) || null),
    create: overrides.create || (async ({ claimValue, role }) => { const r = { id: (seq += 1), claim_value: claimValue, blueeye_role: role, created_at: '2026-01-01T00:00:00.000Z' }; rows.push(r); return r; }),
    update: overrides.update || (async (id, { claimValue, role }) => { const r = rows.find((x) => x.id === id); if (!r) return null; if (claimValue !== undefined) r.claim_value = claimValue; if (role !== undefined) r.blueeye_role = role; return r; }),
    remove: overrides.remove || (async (id) => { const i = rows.findIndex((r) => r.id === id); if (i < 0) return false; rows.splice(i, 1); return true; }),
  };
}
const makeOidcRoleMapRepo = makeSsoRoleMapRepo;

// A fake shared SSO login-audit repository (in-memory).
function makeSsoLoginAuditRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    record: overrides.record || (async (r) => { const id = (seq += 1); rows.push({ id, created_at: new Date().toISOString(), ...r }); return id; }),
    findAll: overrides.findAll || (async ({ provider = null } = {}) => rows.filter((r) => !provider || r.provider === provider).slice().reverse()),
  };
}

// A fake OIDC auth service. DISABLED by default so existing local-login tests are
// unaffected; opt in via overrides (isEnabled/handleCallback/status).
function makeOidcAuth(overrides = {}) {
  return {
    isEnabled: overrides.isEnabled || (() => false),
    isConfigured: overrides.isConfigured || (() => false),
    licensed: overrides.licensed || (() => true),
    createLoginRequest: overrides.createLoginRequest || (async () => ({ url: 'https://idp.example/authorize?x=1', state: 's', nonce: 'n', codeVerifier: 'v' })),
    handleCallback: overrides.handleCallback || (async () => ({ ok: false, reason: 'disabled' })),
    resolveRole: overrides.resolveRole || (async () => ({ role: null, matched: 0 })),
    testDiscovery: overrides.testDiscovery || (async () => ({ ok: true, detail: 'discovered' })),
    status: overrides.status || (() => ({ authEnabledFlag: false, licensed: true, configured: false, enabled: false, issuer: '', clientId: '', redirectUri: '', scopes: 'openid email profile', roleClaim: 'groups', clientSecretSet: false })),
  };
}

// A fake SAML auth service. DISABLED by default; opt in via overrides.
function makeSamlAuth(overrides = {}) {
  return {
    isEnabled: overrides.isEnabled || (() => false),
    isConfigured: overrides.isConfigured || (() => false),
    licensed: overrides.licensed || (() => true),
    createLoginRequest: overrides.createLoginRequest || (async () => ({ url: 'https://idp.example/sso?SAMLRequest=x', requestId: 'r' })),
    handleResponse: overrides.handleResponse || (async () => ({ ok: false, reason: 'disabled' })),
    resolveRole: overrides.resolveRole || (async () => ({ role: null, matched: 0 })),
    metadata: overrides.metadata || (() => '<EntityDescriptor/>'),
    status: overrides.status || (() => ({ authEnabledFlag: false, licensed: true, configured: false, enabled: false, entryPoint: '', spEntityId: '', audience: '', idpEntityId: '', callbackUrl: '', roleAttribute: 'groups', idpCertSet: false })),
  };
}

// ---- NIS2 Reporting Center ------------------------------------------------

const { riskBand } = require('../src/nis2/constants');

// A fake NIS2 risk register (in-memory, stateful). risk_score is recomputed on
// write exactly like the real repo, so dashboard/score tests behave the same.
function makeNis2RisksRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  const map = (r) => ({ ...r, band: riskBand(r.riskScore) });
  const mk = (input, id) => ({
    id, title: input.title, description: input.description ?? null, category: input.category,
    affectedAsset: input.affectedAsset ?? null, likelihood: input.likelihood, impact: input.impact,
    riskScore: Number(input.likelihood) * Number(input.impact), owner: input.owner ?? null,
    status: input.status || 'open', mitigationPlan: input.mitigationPlan ?? null,
    dueDate: input.dueDate ?? null, managementAcceptance: !!input.managementAcceptance,
    evidenceLink: input.evidenceLink ?? null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  return {
    rows,
    findAll: overrides.findAll || (async ({ status = null, category = null } = {}) =>
      rows.filter((r) => (!status || r.status === status) && (!category || r.category === category)).map(map)),
    findById: overrides.findById || (async (id) => { const r = rows.find((x) => x.id === id); return r ? map(r) : null; }),
    create: overrides.create || (async (input) => { const r = mk(input, (seq += 1)); rows.push(r); return map(r); }),
    update: overrides.update || (async (id, input) => { const i = rows.findIndex((x) => x.id === id); if (i < 0) return null; rows[i] = mk(input, id); return map(rows[i]); }),
    remove: overrides.remove || (async (id) => { const i = rows.findIndex((x) => x.id === id); if (i < 0) return false; rows.splice(i, 1); return true; }),
  };
}

// A fake NIS2 controls repository (in-memory, stateful).
function makeNis2ControlsRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  const mk = (input, id) => ({
    id, controlName: input.controlName, nis2Area: input.nis2Area, description: input.description ?? null,
    owner: input.owner ?? null, frequency: input.frequency || 'quarterly', lastPerformed: input.lastPerformed ?? null,
    nextDue: input.nextDue ?? null, evidenceFile: input.evidenceFile ?? null,
    hasEvidence: !!(input.evidenceFile && String(input.evidenceFile).trim()),
    status: input.status || 'Missing', comment: input.comment ?? null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const needs = (c) => !c.hasEvidence || c.status === 'Missing' || c.status === 'Overdue';
  return {
    rows,
    findAll: overrides.findAll || (async ({ status = null, area = null } = {}) =>
      rows.filter((c) => (!status || c.status === status) && (!area || c.nis2Area === area))),
    findById: overrides.findById || (async (id) => rows.find((x) => x.id === id) || null),
    findWithoutEvidence: overrides.findWithoutEvidence || (async () => rows.filter(needs)),
    create: overrides.create || (async (input) => { const c = mk(input, (seq += 1)); rows.push(c); return c; }),
    update: overrides.update || (async (id, input) => { const i = rows.findIndex((x) => x.id === id); if (i < 0) return null; rows[i] = mk(input, id); return rows[i]; }),
    remove: overrides.remove || (async (id) => { const i = rows.findIndex((x) => x.id === id); if (i < 0) return false; rows.splice(i, 1); return true; }),
  };
}

// A fake NIS2 incidents repository (in-memory, stateful). Mints INC-YYYY-NNNN.
function makeNis2IncidentsRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  const mk = (input, id, ref) => ({
    id, incidentId: ref, title: input.title, severity: input.severity || 'medium',
    detectedAt: input.detectedAt ?? null, startedAt: input.startedAt ?? null, resolvedAt: input.resolvedAt ?? null,
    affectedSystems: input.affectedSystems ?? null, businessImpact: input.businessImpact ?? null,
    rootCause: input.rootCause ?? null, actionsTaken: input.actionsTaken ?? null,
    nis2Relevant: !!input.nis2Relevant, notificationRequired: !!input.notificationRequired,
    status: input.status || 'open', lessonsLearned: input.lessonsLearned ?? null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  return {
    rows,
    findAll: overrides.findAll || (async ({ status = null, severity = null, nis2Relevant = null } = {}) =>
      rows.filter((i) => (!status || i.status === status) && (!severity || i.severity === severity)
        && (nis2Relevant == null || i.nis2Relevant === nis2Relevant))),
    findById: overrides.findById || (async (id) => rows.find((x) => x.id === id) || null),
    create: overrides.create || (async (input) => { const id = (seq += 1); const r = mk(input, id, `INC-2026-${String(id).padStart(4, '0')}`); rows.push(r); return r; }),
    update: overrides.update || (async (id, input) => { const i = rows.findIndex((x) => x.id === id); if (i < 0) return null; rows[i] = mk(input, id, rows[i].incidentId); return rows[i]; }),
    remove: overrides.remove || (async (id) => { const i = rows.findIndex((x) => x.id === id); if (i < 0) return false; rows.splice(i, 1); return true; }),
    nextRef: overrides.nextRef || (async () => `INC-2026-${String(seq + 1).padStart(4, '0')}`),
  };
}

// A fake NIS2 reports repository (in-memory, stateful).
function makeNis2ReportsRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    findAll: overrides.findAll || (async ({ type = null } = {}) => rows.filter((r) => !type || r.reportType === type).slice().reverse()),
    findById: overrides.findById || (async (id) => rows.find((x) => x.id === id) || null),
    findLatest: overrides.findLatest || (async (type) => { const m = rows.filter((r) => r.reportType === type); return m.length ? m[m.length - 1] : null; }),
    create: overrides.create || (async (input) => {
      const r = {
        id: (seq += 1), reportType: input.reportType, title: input.title,
        periodStart: input.periodStart ?? null, periodEnd: input.periodEnd ?? null,
        status: input.status || 'draft', summary: input.summary ?? null, snapshot: input.snapshot ?? null,
        generatedBy: input.generatedBy ?? null, generatedByEmail: input.generatedByEmail ?? null,
        approvedBy: null, approvedByEmail: null, approvedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
      };
      rows.push(r); return r;
    }),
    approve: overrides.approve || (async (id, { approvedBy, approvedByEmail }) => {
      const r = rows.find((x) => x.id === id && x.status === 'draft');
      if (!r) return null;
      r.status = 'approved'; r.approvedBy = approvedBy ?? null; r.approvedByEmail = approvedByEmail ?? null; r.approvedAt = new Date().toISOString();
      return r;
    }),
    remove: overrides.remove || (async (id) => { const i = rows.findIndex((x) => x.id === id); if (i < 0) return false; rows.splice(i, 1); return true; }),
  };
}

// A fake NIS2 evidence repository (in-memory, stateful).
function makeNis2EvidenceRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    findAll: overrides.findAll || (async ({ entityType = null, entityId = null } = {}) =>
      rows.filter((e) => (!entityType || e.entityType === entityType) && (entityId == null || e.entityId === entityId)).slice().reverse()),
    findById: overrides.findById || (async (id) => rows.find((x) => x.id === id) || null),
    create: overrides.create || (async (input) => {
      const r = { id: (seq += 1), title: input.title, description: input.description ?? null, fileName: input.fileName ?? null,
        fileUrl: input.fileUrl ?? null, contentType: input.contentType ?? null, entityType: input.entityType ?? null,
        entityId: input.entityId ?? null, uploadedBy: input.uploadedBy ?? null, uploadedByEmail: input.uploadedByEmail ?? null,
        createdAt: '2026-01-01T00:00:00.000Z' };
      rows.push(r); return r;
    }),
    remove: overrides.remove || (async (id) => { const i = rows.findIndex((x) => x.id === id); if (i < 0) return false; rows.splice(i, 1); return true; }),
  };
}

// A fake NIS2 audit-log repository (in-memory). Records create/update/delete.
function makeNis2AuditRepo(overrides = {}) {
  const rows = [];
  let seq = 0;
  return {
    rows,
    record: overrides.record || (async (r) => { const id = (seq += 1); rows.push({ id, createdAt: new Date().toISOString(), ...r }); return id; }),
    findAll: overrides.findAll || (async ({ entityType = null, limit = 100 } = {}) =>
      rows.filter((r) => !entityType || r.entityType === entityType).slice().reverse().slice(0, limit)),
  };
}

// ---- App + auth helpers ---------------------------------------------------

// Builds an app wired with fakes; pass overrides to swap any dependency.
// A fake investigations repository (in-memory, stateful).
function makeInvestigationsRepo(overrides = {}) {
  const rows = [];
  return {
    rows,
    save: overrides.save || (async (inv) => {
      const saved = { ...inv, id: inv.id || `inv-${rows.length + 1}` };
      rows.push(saved);
      return saved;
    }),
    findById: overrides.findById || (async (id) => rows.find((r) => r.id === id) || null),
    list: overrides.list || (async ({ limit = 50, offset = 0 } = {}) =>
      rows.slice().reverse().slice(offset, offset + limit)),
  };
}

function makeApp(overrides = {}) {
  // Resolve the deps the plan/usage services build on, so the (real) services
  // can wrap them. Default plan resolution lands on the internal 'licensed'
  // plan → unlimited limits, so existing tests are unaffected; pass `plan:` to
  // makeLicenseManager (or your own planService/usageService) to exercise limits.
  const agentsRepo = overrides.agentsRepo || makeAgentsRepo();
  const testPackagesRepo = overrides.testPackagesRepo || makeTestPackagesRepo();
  const transactionsRepo = overrides.transactionsRepo || makeTransactionsRepo();
  const auditLogRepo = overrides.auditLogRepo || makeAuditLogRepo();
  const apiTokensRepo = overrides.apiTokensRepo || makeApiTokensRepo();
  const auditLogger = overrides.auditLogger || createAuditLogger({ auditLogRepo });
  const licenseManager = overrides.licenseManager || makeLicenseManager();
  const planService = overrides.planService || createPlanService({ licenseManager });
  const usageService =
    overrides.usageService || createUsageService({ agentsRepo, testPackagesRepo, planService, licenseManager });
  return createApp({
    db: overrides.db || makeDb(),
    tsdb: overrides.tsdb || null,
    resultsTsdbRepo: overrides.resultsTsdbRepo || null,
    locationsRepo: overrides.locationsRepo || makeLocationsRepo(),
    usersRepo: overrides.usersRepo || makeUsersRepo(),
    agentsRepo,
    enrollmentCodesRepo: overrides.enrollmentCodesRepo || makeEnrollmentCodesRepo(),
    enrollmentStore: overrides.enrollmentStore || makeEnrollmentStore(),
    agentTokensRepo: overrides.agentTokensRepo || makeAgentTokensRepo(),
    resultsRepo: overrides.resultsRepo || makeResultsRepo(),
    probeResultsRepo: overrides.probeResultsRepo || makeProbeResultsRepo(),
    incidentsRepo: overrides.incidentsRepo || makeIncidentsRepo(),
    incidentCasesRepo: overrides.incidentCasesRepo || makeIncidentCasesRepo(),
    remediationPlaybooksRepo: overrides.remediationPlaybooksRepo || makeRemediationPlaybooksRepo(),
    configSnapshotsRepo: overrides.configSnapshotsRepo || makeConfigSnapshotsRepo(),
    thresholdsRepo: overrides.thresholdsRepo || makeIncidentThresholdsRepo(),
    incidentService: overrides.incidentService || makeIncidentService(),
    installToolService: overrides.installToolService || null,
    licenseManager,
    planService,
    usageService,
    agentCommander: overrides.agentCommander || makeAgentCommander(),
    agentReconnect: overrides.agentReconnect || { waitMs: 200, pollMs: 10 },
    systemInfo: overrides.systemInfo || makeSystemInfo(),
    findingStore: overrides.findingStore || makeFindingStore(),
    analysisPipeline: overrides.analysisPipeline || makeAnalysisPipeline(),
    probePipeline: overrides.probePipeline || makeProbePipeline(),
    flowPipeline: overrides.flowPipeline || makeFlowPipeline(),
    flowsRepo: overrides.flowsRepo || makeFlowsRepo(),
    geoTileConfig: overrides.geoTileConfig || { tileUrl: 'https://tiles.example/{z}/{x}/{y}.png', tileAttribution: 'test', tileMaxZoom: 19 },
    geoProvider: overrides.geoProvider || null,
    centroids: overrides.centroids || null,
    assistant: overrides.assistant || makeAssistant(),
    dispatcher: overrides.dispatcher || makeDispatcher(),
    featureGate: overrides.featureGate || makeFeatureGate(),
    settingsService: overrides.settingsService || makeSettingsService(),
    analysisConfig: overrides.analysisConfig || { analysisEnabled: true, assistantEnabled: false, critSigma: 4, warnSigma: 3, baselineDays: 7, minSamples: 200 },
    retentionConfig: overrides.retentionConfig || { enabled: true, rawRetentionDays: 7, rollupRetentionDays: 90, findingRetentionDays: 365, rollupIntervalMinutes: 60 },
    artifactStore: overrides.artifactStore || makeArtifactStore(),
    agentSourceStore: overrides.agentSourceStore || makeSourceStore(),
    testPackagesRepo,
    testPackageRunner: overrides.testPackageRunner || makeTestPackageRunner(),
    transactionsRepo,
    logRing: overrides.logRing || makeLogRing(),
    speedtestResultsRepo: overrides.speedtestResultsRepo || makeSpeedtestResultsRepo(),
    releaseStore: overrides.releaseStore || makeReleaseStore(),
    releasePublicKey: overrides.releasePublicKey || '',
    releaseKeyService: overrides.releaseKeyService || makeReleaseKeyService(),
    auditRepo: overrides.auditRepo || makeAuditRepo(),
    auditEventsRepo: overrides.auditEventsRepo || makeAuditEventsRepo(),
    auditLogRepo,
    apiTokensRepo,
    auditLogger,
    integrationsRepo: overrides.integrationsRepo || makeIntegrationsRepo(),
    integrationAuditRepo: overrides.integrationAuditRepo || makeIntegrationAuditRepo(),
    integrationsDispatcher: overrides.integrationsDispatcher || makeIntegrationsDispatcher(),
    connectorRegistry: overrides.connectorRegistry || makeConnectorRegistry(),
    cmdbConnectorRegistry: overrides.cmdbConnectorRegistry || makeCmdbConnectorRegistry(),
    secretBox: overrides.secretBox || makeSecretBox(),
    cmdbConfigRepo: overrides.cmdbConfigRepo || makeCmdbConfigRepo(),
    agentCmdbLinksRepo: overrides.agentCmdbLinksRepo || makeAgentCmdbLinksRepo(),
    // Test area reachability probes: a benign 200 by default so route tests stay
    // offline; a test can inject its own to simulate an unreachable endpoint.
    diagnosticsFetch: overrides.diagnosticsFetch || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    // Geocoding proxy fetch: empty results by default so tests stay offline.
    geocodeFetch: overrides.geocodeFetch || (async () => ({ ok: true, status: 200, json: async () => [] })),
    ldapConfigRepo: overrides.ldapConfigRepo || makeLdapConfigRepo(),
    ldapRoleMapRepo: overrides.ldapRoleMapRepo || makeLdapRoleMapRepo(),
    ldapLoginAuditRepo: overrides.ldapLoginAuditRepo || makeLdapLoginAuditRepo(),
    ldapAuth: overrides.ldapAuth || makeLdapAuth(),
    ldapAuthEnabledFlag: overrides.ldapAuthEnabledFlag || false,
    oidcAuth: overrides.oidcAuth || makeOidcAuth(),
    oidcRoleMapRepo: overrides.oidcRoleMapRepo || makeOidcRoleMapRepo(),
    samlAuth: overrides.samlAuth || makeSamlAuth(),
    samlRoleMapRepo: overrides.samlRoleMapRepo || makeSsoRoleMapRepo(),
    ssoLoginAuditRepo: overrides.ssoLoginAuditRepo || makeSsoLoginAuditRepo(),
    nis2RisksRepo: overrides.nis2RisksRepo || makeNis2RisksRepo(),
    nis2ControlsRepo: overrides.nis2ControlsRepo || makeNis2ControlsRepo(),
    nis2IncidentsRepo: overrides.nis2IncidentsRepo || makeNis2IncidentsRepo(),
    nis2ReportsRepo: overrides.nis2ReportsRepo || makeNis2ReportsRepo(),
    nis2EvidenceRepo: overrides.nis2EvidenceRepo || makeNis2EvidenceRepo(),
    nis2AuditRepo: overrides.nis2AuditRepo || makeNis2AuditRepo(),
    investigationsRepo: overrides.investigationsRepo || makeInvestigationsRepo(),
    enrollConfig: overrides.enrollConfig || { publicUrl: '', certFingerprint: '' },
    notifyDashboard: overrides.notifyDashboard || (() => 0),
  });
}

// Fake agent-release signing key service. Configured by default so existing tests
// (which onboard agents / read settings) aren't gated; pass { configured: false } to
// exercise the "no key" gate, or override individual methods.
function makeReleaseKeyService(overrides = {}) {
  const configured = overrides.configured !== undefined ? overrides.configured : true;
  const okStatus = { configured: true, source: 'managed', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 1, fingerprint: 'f'.repeat(64), canSign: true };
  const noStatus = { configured: false, source: null, createdAt: null, createdBy: null, fingerprint: null, canSign: false };
  return {
    load: overrides.load || (async () => {}),
    getPublicKey: overrides.getPublicKey || (() => (configured ? '-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----' : '')),
    isConfigured: overrides.isConfigured || (() => configured),
    canSign: overrides.canSign || (() => configured),
    status: overrides.status || (() => (configured ? okStatus : noStatus)),
    generate: overrides.generate || (async () => okStatus),
    remove: overrides.remove || (async () => noStatus),
    sign: overrides.sign || (() => 'ZmFrZS1zaWc='),
  };
}

// Mints a real JWT for the given role (signed with the test secret).
function tokenFor(role, overrides = {}) {
  return issueToken({
    id: overrides.id ?? 1,
    email: overrides.email ?? `${role}@blueeye.local`,
    role,
  });
}

// Convenience: the value for an `Authorization` header.
function authHeader(role, overrides) {
  return `Bearer ${tokenFor(role, overrides)}`;
}

// Helper producing an async function that always rejects — to exercise the
// 500 / error-handler paths.
const throwingAsync = (message = 'simulated database failure') => async () => {
  throw new Error(message);
};

module.exports = {
  makeLocationsRepo,
  makeUsersRepo,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeResultsRepo,
  makeProbeResultsRepo,
  makeIncidentsRepo,
  makeIncidentCasesRepo,
  makeIncidentClustersRepo,
  makeAlertDispatchLogRepo,
  makeRemediationPlaybooksRepo,
  makeIncidentCaseService,
  makeConfigSnapshotsRepo,
  makeIncidentThresholdsRepo,
  makeIncidentService,
  makeEnrollmentCodesRepo,
  makeEnrollmentStore,
  makeArtifactStore,
  makeSourceStore,
  makeReleaseStore,
  makeReleaseKeyService,
  makeAuditRepo,
  makeAuditEventsRepo,
  makeAuditLogRepo,
  makeApiTokensRepo,
  makeTestPackagesRepo,
  makeTransactionsRepo,
  makeLogRing,
  makeTestPackageRunner,
  makeSpeedtestResultsRepo,
  makeLicenseManager,
  makeAgentCommander,
  makeSystemInfo,
  makeTsdb,
  makeFindingStore,
  makeAnalysisPipeline,
  makeProbePipeline,
  makeFlowsRepo,
  makeFlowPipeline,
  makeAssistant,
  makeDispatcher,
  makeFeatureGate,
  makeSettingsService,
  makeSecretBox,
  makeConnectorRegistry,
  makeCmdbConnectorRegistry,
  makeIntegrationsRepo,
  makeIntegrationAuditRepo,
  makeIntegrationsDispatcher,
  makeCmdbConfigRepo,
  makeAgentCmdbLinksRepo,
  makeLdapConfigRepo,
  makeLdapRoleMapRepo,
  makeLdapLoginAuditRepo,
  makeLdapAuth,
  makeSsoRoleMapRepo,
  makeOidcRoleMapRepo,
  makeSsoLoginAuditRepo,
  makeOidcAuth,
  makeSamlAuth,
  makeNis2RisksRepo,
  makeNis2ControlsRepo,
  makeNis2IncidentsRepo,
  makeNis2ReportsRepo,
  makeNis2EvidenceRepo,
  makeNis2AuditRepo,
  makeInvestigationsRepo,
  makeDb,
  makeApp,
  tokenFor,
  authHeader,
  throwingAsync,
};
