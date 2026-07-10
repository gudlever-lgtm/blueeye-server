'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildIncidentAskContext, gatherIncidentAskContext, maskIps, maskSecrets, maskConfigLine,
} = require('../src/incidentCases/askContext');
const {
  makeIncidentCasesRepo, makeFindingStore, makeAuditEventsRepo, makeAuditLogRepo, makeConfigSnapshotsRepo,
} = require('../test-support/fakes');

// ---- maskers ---------------------------------------------------------------

test('maskIps replaces IPv4 literals and CIDRs with [host]', () => {
  assert.equal(maskIps('route to 10.1.2.3 via 192.168.0.0/16'), 'route to [host] via [host]');
  assert.equal(maskIps('no ip here'), 'no ip here');
});

test('maskSecrets redacts the value of secret-bearing config lines', () => {
  assert.equal(maskSecrets('username admin password cisco123'), 'username admin password [redacted]');
  assert.equal(maskSecrets('enable secret 5 $1$abc$xyz'), 'enable secret [redacted]');
  assert.equal(maskSecrets('snmp-server community s3cr3t RO'), 'snmp-server community [redacted]');
  assert.equal(maskSecrets('interface Gi0/1'), 'interface Gi0/1'); // untouched
});

test('maskConfigLine masks both secrets and IPs', () => {
  // secret keyword redacts the value to EOL (swallowing the trailing IP too)
  assert.equal(maskConfigLine('tacacs key-string t0ps3cret host 10.0.0.1'), 'tacacs key-string [redacted]');
  // a non-secret line with an IP still gets the IP masked
  assert.equal(maskConfigLine('ip route 10.0.0.1 255.255.255.255'), 'ip route [host] [host]');
});

// ---- buildIncidentAskContext (pure) ----------------------------------------

const INCIDENT = { id: 3, status: 'investigating', severity: 'CRIT', hostId: '9', title: 'CRIT cpu on 10.0.0.9', firstEventAt: '2026-06-01T08:00:00Z', lastEventAt: '2026-06-01T08:10:00Z', resolvedAt: null };

test('empty incident yields empty context with hasAnyData=false', () => {
  const ctx = buildIncidentAskContext({ incident: INCIDENT });
  assert.deepEqual(ctx.timeline, []);
  assert.deepEqual(ctx.configContext, []);
  assert.deepEqual(ctx.similarIncidents, []);
  assert.equal(ctx.dataAvailability.hasAnyData, false);
  assert.deepEqual(ctx.dataAvailability, { timelineEvents: 0, configChanges: 0, similarIncidents: 0, hasAnyData: false });
});

test('MASKING GUARANTEE: raw config text and secrets never appear in the context', () => {
  const ctx = buildIncidentAskContext({
    incident: INCIDENT,
    timeline: [{ type: 'anomaly', timestamp: '2026-06-01T08:01:00Z', description: 'cpu spike on 10.0.0.9', severity: 'CRIT' }],
    configDiffs: [{
      snapshotId: 5, capturedAt: '2026-06-01T08:05:00Z', capturedVia: 'manual',
      stats: { added: 2, removed: 0 },
      changedLines: [
        { op: '+', text: 'snmp-server community s3cr3t RO' },
        { op: '+', text: 'ip route 10.9.9.9 255.255.255.255 password hunter2' },
      ],
    }],
  });
  const blob = JSON.stringify(ctx);
  // No secret value survives.
  assert.doesNotMatch(blob, /s3cr3t/);
  assert.doesNotMatch(blob, /hunter2/);
  // No raw IP literal survives (title, description and config lines all masked).
  assert.doesNotMatch(blob, /10\.0\.0\.9/);
  assert.doesNotMatch(blob, /10\.9\.9\.9/);
  // The redaction marker is present instead.
  assert.match(blob, /\[redacted\]/);
  assert.match(blob, /\[host\]/);
  // There is NEVER a raw config_text / configText field anywhere.
  assert.doesNotMatch(blob, /config_text/);
  assert.doesNotMatch(blob, /configText/);
});

test('config changed lines are capped and stats preserved', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ op: '+', text: `line ${i}` }));
  const ctx = buildIncidentAskContext({ incident: INCIDENT, configDiffs: [{ stats: { added: 100, removed: 0 }, changedLines: many }] });
  assert.equal(ctx.configContext[0].changedLines.length, 40); // MAX_CHANGED_LINES
  assert.deepEqual(ctx.configContext[0].stats, { added: 100, removed: 0 });
});

// ---- gatherIncidentAskContext (repo reads) ---------------------------------

test('gather returns null for an unknown incident (route → 404)', async () => {
  const ctx = await gatherIncidentAskContext(999, { incidentCasesRepo: makeIncidentCasesRepo(), findingStore: makeFindingStore() });
  assert.equal(ctx, null);
});

test('gather assembles timeline + config-context from all wired sources, masked', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo();
  const id = await incidentCasesRepo.create({ host_id: '9', title: 't', status: 'investigating', severity: 'CRIT', first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:10:00Z') });

  const findingStore = makeFindingStore();
  await findingStore.save({ id: 'a1', hostId: '9', metric: 'cpu', severity: 'CRIT', explanation: 'cpu spike', evidence: [{}], createdAt: new Date('2026-06-01T08:01:00Z') });
  await findingStore.setIncidentCase('a1', id);

  const auditEventsRepo = makeAuditEventsRepo();
  await auditEventsRepo.record({ actorType: 'user', action: 'agent.update', targetType: 'agent', targetId: '9' });

  const auditLogRepo = makeAuditLogRepo();
  await auditLogRepo.record({ category: 'incident', action: 'incident_status_change', target: String(id), detail: 'open→investigating' });

  const configSnapshotsRepo = makeConfigSnapshotsRepo();
  await configSnapshotsRepo.insert({ deviceId: 9, configText: 'hostname r9\n', capturedVia: 'manual', capturedAt: new Date('2026-06-01T07:00:00Z') });
  await configSnapshotsRepo.insert({ deviceId: 9, configText: 'hostname r9\nsnmp-server community s3cr3t RO\ninterface 10.5.5.5\n', capturedVia: 'manual', capturedAt: new Date('2026-06-01T08:05:00Z') });

  const ctx = await gatherIncidentAskContext(id, { incidentCasesRepo, findingStore, auditEventsRepo, auditLogRepo, configSnapshotsRepo });

  assert.equal(ctx.incident.id, id);
  assert.ok(ctx.dataAvailability.hasAnyData);
  const types = ctx.timeline.map((e) => e.type);
  assert.ok(types.includes('anomaly'));
  assert.ok(types.includes('config_change'));
  assert.ok(types.includes('status_change'));
  assert.equal(ctx.configContext.length, 1); // the changed snapshot
  assert.ok(ctx.configContext[0].stats.added >= 2);

  // Masking still holds end-to-end through gather.
  const blob = JSON.stringify(ctx);
  assert.doesNotMatch(blob, /s3cr3t/);
  assert.doesNotMatch(blob, /10\.5\.5\.5/);
  assert.doesNotMatch(blob, /config_text/);
});

test('gather degrades gracefully with no config repo (similar always empty until Fase 4)', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo();
  const id = await incidentCasesRepo.create({ host_id: '9', title: 't', status: 'open', severity: 'WARN', first_event_at: new Date(), last_event_at: new Date() });
  const ctx = await gatherIncidentAskContext(id, { incidentCasesRepo, findingStore: makeFindingStore() });
  assert.deepEqual(ctx.configContext, []);
  assert.deepEqual(ctx.similarIncidents, []);
});
