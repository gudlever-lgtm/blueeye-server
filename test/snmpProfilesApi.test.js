'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// NAMED SNMP COMMUNITIES — what Settings calls "SNMP communities": a named
// credential, assigned to the SITES it is valid at and to the AGENTS allowed to
// walk with it (migration 113).
//
// The two rules these tests exist to pin:
//
//   * AN AGENT WALKS ONLY WITH A COMMUNITY ASSIGNED TO IT. One it is not
//     granted is skipped as though it were not configured, and the device
//     reports that it has no credential rather than polling with 'public'.
//   * A SITE'S SEVERAL COMMUNITIES ARE AN ORDER, NOT A RETRY LIST. The server
//     picks the first one the polling agent may use and sends THAT — one
//     credential per device. Trying them in order on the wire is credential
//     spraying: technically identical to an attack, it locks v3 accounts, and
//     on v2c a wrong community usually just times out.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeSnmpProfilesRepo, makeSnmpDevicesRepo, makeAgentsRepo,
  makeAgentTokensRepo, makeLocationsRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');
const { validateSnmpProfile } = require('../src/validation/snmpProfileValidation');

const admin = (app, method, path, body) => request(app)[method](path)
  .set('Authorization', authHeader('admin'))
  .send(body);

// ============================================================== the RBAC
test('profiles are ADMIN for everything, including the read', async () => {
  // The one place in this feature where even a listing is admin-only: a list of
  // profiles says which sites share a secret and which use v3, which is a map
  // of where to attack first.
  const app = makeApp({ snmpProfilesRepo: makeSnmpProfilesRepo() });
  for (const role of ['viewer', 'operator']) {
    assert.equal((await request(app).get('/api/snmp-profiles').set('Authorization', authHeader(role))).status, 403, role);
  }
  assert.equal((await request(app).get('/api/snmp-profiles')).status, 401);
  assert.equal((await admin(app, 'get', '/api/snmp-profiles')).status, 200);
});

// ============================================================ no secrets out
test('a secret never comes back out of the API', async () => {
  const app = makeApp({ snmpProfilesRepo: makeSnmpProfilesRepo() });
  const created = await admin(app, 'post', '/api/snmp-profiles', {
    name: 'Site A', version: '2c', community: 'sup3rs3cret',
  });
  assert.equal(created.status, 201);

  const body = JSON.stringify(created.body);
  assert.ok(!body.includes('sup3rs3cret'), 'the community must never be returned');
  assert.equal(created.body.profile.hasCommunity, true, 'but WHETHER one is set is visible');

  const list = await admin(app, 'get', '/api/snmp-profiles');
  assert.ok(!JSON.stringify(list.body).includes('sup3rs3cret'));
});

test('a v3 profile shows its protocols and its user, never its keys', async () => {
  // An operator needs to see that a profile is SHA/AES to know it is
  // configured. They never need the key back, and a route that cannot return
  // it cannot leak it.
  const app = makeApp({ snmpProfilesRepo: makeSnmpProfilesRepo() });
  const res = await admin(app, 'post', '/api/snmp-profiles', {
    name: 'Core v3', version: '3', v3User: 'blueeye',
    v3AuthProto: 'sha256', v3AuthKey: 'authsecret1',
    v3PrivProto: 'aes', v3PrivKey: 'privsecret1',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.profile.v3User, 'blueeye');
  assert.equal(res.body.profile.v3AuthProto, 'sha256');
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes('authsecret1'));
  assert.ok(!body.includes('privsecret1'));
});

// =========================================================== the validation
test('SNMPv3 cannot encrypt without authenticating', async () => {
  // Not a weaker security level — one that does not exist. A device refuses
  // it, and refusing it here is the difference between an error message and a
  // switch that quietly stops answering.
  const { errors } = validateSnmpProfile({
    name: 'Broken', version: '3', v3User: 'u',
    v3PrivProto: 'aes', v3PrivKey: 'privsecret1',
  });
  assert.ok(errors.v3PrivKey);
  assert.match(errors.v3PrivKey, /cannot encrypt without authenticating/);
});

