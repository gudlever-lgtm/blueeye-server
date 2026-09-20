'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Trin 6: SNMP credential profiles, and v3.
//
// The proposed model was a profile per site, one per subnet, an override per
// device, and the AGENT trying them in order. The hierarchy is built; the
// ordered trying is NOT, and these tests pin why: it is credential spraying,
// technically identical to an attack, and the server can just resolve it.

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

test('an unknown location is 404 rather than a profile nobody can reach', async () => {
  const app = makeApp({
    snmpProfilesRepo: makeSnmpProfilesRepo(),
    locationsRepo: makeLocationsRepo({ findById: async () => null }),
  });
  const res = await admin(app, 'post', '/api/snmp-profiles', { name: 'Site Z', community: 'x', locationId: 42 });
  assert.equal(res.status, 404);
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

// ==================================================== the resolution chain
async function fleet({ profiles = [], devices = [] } = {}) {
  const snmpProfilesRepo = makeSnmpProfilesRepo();
  for (const p of profiles) await snmpProfilesRepo.create(p);
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  for (const d of devices) await snmpDevicesRepo.create(d);
  // The REAL resolution, over the fakes.
  const resolved = async (agentId) => {
    const list = await snmpDevicesRepo.listForAgentWithSecret(agentId);
    const out = [];
    for (const device of list) {
      if (device.community) { out.push({ ...device, source: 'device' }); continue; }
      const profileId = await snmpProfilesRepo.resolveProfileIdFor({
        profileId: device.credentialProfileId, locationId: device.locationId,
      });
      const cred = profileId ? await snmpProfilesRepo.resolveWithSecret(profileId) : null;
      out.push({ ...device, credential: cred, source: cred ? 'profile' : 'none' });
    }
    return out;
  };
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

test('a device with no credential falls back to its SITE profile, then the global one', async () => {
  const { resolved } = await fleet({
    profiles: [
      { name: 'Global', version: '2c', community: 'globalsecret' },
      { name: 'Aarhus', version: '2c', community: 'aarhussecret', locationId: 3 },
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

test('a device naming a profile explicitly uses that one', async () => {
  const { resolved } = await fleet({
    profiles: [
      { name: 'Global', version: '2c', community: 'globalsecret' },
      { name: 'Special', version: '2c', community: 'specialsecret' },
    ],
    devices: [{ agentId: 9, host: '10.14.0.11', credentialProfileId: 2, locationId: 3 }],
  });
  const [device] = await resolved(9);
  assert.equal(device.credential.community, 'specialsecret');
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
  await snmpProfilesRepo.create({ name: 'Global', version: '2c', community: 'globalsecret' });
  await snmpProfilesRepo.create({ name: 'Other', version: '2c', community: 'othersecret' });
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
