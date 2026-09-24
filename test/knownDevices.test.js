'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// The two ways the new-device detector (src/discovery/newDeviceDetector.js)
// reported one device more than once:
//
//   (a) found by a discovery sweep (by IP), then seen in an ARP table (with its
//       MAC) — two findings for one device;
//   (b) away for longer than the 30-day ARP window, then back — "never seen
//       before" again. The known-device memory (known_devices, migration 131)
//       is what fixes it.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createNewDeviceDetector, withArpDetection, withDiscoveryDetection } = require('../src/discovery/newDeviceDetector');
const { createKnownDevicesRepository, scopeKey } = require('../src/repositories/knownDevicesRepository');
const { makeArpEntriesRepo, makeDiscoveredDevicesRepo } = require('../test-support/fakes');

const NOW = new Date('2026-09-23T12:00:00Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(NOW.getTime() - ms);

const agentsRepo = {
  async findById(id) {
    const rows = {
      9: { id: 9, hostname: 'plc-gw', display_name: 'PLC gateway', location_id: 3 },
      10: { id: 10, hostname: 'scada-01', display_name: null, location_id: 3 },
      12: { id: 12, hostname: 'other-site', display_name: null, location_id: 4 },
      11: { id: 11, hostname: 'lonely', display_name: null, location_id: null },
    };
    return rows[Number(id)] || null;
  },
};
const locationsRepo = { async findById(id) { return { id: Number(id), name: `Site ${id}` }; } };
const config = { enabled: true, baselineHours: 24, maxPerHour: 20, severity: 'WARN' };

function makeStore() {
  const saved = [];
  return { saved, async save(f) { saved.push(f); return { ...f }; } };
}

// In-memory known_devices with the real repository's contract.
function makeKnownDevices({ failReads = false } = {}) {
  const rows = new Map(); // `${scope}|${mac}` -> row
  return {
    rows,
    async knownMacs({ scope, macs }) {
      if (failReads) throw new Error('ER_NO_SUCH_TABLE');
      return new Set((macs || []).filter((m) => rows.has(`${scope}|${m}`)));
    },
    async touchMany(scope, entries, at) {
      for (const e of entries) {
        const k = `${scope}|${e.mac}`;
        const r = rows.get(k);
        if (r) { r.lastSeen = new Date(Math.max(r.lastSeen, at)); r.lastIp = e.ip || r.lastIp; } else {
          rows.set(k, { scope, mac: e.mac, firstSeen: at, lastSeen: at, lastIp: e.ip || null });
        }
      }
      return entries.length;
    },
  };
}

// Agent 9 (site 3) has held an ARP baseline for 60 days.
async function baselineArp() {
  const arp = makeArpEntriesRepo({ agentSite: { 9: 3, 10: 3, 11: null, 12: 4 } });
  await arp.upsertMany(9, [{ ip: '10.20.0.1', mac: '00:00:0c:aa:bb:01' }], { at: ago(60 * DAY) });
  return arp;
}

// Discovery has run for three days (its own baseline is well past).
async function baselineDiscovery() {
  const repo = makeDiscoveredDevicesRepo();
  await repo.upsertCandidate({ ip: '10.20.0.1', seenAt: ago(72 * HOUR) });
  return repo;
}

function detector(deps) {
  const findingStore = makeStore();
  const d = createNewDeviceDetector({
    agentsRepo, locationsRepo, findingStore, config, now: () => NOW, ...deps,
  });
  return { d, findingStore };
}

async function observe(d, arp, agentId, entries, at = NOW) {
  const pending = await d.checkArp(agentId, entries);
  await arp.upsertMany(agentId, entries, { at });
  const out = await d.raiseArp(pending);
  await d.rememberArp(agentId, entries, at);
  return out;
}

async function eventually(fn, ms = 500) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5));
  }
  return fn();
}