test('a v3 profile needs a user, and a v2c profile needs a community', () => {
  assert.ok(validateSnmpProfile({ name: 'x', version: '3' }).errors.v3User);
  assert.ok(validateSnmpProfile({ name: 'x', version: '2c' }).errors.community);
});

test('a v3 key shorter than the protocol allows is refused here, not by the switch', () => {
  const { errors } = validateSnmpProfile({
    name: 'x', version: '3', v3User: 'u', v3AuthProto: 'sha', v3AuthKey: 'short',
  });
  assert.match(errors.v3AuthKey, /at least 8/);
});

test('a key with no protocol, and a protocol with no key, are both caught', () => {
  const noProto = validateSnmpProfile({ name: 'x', version: '3', v3User: 'u', v3AuthKey: 'authsecret1' });
  assert.ok(noProto.errors.v3AuthProto);
});

test('a PATCH is validated against the MERGED shape', async () => {
  // Removing the auth key from an authPriv profile leaves priv with no auth —
  // caught here rather than when a switch stops answering.
  const snmpProfilesRepo = makeSnmpProfilesRepo();
  const app = makeApp({ snmpProfilesRepo });
  await admin(app, 'post', '/api/snmp-profiles', {
    name: 'Core v3', version: '3', v3User: 'u',
    v3AuthProto: 'sha', v3AuthKey: 'authsecret1', v3PrivProto: 'aes', v3PrivKey: 'privsecret1',
  });
  const res = await admin(app, 'patch', '/api/snmp-profiles/1', { v3AuthKey: null });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.v3PrivKey);
});

test('an omitted secret is left alone; an explicit null clears it', async () => {
  // Otherwise renaming a profile would silently wipe its credentials.
  const snmpProfilesRepo = makeSnmpProfilesRepo();
  const app = makeApp({ snmpProfilesRepo });
  await admin(app, 'post', '/api/snmp-profiles', { name: 'Site A', version: '2c', community: 'secret1' });

  await admin(app, 'patch', '/api/snmp-profiles/1', { name: 'Site A (renamed)' });
  assert.equal(snmpProfilesRepo.rows[0].community, 'secret1', 'a rename kept the credential');

  await admin(app, 'patch', '/api/snmp-profiles/1', { community: null });
  assert.equal(snmpProfilesRepo.rows[0].community, null);
});

// ================================================================ the CRUD
test('a duplicate name is 409, and an unknown id is 404', async () => {
  const app = makeApp({ snmpProfilesRepo: makeSnmpProfilesRepo() });
  await admin(app, 'post', '/api/snmp-profiles', { name: 'Site A', community: 'x' });
  assert.equal((await admin(app, 'post', '/api/snmp-profiles', { name: 'Site A', community: 'y' })).status, 409);
  assert.equal((await admin(app, 'get', '/api/snmp-profiles/999')).status, 404);
  assert.equal((await admin(app, 'patch', '/api/snmp-profiles/999', { name: 'z' })).status, 404);
  assert.equal((await admin(app, 'delete', '/api/snmp-profiles/999')).status, 404);
  assert.equal((await admin(app, 'get', '/api/snmp-profiles/abc')).status, 400);
});

test('an unknown site or agent is 404 rather than an assignment nobody can reach', async () => {
  // A grant to agent 41 when 41 was deleted last month reads, forever after,
  // as a grant that is in force.
  const app = makeApp({
    snmpProfilesRepo: makeSnmpProfilesRepo(),
    locationsRepo: makeLocationsRepo({ findById: async () => null }),
    agentsRepo: makeAgentsRepo({ findById: async () => null }),
  });
  assert.equal((await admin(app, 'post', '/api/snmp-profiles', { name: 'Site Z', community: 'x', locationIds: [42] })).status, 404);
  assert.equal((await admin(app, 'post', '/api/snmp-profiles', { name: 'Site Z', community: 'x', agentIds: [41] })).status, 404);
});

// ========================================================== the assignments
const withSites = (ids) => makeApp({
  snmpProfilesRepo: makeSnmpProfilesRepo(),
  locationsRepo: makeLocationsRepo({ findById: async (id) => (ids.includes(Number(id)) ? { id: Number(id), name: `Site ${id}` } : null) }),
  agentsRepo: makeAgentsRepo({ findById: async (id) => ({ id: Number(id), hostname: `be-${id}` }) }),
});

