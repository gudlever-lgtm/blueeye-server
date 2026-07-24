'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseCidr, totalAddresses, inScope, expand } = require('../src/discovery/cidr');
const { createRateLimiter } = require('../src/discovery/rateLimiter');
const { createScanner, validateScope, DiscoveryScopeError } = require('../src/discovery/scanner');
const { createDiscoverySweepJob } = require('../src/discovery/discoverySweepJob');
const { makeDiscoveredDevicesRepo, makeAuditLogRepo } = require('../test-support/fakes');
const { createAuditLogger } = require('../src/services/complianceLogger');

const noWaitLimiter = { acquire: async () => {} };

// ---- CIDR math ---------------------------------------------------------------

test('parseCidr + totalAddresses count without enumerating', () => {
  assert.equal(parseCidr('10.0.0.0/24').count, 256);
  assert.equal(parseCidr('192.168.1.5/32').count, 1);
  assert.equal(parseCidr('nonsense'), null);
  assert.equal(parseCidr('10.0.0.0/33'), null);
  const t = totalAddresses(['10.0.0.0/30', '10.0.1.0/30']);
  assert.equal(t.count, 8);
  assert.equal(t.invalid.length, 0);
});

test('inScope only matches addresses inside the configured CIDRs', () => {
  const [p] = totalAddresses(['10.0.0.0/30']).cidrs;
  assert.equal(inScope('10.0.0.1', [p]), true);
  assert.equal(inScope('10.0.0.5', [p]), false);
  assert.equal(inScope('192.168.0.1', [p]), false);
  assert.deepEqual([...expand(p)], ['10.0.0.0', '10.0.0.1', '10.0.0.2', '10.0.0.3']);
});

// ---- Rate limiter ------------------------------------------------------------

test('rate limiter paces grants evenly at the configured rate', async () => {
  let clock = 0;
  const limiter = createRateLimiter({ ratePerSec: 50, now: () => clock, sleep: async (ms) => { clock += ms; } });
  const grants = [];
  for (let i = 0; i < 5; i += 1) grants.push(await limiter.acquire()); // eslint-disable-line no-await-in-loop
  // 50/s → one every 20ms.
  assert.deepEqual(grants, [0, 20, 40, 60, 80]);
  assert.equal(limiter.intervalMs, 20);
});

// ---- Scope enforcement + cap refusal -----------------------------------------

test('validateScope refuses empty, invalid, and over-cap scopes', () => {
  assert.throws(() => validateScope({ cidrs: [], addressCap: 65536 }), (e) => e.code === 'scope_unconfigured');
  assert.throws(() => validateScope({ cidrs: ['garbage'], addressCap: 65536 }), (e) => e.code === 'scope_invalid');
  assert.throws(() => validateScope({ cidrs: ['10.0.0.0/8'], addressCap: 65536 }), (e) => e.code === 'scope_too_large');
  assert.ok(validateScope({ cidrs: ['10.0.0.0/24'], addressCap: 65536 }).count === 256);
});

test('scanner probes ONLY addresses inside the configured scope', async () => {
  const probed = [];
  const scanner = createScanner({
    tcpProbe: async (ip, port) => { probed.push(`${ip}:${port}`); return ip === '10.0.0.2' && port === 80; },
    icmpProbe: async () => null,
    dnsReverse: async () => 'host.example',
    ports: [80, 443],
  });
  const { candidates, probed: probedIps } = await scanner.scan({ cidrs: ['10.0.0.0/30'], addressCap: 65536, rateLimiter: noWaitLimiter });

  // Every probed address is inside 10.0.0.0/30 — nothing outside scope, ever.
  const [p] = totalAddresses(['10.0.0.0/30']).cidrs;
  for (const ip of probedIps) assert.ok(inScope(ip, [p]), `${ip} out of scope`);
  for (const key of probed) assert.ok(key.startsWith('10.0.0.'), `${key} out of scope`);
  // 10.0.0.2:80 open → a candidate; others (no open port, icmp null) → not.
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].ip, '10.0.0.2');
  assert.deepEqual(candidates[0].openPorts, [80]);
  assert.equal(candidates[0].hostname, 'host.example');
});

test('scanner refuses an over-cap scope before probing anything', async () => {
  const probed = [];
  const scanner = createScanner({ tcpProbe: async (ip) => { probed.push(ip); return false; }, icmpProbe: async () => null });
  await assert.rejects(
    scanner.scan({ cidrs: ['10.0.0.0/16'], addressCap: 1024, rateLimiter: noWaitLimiter }),
    (e) => e instanceof DiscoveryScopeError && e.code === 'scope_too_large',
  );
  assert.equal(probed.length, 0); // nothing was probed
});

// ---- Sweep job (scope → candidates → audit; never enrols) --------------------

function jobHarness(cfg) {
  const discoveredDevicesRepo = makeDiscoveredDevicesRepo();
  const auditLogRepo = makeAuditLogRepo();
  const auditLogger = createAuditLogger({ auditLogRepo });
  const scanner = createScanner({
    tcpProbe: async (ip, port) => ip === '10.0.0.2' && port === 80,
    icmpProbe: async () => null,
    dnsReverse: async () => null,
    ports: [80],
  });
  const job = createDiscoverySweepJob({ discoveredDevicesRepo, scanner, auditLogger, config: cfg, now: () => new Date('2026-07-24T12:00:00Z') });
  return { job, discoveredDevicesRepo, auditLogRepo };
}

test('sweep upserts candidates and audits scope/start/end/count — never enrols', async () => {
  const h = jobHarness({ enabled: true, cidrs: ['10.0.0.0/30'], ports: [80], rateLimit: 100000, addressCap: 65536, intervalMinutes: 360 });
  const res = await h.job.run();
  assert.equal(res.found, 1);
  assert.equal(h.discoveredDevicesRepo.rows.length, 1);
  assert.equal(h.discoveredDevicesRepo.rows[0].ip, '10.0.0.2');
  assert.equal(h.discoveredDevicesRepo.rows[0].status, 'discovered'); // NOT auto-promoted
  const sweep = h.auditLogRepo.rows.find((r) => r.action === 'discovery_sweep');
  assert.ok(sweep, 'sweep audited');
  assert.ok(sweep.detail.includes('found=1') && sweep.detail.includes('start=') && sweep.detail.includes('end='));
  assert.equal(sweep.actorRole, 'system');
});

test('sweep refuses (and audits the refusal) for an over-cap scope', async () => {
  const h = jobHarness({ enabled: true, cidrs: ['10.0.0.0/8'], ports: [80], rateLimit: 100000, addressCap: 1024, intervalMinutes: 360 });
  const res = await h.job.run();
  assert.deepEqual(res, { refused: true, reason: 'scope_too_large' });
  assert.equal(h.discoveredDevicesRepo.rows.length, 0);
  assert.ok(h.auditLogRepo.rows.find((r) => r.action === 'discovery_sweep_refused'));
});

test('sweep refuses when scope is unconfigured', async () => {
  const h = jobHarness({ enabled: true, cidrs: [], ports: [80], rateLimit: 100000, addressCap: 65536, intervalMinutes: 360 });
  const res = await h.job.run();
  assert.equal(res.reason, 'scope_unconfigured');
  assert.equal(h.discoveredDevicesRepo.rows.length, 0);
});