// ================================================= (b) the long memory
test('(b) a device back after the ARP window is NOT new: the known-device memory still has it', async () => {
  const arp = await baselineArp();
  const known = makeKnownDevices();
  const { d, findingStore } = detector({ arpEntriesRepo: arp, knownDevicesRepo: known });

  // Seen 45 days ago, when the agent already had its baseline — then away.
  const laptop = { ip: '10.20.0.77', mac: '00:1b:1b:77:77:77' };
  await known.touchMany('site:3', [laptop], ago(45 * DAY));
  // Its arp_entries row aged out (RETENTION_ARP_DAYS = 30): the ARP table has
  // no memory of it at all.
  assert.equal(arp.rows.some((r) => r.mac === laptop.mac), false);

  const out = await observe(d, arp, 9, [{ ...laptop, ip: '10.20.0.78' }]);
  assert.deepEqual(out, []);
  assert.equal(findingStore.saved.length, 0, 'a returning device is not "never seen before"');
  const row = known.rows.get(`site:3|${laptop.mac}`);
  assert.equal(row.firstSeen.getTime(), ago(45 * DAY).getTime(), 'first_seen is kept');
  assert.equal(row.lastSeen.getTime(), NOW.getTime(), 'last_seen follows the device');
  assert.equal(row.lastIp, '10.20.0.78');
});

test('(b) a MAC the memory has never had is still new, and the explanation says the memory was asked', async () => {
  const arp = await baselineArp();
  const known = makeKnownDevices();
  const { d, findingStore } = detector({ arpEntriesRepo: arp, knownDevicesRepo: known });
  const out = await observe(d, arp, 9, [{ ip: '10.20.0.90', mac: '00:1b:1b:90:90:90' }]);
  assert.equal(out.length, 1);
  assert.match(findingStore.saved[0].explanation, /known-device memory/);
  assert.ok(known.rows.has('site:3|00:1b:1b:90:90:90'), 'and it is remembered from now on');
});

test('(b) the memory is per site: another site having seen the MAC does not make it known here', async () => {
  const arp = await baselineArp();
  const known = makeKnownDevices();
  await known.touchMany('site:4', [{ ip: '10.40.0.5', mac: '00:1b:1b:44:44:44' }], ago(10 * DAY));
  const { d } = detector({ arpEntriesRepo: arp, knownDevicesRepo: known });
  assert.equal((await observe(d, arp, 9, [{ ip: '10.20.0.44', mac: '00:1b:1b:44:44:44' }])).length, 1);
});

test('(b) withArpDetection records EVERY MAC of a report, known or new, without awaiting it', async () => {
  const arp = await baselineArp();
  const known = makeKnownDevices();
  const { d } = detector({ arpEntriesRepo: arp, knownDevicesRepo: known });
  const wrapped = withArpDetection(arp, d);
  await wrapped.upsertMany(9, [
    { ip: '10.20.0.1', mac: '00:00:0c:aa:bb:01' }, // already in arp_entries
    { ip: '10.20.0.91', mac: '00:1b:1b:91:91:91' }, // new
  ], { at: NOW });
  assert.ok(await eventually(() => known.rows.size === 2));
  assert.ok(known.rows.has('site:3|00:00:0c:aa:bb:01'));
});

test('(b) an agent without a site is remembered under its own scope', async () => {
  assert.equal(scopeKey({ siteId: 3, agentId: 9 }), 'site:3');
  assert.equal(scopeKey({ siteId: null, agentId: 11 }), 'agent:11');
  assert.equal(scopeKey({}), null);
  const arp = makeArpEntriesRepo({ agentSite: { 11: null } });
  await arp.upsertMany(11, [{ ip: '10.9.0.1', mac: '02:00:00:00:00:01' }], { at: ago(60 * DAY) });
  const known = makeKnownDevices();
  const { d } = detector({ arpEntriesRepo: arp, knownDevicesRepo: known });
  await d.rememberArp(11, [{ ip: '10.9.0.2', mac: '02:00:00:00:00:02' }], NOW);
  assert.ok(known.rows.has('agent:11|02:00:00:00:00:02'));
});

test('(b) a memory that cannot be read degrades to the ARP-only verdict, never to silence or a throw', async () => {
  const arp = await baselineArp();
  const warnings = [];
  const { d } = detector({
    arpEntriesRepo: arp, knownDevicesRepo: makeKnownDevices({ failReads: true }), logger: { warn: (m) => warnings.push(m), info() {} },
  });
  const out = await observe(d, arp, 9, [{ ip: '10.20.0.92', mac: '00:1b:1b:92:92:92' }]);
  assert.equal(out.length, 1);
  assert.ok(warnings.some((w) => /known-device memory/.test(w)));
});