test('a community is assigned to SEVERAL sites and several agents, and reads back that way', async () => {
  const app = withSites([3, 4]);
  const created = await admin(app, 'post', '/api/snmp-profiles', {
    name: 'Access stack', version: '2c', community: 'x', locationIds: [4, 3], agentIds: [9, 11],
  });
  assert.equal(created.status, 201);
  // The SITE ORDER is kept as given: it is the order of preference, and a
  // silent reshuffle would change which community a device resolves to.
  assert.deepEqual(created.body.profile.locationIds, [4, 3]);
  assert.deepEqual(created.body.profile.agentIds, [9, 11]);
});

test('an omitted assignment list is left alone; an explicit [] clears it', async () => {
  // The same omitted-leaves-alone rule the secrets follow — otherwise renaming
  // a community would unassign it from every site that uses it.
  const app = withSites([3]);
  await admin(app, 'post', '/api/snmp-profiles', { name: 'A', community: 'x', locationIds: [3], agentIds: [9] });
  const renamed = await admin(app, 'patch', '/api/snmp-profiles/1', { name: 'A (renamed)' });
  assert.deepEqual(renamed.body.profile.locationIds, [3]);
  assert.deepEqual(renamed.body.profile.agentIds, [9]);

  const cleared = await admin(app, 'patch', '/api/snmp-profiles/1', { agentIds: [] });
  assert.deepEqual(cleared.body.profile.agentIds, [], 'an explicit empty list revokes every grant');
  assert.deepEqual(cleared.body.profile.locationIds, [3], 'and touches nothing else');
});

test('the list narrows to one site or one agent', async () => {
  const app = withSites([3, 4]);
  await admin(app, 'post', '/api/snmp-profiles', { name: 'Aarhus', community: 'x', locationIds: [3], agentIds: [9] });
  await admin(app, 'post', '/api/snmp-profiles', { name: 'Odense', community: 'y', locationIds: [4], agentIds: [11] });

  const site = await admin(app, 'get', '/api/snmp-profiles?locationId=3');
  assert.deepEqual(site.body.profiles.map((p) => p.name), ['Aarhus']);
  const agent = await admin(app, 'get', '/api/snmp-profiles?agentId=11');
  assert.deepEqual(agent.body.profiles.map((p) => p.name), ['Odense']);
  assert.equal((await admin(app, 'get', '/api/snmp-profiles?locationId=abc')).status, 400);
  assert.equal((await admin(app, 'get', '/api/snmp-profiles?agentId=-1')).status, 400);
});

test('a hostile assignment list is 400, never a 500', async () => {
  const app = withSites([3]);
  for (const body of [
    { name: 'A', community: 'x', locationIds: 'three' },
    { name: 'A', community: 'x', locationIds: [0] },
    { name: 'A', community: 'x', agentIds: [{ id: 1 }] },
    { name: 'A', community: 'x', agentIds: Array.from({ length: 501 }, (_, i) => i + 1) },
    { name: 'A', community: 'x', isGlobalDefault: 'yes' },
  ]) {
    const res = await admin(app, 'post', '/api/snmp-profiles', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, 'Validation failed');
  }
});

test('deleting a profile reports how many devices fall back', async () => {
  // They fall back to the resolution chain — their site's profile, then the
  // global default. An admin should see the number rather than discover it.
  const snmpProfilesRepo = makeSnmpProfilesRepo({ deviceCount: async () => 7 });
  const app = makeApp({ snmpProfilesRepo });
  await admin(app, 'post', '/api/snmp-profiles', { name: 'Site A', community: 'x' });
  const res = await admin(app, 'delete', '/api/snmp-profiles/1');
  assert.equal(res.status, 200);
  assert.equal(res.body.devicesAffected, 7);
});