// ========================================= (a) discovery first, then ARP
test('(a) discovery reports the IP, then ARP sees it with a MAC: ONE finding, not two', async () => {
  const arp = await baselineArp();
  const discovered = await baselineDiscovery();
  const known = makeKnownDevices();
  const logs = [];
  const { d, findingStore } = detector({
    arpEntriesRepo: arp, discoveredDevicesRepo: discovered, knownDevicesRepo: known,
    logger: { warn() {}, info: (m) => logs.push(m) },
  });

  await withDiscoveryDetection(discovered, d).upsertCandidate({ ip: '10.20.0.150', hostname: 'rtu-7', seenAt: ago(HOUR), foundByAgentId: 9 });
  assert.ok(await eventually(() => findingStore.saved.length === 1));
  assert.equal(findingStore.saved[0].evidence[0].labels.source, 'discovery');

  const out = await observe(d, arp, 9, [{ ip: '10.20.0.150', mac: '00:1b:1b:15:01:50' }]);
  assert.deepEqual(out, [], 'the ARP sighting of the same device is not a second finding');
  assert.equal(findingStore.saved.length, 1);
  assert.ok(logs.some((m) => /10\.20\.0\.150 .* already reported by discovery/.test(m)), 'the suppression is logged');
  assert.ok(known.rows.has('site:3|00:1b:1b:15:01:50'), 'the MAC is still remembered');
});

test('(a) the suppression survives a restart: the candidate row says discovery reported it', async () => {
  const arp = await baselineArp();
  const discovered = await baselineDiscovery();
  // Found two hours ago by agent 10 (same site), after discovery's baseline —
  // by a previous process, so this detector has no memory of raising it.
  await discovered.upsertCandidate({ ip: '10.20.0.151', seenAt: ago(2 * HOUR), foundByAgentId: 10 });
  const { d, findingStore } = detector({ arpEntriesRepo: arp, discoveredDevicesRepo: discovered });
  assert.deepEqual(await observe(d, arp, 9, [{ ip: '10.20.0.151', mac: '00:1b:1b:15:01:51' }]), []);
  assert.equal(findingStore.saved.length, 0);
});

test('(a) but ARP still reports when discovery did not: outside the window, in its baseline, or at another site', async () => {
  const arp = await baselineArp();
  const discovered = await baselineDiscovery();
  // Outside the 24 h window: discovery found the IP two days ago. A MAC new
  // to the site behind a long-known address is its own event.
  await discovered.upsertCandidate({ ip: '10.20.0.160', seenAt: ago(48 * HOUR), foundByAgentId: 9 });
  // Found by an agent at ANOTHER site: same private address, different device.
  await discovered.upsertCandidate({ ip: '10.20.0.161', seenAt: ago(HOUR), foundByAgentId: 12 });
  const { d, findingStore } = detector({ arpEntriesRepo: arp, discoveredDevicesRepo: discovered });
  const out = await observe(d, arp, 9, [
    { ip: '10.20.0.160', mac: '00:1b:1b:16:01:60' },
    { ip: '10.20.0.161', mac: '00:1b:1b:16:01:61' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(findingStore.saved.length, 2);

  // Discovery's own first sweep was a baseline, not a report: an ARP sighting
  // of an address from it is judged by ARP alone.
  const fresh = makeDiscoveredDevicesRepo();
  await fresh.upsertCandidate({ ip: '10.20.0.170', seenAt: ago(HOUR) });
  const second = detector({ arpEntriesRepo: arp, discoveredDevicesRepo: fresh });
  assert.equal((await observe(second.d, arp, 9, [{ ip: '10.20.0.170', mac: '00:1b:1b:17:01:70' }])).length, 1);
});

// ============================================ the repository's SQL contract
function scriptedPool(result) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return [result]; } };
}

test('knownDevicesRepository.knownMacs: one bounded IN () read per scope; nothing to ask, no query', async () => {
  const pool = scriptedPool([{ mac: 'aa:aa:aa:aa:aa:01' }]);
  const repo = createKnownDevicesRepository({ pool });
  const out = await repo.knownMacs({ scope: 'site:3', macs: ['aa:aa:aa:aa:aa:01', 'aa:aa:aa:aa:aa:02', 'aa:aa:aa:aa:aa:01'] });
  assert.deepEqual([...out], ['aa:aa:aa:aa:aa:01']);
  assert.equal(pool.calls[0].sql, 'SELECT mac FROM known_devices WHERE scope = ? AND mac IN (?)');
  assert.deepEqual(pool.calls[0].params, ['site:3', ['aa:aa:aa:aa:aa:01', 'aa:aa:aa:aa:aa:02']]);
  assert.equal((await repo.knownMacs({ scope: 'site:3', macs: [] })).size, 0);
  assert.equal((await repo.knownMacs({ scope: null, macs: ['x'] })).size, 0);
  assert.equal(pool.calls.length, 1);
});

test('knownDevicesRepository.touchMany: upsert keeps first_seen, never moves last_seen backwards', async () => {
  const pool = scriptedPool({ affectedRows: 2 });
  const repo = createKnownDevicesRepository({ pool });
  const at = new Date('2026-09-23T12:00:00Z');
  const n = await repo.touchMany('agent:11', [
    { ip: '10.0.0.1', mac: 'aa:aa:aa:aa:aa:01' },
    { ip: '10.0.0.2', mac: 'aa:aa:aa:aa:aa:01' }, // same MAC twice in a report: one row, last IP wins
    { ip: '10.0.0.3', mac: 'aa:aa:aa:aa:aa:03' },
    { ip: '10.0.0.4' }, // no MAC: skipped
  ], at);
  assert.equal(n, 2);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO known_devices \(scope, mac, first_seen, last_seen, last_ip\)\s+VALUES \(\?, \?, \?, \?, \?\), \(\?, \?, \?, \?, \?\)/);
  assert.match(sql, /last_seen = GREATEST\(last_seen, VALUES\(last_seen\)\)/);
  assert.doesNotMatch(sql, /first_seen = /, 'first_seen is never updated');
  assert.deepEqual(params, ['agent:11', 'aa:aa:aa:aa:aa:01', at, at, '10.0.0.2', 'agent:11', 'aa:aa:aa:aa:aa:03', at, at, '10.0.0.3']);
  assert.equal(await repo.touchMany('agent:11', [], at), 0);
  assert.equal(pool.calls.length, 1);
});

test('knownDevicesRepository: a full router ARP table (8192) plus an agent report is remembered whole, in chunks', async () => {
  const { MAX_ARP_PER_DEVICE } = require('../src/validation/snmpDeviceValidation');
  const { BULK_CAPABILITY_LIMITS } = require('../src/lib/agentCapabilities');
  const { MAX_MACS } = require('../src/repositories/knownDevicesRepository');
  assert.ok(MAX_MACS >= MAX_ARP_PER_DEVICE + BULK_CAPABILITY_LIMITS.arp, 'the cap covers the largest inputs');

  const mac = (i) => `02:00:00:${((i >> 16) & 255).toString(16).padStart(2, '0')}:${((i >> 8) & 255).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`;
  const entries = Array.from({ length: MAX_ARP_PER_DEVICE }, (_, i) => ({ ip: `10.${(i >> 8) & 255}.${i & 255}.1`, mac: mac(i) }));

  // touchMany: every MAC — including those past the old 5000 cut — is written.
  const writes = [];
  const pool = {
    query: async (sql, params) => {
      if (/^INSERT/.test(sql)) { writes.push(params); return [{ affectedRows: params.length / 5 }]; }
      // knownMacs: answer "known" for every MAC asked.
      return [params[1].map((m) => ({ mac: m }))];
    },
  };
  const repo = createKnownDevicesRepository({ pool });
  const n = await repo.touchMany('site:3', entries, NOW);
  assert.equal(n, MAX_ARP_PER_DEVICE);
  const written = new Set(writes.flatMap((p) => p.filter((_, i) => i % 5 === 1)));
  assert.equal(written.size, MAX_ARP_PER_DEVICE);
  assert.ok(written.has(mac(5000)) && written.has(mac(MAX_ARP_PER_DEVICE - 1)), 'MACs beyond 5000 are remembered');
  assert.ok(writes.every((p) => p.length / 5 <= 1000), 'each INSERT is a bounded chunk');

  // knownMacs: the same table is looked up whole.
  const known = await repo.knownMacs({ scope: 'site:3', macs: entries.map((e) => e.mac) });
  assert.equal(known.size, MAX_ARP_PER_DEVICE);
  assert.ok(known.has(mac(8000)));
});