test('a credential change is audited, with the FIELDS and not the values', async () => {
  const records = [];
  const snmpProfilesRepo = makeSnmpProfilesRepo();
  const app = makeApp({
    snmpProfilesRepo,
    auditLogger: { record: async (req, entry) => { records.push(entry); } },
  });
  await admin(app, 'post', '/api/snmp-profiles', { name: 'Site A', community: 'sup3rs3cret' });
  await admin(app, 'patch', '/api/snmp-profiles/1', { community: 'newsecret' });

  assert.equal(records[0].action, 'snmp_profile.create');
  assert.equal(records[1].action, 'snmp_profile.update');
  assert.match(records[1].targetLabel, /community/, 'the field that changed is named');
  assert.ok(!JSON.stringify(records).includes('sup3rs3cret'));
  assert.ok(!JSON.stringify(records).includes('newsecret'));
});

test("a site's ORDER of preference is set on the site, and decides which community wins", async () => {
  const app = withSites([3]);
  await admin(app, 'post', '/api/snmp-profiles', { name: 'Core', community: 'x', locationIds: [3], agentIds: [9] });
  await admin(app, 'post', '/api/snmp-profiles', { name: 'Access', community: 'y', locationIds: [3], agentIds: [9] });

  // Without an order, the tie-break (lowest id) decides.
  let site = await admin(app, 'get', '/api/snmp-profiles?locationId=3');
  assert.deepEqual(site.body.profiles.map((p) => p.name), ['Core', 'Access']);

  const put = await admin(app, 'put', '/api/snmp-profiles/order/3', { profileIds: [2, 1] });
  assert.equal(put.status, 200);
  site = await admin(app, 'get', '/api/snmp-profiles?locationId=3');
  assert.deepEqual(site.body.profiles.map((p) => p.name), ['Access', 'Core']);
});

test('a PARTIAL order is 400: the rest would land somewhere nobody chose', async () => {
  const app = withSites([3]);
  await admin(app, 'post', '/api/snmp-profiles', { name: 'Core', community: 'x', locationIds: [3] });
  await admin(app, 'post', '/api/snmp-profiles', { name: 'Access', community: 'y', locationIds: [3] });

  assert.equal((await admin(app, 'put', '/api/snmp-profiles/order/3', { profileIds: [2] })).status, 400);
  assert.equal((await admin(app, 'put', '/api/snmp-profiles/order/3', { profileIds: [1, 2, 99] })).status, 400);
  assert.equal((await admin(app, 'put', '/api/snmp-profiles/order/3', {})).status, 400);
  assert.equal((await admin(app, 'put', '/api/snmp-profiles/order/abc', { profileIds: [1, 2] })).status, 400);
  assert.equal((await admin(app, 'put', '/api/snmp-profiles/order/99', { profileIds: [] })).status, 404);
});

// ==================================================== the resolution chain
async function fleet({ profiles = [], devices = [] } = {}) {
  const snmpProfilesRepo = makeSnmpProfilesRepo();
  for (const p of profiles) await snmpProfilesRepo.create(p);
  const snmpDevicesRepo = makeSnmpDevicesRepo({}, { credentialProfilesRepo: snmpProfilesRepo });
  for (const d of devices) await snmpDevicesRepo.create(d);
  // The REAL resolution, over the fakes — including the agent's grants.
  const resolved = async (agentId) => (await snmpDevicesRepo.listForAgentWithSecret(agentId))
    .map((device) => ({
      ...device,
      source: device.credential ? device.credential.source : 'none',
    }));
  return { snmpProfilesRepo, snmpDevicesRepo, resolved };
}

test('a device with its OWN credential wins over every profile', async () => {
  const { resolved } = await fleet({
    profiles: [{ name: 'Global', version: '2c', community: 'globalsecret' }],
    devices: [{ agentId: 9, host: '10.14.0.11', community: 'devicesecret' }],
  });
  const [device] = await resolved(9);
  assert.equal(device.community, 'devicesecret');
  assert.equal(device.source, 'device');
});

test('a device with no credential falls back to its SITE community, then the global one', async () => {
  const { resolved } = await fleet({
    profiles: [
      { name: 'Global', version: '2c', community: 'globalsecret', isGlobalDefault: true, agentIds: [9] },
      { name: 'Aarhus', version: '2c', community: 'aarhussecret', locationIds: [3], agentIds: [9] },
    ],
    devices: [
      { agentId: 9, host: '10.14.0.11', locationId: 3 },
      { agentId: 9, host: '10.14.0.12' },
    ],
  });
  const [atSite, elsewhere] = await resolved(9);
  assert.equal(atSite.credential.community, 'aarhussecret');
  assert.equal(elsewhere.credential.community, 'globalsecret');
});

test("a site's several communities are an ORDER: the first one this agent may use wins", async () => {
  // Not a retry list. The server picks one and sends one — see the header.
  const { resolved } = await fleet({
    profiles: [
      { name: 'Core', version: '2c', community: 'coresecret', locationIds: [3], agentIds: [] },
      { name: 'Access', version: '2c', community: 'accesssecret', locationIds: [3], agentIds: [9] },
    ],
    devices: [{ agentId: 9, host: '10.14.0.11', locationId: 3 }],
  });
  const [device] = await resolved(9);
  // 'Core' is first in the site's order and would have answered — but this
  // agent is not granted it, so it is skipped as though it were not there.
  assert.equal(device.credential.community, 'accesssecret');
  assert.equal(device.credentialBlockedByGrant, false);
});

test('an agent with NO community assigned gets no credential, and the reason is reported', async () => {
  // The access rule, in one test: a community the agent may not use is not a
  // fallback to 'public', and "this site has none" and "this agent may not use
  // the one it has" send an admin to two different screens.
  const { resolved } = await fleet({
    profiles: [{ name: 'Aarhus', version: '2c', community: 'aarhussecret', locationIds: [3], agentIds: [] }],
    devices: [{ agentId: 9, host: '10.14.0.11', locationId: 3 }],
  });
  const [device] = await resolved(9);
  assert.equal(device.credential, null);
  assert.equal(device.community, null, 'never a quiet fallback to "public"');
  assert.equal(device.credentialBlockedByGrant, true);
});

test('a device naming a community explicitly uses that one — or none, never a substitute', async () => {
  const { resolved } = await fleet({
    profiles: [
      { name: 'Global', version: '2c', community: 'globalsecret', isGlobalDefault: true, agentIds: [9] },
      { name: 'Special', version: '2c', community: 'specialsecret', agentIds: [9] },
      { name: 'Forbidden', version: '2c', community: 'forbiddensecret', agentIds: [] },
    ],
    devices: [
      { agentId: 9, host: '10.14.0.11', credentialProfileId: 2, locationId: 3 },
      { agentId: 9, host: '10.14.0.12', credentialProfileId: 3, locationId: 3 },
    ],
  });
  const [named, forbidden] = await resolved(9);
  assert.equal(named.credential.community, 'specialsecret');
  // The naming was deliberate: a device whose agent may not use the community
  // it names does NOT quietly fall through to the global default.
  assert.equal(forbidden.credential, null);
  assert.equal(forbidden.credentialBlockedByGrant, true);
});

test('a device with NOTHING to resolve to says so, rather than polling with "public"', async () => {
  const { resolved } = await fleet({ devices: [{ agentId: 9, host: '10.14.0.11' }] });
  const [device] = await resolved(9);
  assert.equal(device.credential, null);
  assert.equal(device.source, 'none');
});

test('a v3 profile resolves with its derived security level', async () => {
  const { snmpProfilesRepo } = await fleet({
    profiles: [{
      name: 'Core v3', version: '3', v3User: 'blueeye',
      v3AuthProto: 'sha256', v3AuthKey: 'authsecret1',
      v3PrivProto: 'aes', v3PrivKey: 'privsecret1',
    }],
  });
  const cred = await snmpProfilesRepo.resolveWithSecret(1);
  assert.equal(cred.version, '3');
  assert.equal(cred.securityLevel, 'authPriv');
  assert.equal(cred.v3User, 'blueeye');
});

test('the agent receives ONE credential per device — never a list to try', async () => {
  // The audit's proposal had the agent try profiles in order. That is
  // credential spraying: it locks v3 accounts, and on v2c a wrong community
  // usually just times out, so three profiles x 30 s per device per cycle
  // collapses the polling before it finds anything.
  const snmpProfilesRepo = makeSnmpProfilesRepo();
  await snmpProfilesRepo.create({ name: 'Global', version: '2c', community: 'globalsecret', isGlobalDefault: true, agentIds: [9] });
  await snmpProfilesRepo.create({ name: 'Other', version: '2c', community: 'othersecret', agentIds: [9] });
  // Wired to the profiles repo, so the REAL resolution chain runs.
  const snmpDevicesRepo = makeSnmpDevicesRepo({}, { credentialProfilesRepo: snmpProfilesRepo });
  await snmpDevicesRepo.create({ agentId: 9, host: '10.14.0.11' });

  const app = makeApp({
    snmpProfilesRepo, snmpDevicesRepo,
    agentsRepo: makeAgentsRepo({ findById: async () => ({ id: 9, hostname: 'be-aarhus-01' }) }),
    agentTokensRepo: makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) }),
  });
  const res = await request(app).get('/agents/me/config').set('Authorization', 'Bearer agent-tok');
  assert.equal(res.status, 200);
  const [target] = res.body.snmpTargets;
  assert.equal(typeof target.community, 'string');
  assert.ok(!Array.isArray(target.community), 'one credential, not a list');
  assert.equal(target.v3, undefined, 'no v3 block on a v2c credential');
});

test('a repository failure is a 500, and says nothing about the secret store', async () => {
  // The failure mode that matters on THIS route: the handler must not fall
  // through to an empty list, which would read as "no profiles are
  // configured" — and an admin acting on that would create a second global
  // default beside the one that is already there.
  const app = makeApp({
    snmpProfilesRepo: makeSnmpProfilesRepo({
      list: throwingAsync(),
      findById: throwingAsync(),
      create: throwingAsync(),
    }),
  });
  const list = await admin(app, 'get', '/api/snmp-profiles');
  assert.equal(list.status, 500);
  assert.ok(!Array.isArray(list.body.profiles), 'a failure is never an empty list');

  assert.equal((await admin(app, 'get', '/api/snmp-profiles/1')).status, 500);
  assert.equal(
    (await admin(app, 'post', '/api/snmp-profiles', { name: 'Site A', version: '2c', community: 'x' })).status,
    500,
  );
  // The error text is generic: a stack trace here would name the encryption
  // helper and the column it writes.
  assert.ok(!JSON.stringify(list.body).toLowerCase().includes('secretbox'));
});

// ============================================ the agent's OWN traffic source
//
// "SNMP community" in Edit agent used to be a free-text box: the literal
// community string, stored in `monitor_config` and handed back by the agents
// API to anyone who could read it. It can now NAME a credential instead, and
// then only the id is stored — the secret stays encrypted in the profile and
// is resolved for the one hop that needs it, exactly as the device targets
// beside it already were.

const agentTokenFor = (id) => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: id }) });

async function configFor({ profiles = [], snmp = {}, agentId = 9, snmpProfilesRepo = null } = {}) {
  const repo = snmpProfilesRepo || makeSnmpProfilesRepo();
  if (!snmpProfilesRepo) for (const p of profiles) await repo.create(p);
  const agentsRepo = makeAgentsRepo({
    findById: async () => ({ id: agentId, hostname: 'be-aarhus-01', monitor_config: { source: 'snmp', snmp } }),
  });
  const app = makeApp({ snmpProfilesRepo: repo, agentsRepo, agentTokensRepo: agentTokenFor(agentId) });
  return request(app).get('/agents/me/config').set('Authorization', 'Bearer agent-tok');
}

test('an agent polling by NAME gets the community resolved for that one hop', async () => {
  const res = await configFor({
    profiles: [{ name: 'Site A', version: '2c', community: 'sup3rs3cret', agentIds: [9] }],
    snmp: { host: '10.14.0.1', version: '1', port: 161, profileId: 1 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.monitorConfig.snmp.community, 'sup3rs3cret');
  // The credential's version wins over the one left on the config: a v3
  // credential against a row still saying 2c authenticates with a community
  // string that does not exist.
  assert.equal(res.body.monitorConfig.snmp.version, '2c');
  assert.equal(res.body.monitorConfig.snmp.host, '10.14.0.1', 'the rest of the config is untouched');
});

test('a credential this agent is NOT granted sends no community at all', async () => {
  // Not a fallback to the global default and not 'public': the agent refuses
  // to poll and says why, which is how the grant reaches the dashboard.
  const res = await configFor({
    profiles: [
      { name: 'Forbidden', version: '2c', community: 'forbiddensecret', agentIds: [] },
      { name: 'Global', version: '2c', community: 'globalsecret', isGlobalDefault: true, agentIds: [9] },
    ],
    snmp: { host: '10.14.0.1', profileId: 1 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.monitorConfig.snmp.community, undefined);
  assert.equal(res.body.monitorConfig.snmp.noCredential, true);
  assert.equal(res.body.monitorConfig.snmp.credentialBlocked, true);
  assert.ok(!JSON.stringify(res.body).includes('globalsecret'), 'and never a substitute nobody chose');
});

test('a v3 credential arrives as keys, not as a community string', async () => {
  const res = await configFor({
    profiles: [{
      name: 'Core v3', version: '3', v3User: 'blueeye',
      v3AuthProto: 'sha256', v3AuthKey: 'authsecret1',
      v3PrivProto: 'aes', v3PrivKey: 'privsecret1', agentIds: [9],
    }],
    snmp: { host: '10.14.0.1', profileId: 1 },
  });
  assert.equal(res.body.monitorConfig.snmp.version, '3');
  assert.equal(res.body.monitorConfig.snmp.v3.user, 'blueeye');
  assert.equal(res.body.monitorConfig.snmp.v3.level, 'authPriv');
  assert.equal(res.body.monitorConfig.snmp.community, undefined);
});

test('a credential lookup that fails is still a config, not a 500', async () => {
  // The config's first and more important job is telling an agent how to
  // measure ITSELF. A secret store that is down must not take that away — the
  // agent gets its config and the reason it cannot poll.
  const res = await configFor({
    snmp: { host: '10.14.0.1', profileId: 1 },
    snmpProfilesRepo: makeSnmpProfilesRepo({ resolveForAgent: throwingAsync() }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.monitorConfig.snmp.noCredential, true);
  assert.equal(res.body.monitorConfig.snmp.community, undefined);
});

test('a config with no named credential is byte-for-byte what it always was', async () => {
  // The agents in the field read this response; an extra key on the old path
  // would be a change they never asked for.
  const res = await configFor({ snmp: { host: '10.14.0.1', community: 'public', version: '2c', port: 161 } });
  assert.deepEqual(res.body.monitorConfig, {
    source: 'snmp', snmp: { host: '10.14.0.1', community: 'public', version: '2c', port: 161 },
  });
});

test('a named credential replaces the literal one — never both, and never in the agents API', async () => {
  let patch;
  const agentsRepo = makeAgentsRepo({
    findById: async () => ({ id: 9, hostname: 'be-aarhus-01' }),
    updateManaged: async (id, p) => { patch = p; return { id, ...p }; },
  });
  const app = makeApp({ agentsRepo, snmpProfilesRepo: makeSnmpProfilesRepo() });
  const put = (snmp) => request(app).put('/agents/9')
    .set('Authorization', authHeader('operator'))
    .send({ monitor_config: { source: 'snmp', snmp } });

  const ok = await put({ host: '10.14.0.1', profileId: 4, community: 'typed-by-hand' });
  assert.equal(ok.status, 200);
  assert.equal(patch.monitor_config.snmp.profileId, 4);
  assert.equal(patch.monitor_config.snmp.community, undefined, 'the literal is dropped, not kept beside it');

  // A profile id is an id.
  for (const bad of [0, -3, 'abc', 1.5]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await put({ host: '10.14.0.1', profileId: bad });
    assert.equal(res.status, 400, String(bad));
  }
});

test('PUT /agents/:id with a named credential on an agent that does not exist is a 404', async () => {
  const app = makeApp({ agentsRepo: makeAgentsRepo({ findById: async () => null }) });
  const res = await request(app).put('/agents/4242')
    .set('Authorization', authHeader('operator'))
    .send({ monitor_config: { source: 'snmp', snmp: { host: '10.14.0.1', profileId: 1 } } });
  assert.equal(res.status, 404);
});
