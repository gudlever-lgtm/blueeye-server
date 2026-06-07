'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createLdapAuth } = require('../src/auth/ldap');
const { makeSecretBox } = require('../test-support/fakes');

const box = makeSecretBox();

// A fake ldapts client. First search returns the user; a later search returns
// groups (for the group_filter fallback). The user bind can be made to fail.
function fakeClient({ userEntry, groupEntries, failUserBind } = {}) {
  const binds = [];
  const searches = [];
  let n = 0;
  return {
    binds,
    searches,
    bind: async (dn, pw) => {
      binds.push({ dn, pw });
      if (userEntry && dn === userEntry.dn && failUserBind) throw new Error('invalid credentials');
    },
    search: async (base, opts) => {
      searches.push({ base, opts });
      n += 1;
      if (n === 1) return { searchEntries: userEntry ? [userEntry] : [] };
      return { searchEntries: groupEntries || [] };
    },
    unbind: async () => {},
  };
}

function cfgRepo(over = {}) {
  const row = {
    id: 1, host: over.host || 'ad.acme.dk', port: over.port || 636,
    use_tls: over.use_tls !== false, bind_dn: over.bind_dn === undefined ? 'cn=svc,dc=x' : over.bind_dn,
    bind_pw_encrypted: box.encrypt(over.bindPw || 'bindpw'),
    base_dn: over.base_dn || 'dc=x', user_filter: over.user_filter || '(sAMAccountName={{username}})',
    group_filter: over.group_filter || null, enabled: over.enabled !== false,
  };
  return { get: async () => ({ ...row, bind_pw_encrypted: undefined }), getWithSecret: async () => row };
}
const mapRepo = (maps) => ({ findAll: async () => maps });

function build({ authEnabled = true, cfgOver = {}, maps = [], client, captureFactory } = {}) {
  const state = {};
  const clientFactory = (args) => { state.url = args.url; state.client = client; return client; };
  if (captureFactory) captureFactory(state);
  return createLdapAuth({
    config: { authEnabled }, ldapConfigRepo: cfgRepo(cfgOver), ldapRoleMapRepo: mapRepo(maps),
    secretBox: box, clientFactory,
  });
}

const aliceAdmin = { dn: 'cn=alice,dc=x', memberOf: ['cn=admins,dc=x', 'cn=ops,dc=x'], mail: 'Alice@x' };

test('disabled by env flag -> { enabled:false } (caller falls back to local)', async () => {
  const auth = build({ authEnabled: false, client: fakeClient({ userEntry: aliceAdmin }) });
  assert.deepEqual(await auth.authenticate('alice', 'pw'), { enabled: false });
});

test('disabled by config row -> { enabled:false }', async () => {
  const auth = build({ cfgOver: { enabled: false }, client: fakeClient({ userEntry: aliceAdmin }) });
  assert.deepEqual(await auth.authenticate('alice', 'pw'), { enabled: false });
});

test('isEnabled requires both the env flag and an enabled config', async () => {
  assert.equal(await build({ authEnabled: true, client: fakeClient({}) }).isEnabled(), true);
  assert.equal(await build({ authEnabled: false, client: fakeClient({}) }).isEnabled(), false);
  assert.equal(await build({ authEnabled: true, cfgOver: { enabled: false }, client: fakeClient({}) }).isEnabled(), false);
});

test('bind success + group hit -> highest matching role', async () => {
  const auth = build({
    client: fakeClient({ userEntry: aliceAdmin }),
    maps: [{ ldap_group_dn: 'cn=admins,dc=x', blueeye_role: 'admin' }, { ldap_group_dn: 'cn=ops,dc=x', blueeye_role: 'operator' }],
  });
  const res = await auth.authenticate('alice', 'correct');
  assert.equal(res.ok, true);
  assert.equal(res.role, 'admin'); // admin > operator
  assert.equal(res.dn, 'cn=alice,dc=x');
  assert.equal(res.email, 'alice@x'); // mail, lower-cased
  assert.equal(res.matched, 2);
});

test('role precedence: viewer + operator -> operator', async () => {
  const auth = build({
    client: fakeClient({ userEntry: { dn: 'cn=bob,dc=x', memberOf: ['cn=ro,dc=x', 'cn=ops,dc=x'], mail: 'bob@x' } }),
    maps: [{ ldap_group_dn: 'cn=ro,dc=x', blueeye_role: 'viewer' }, { ldap_group_dn: 'cn=ops,dc=x', blueeye_role: 'operator' }],
  });
  const res = await auth.authenticate('bob', 'pw');
  assert.equal(res.role, 'operator');
});

test('bind fail (wrong password) -> ok:false bind-failed', async () => {
  const auth = build({ client: fakeClient({ userEntry: aliceAdmin, failUserBind: true }), maps: [{ ldap_group_dn: 'cn=admins,dc=x', blueeye_role: 'admin' }] });
  const res = await auth.authenticate('alice', 'wrong');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bind-failed');
});

test('user not found -> ok:false bind-failed', async () => {
  const auth = build({ client: fakeClient({ userEntry: null }) });
  const res = await auth.authenticate('ghost', 'pw');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bind-failed');
});

test('group miss (no mapped group) -> ok:false no-role (no default role)', async () => {
  const auth = build({ client: fakeClient({ userEntry: aliceAdmin }), maps: [{ ldap_group_dn: 'cn=other,dc=x', blueeye_role: 'admin' }] });
  const res = await auth.authenticate('alice', 'pw');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-role');
});

test('empty password is rejected without binding', async () => {
  const client = fakeClient({ userEntry: aliceAdmin });
  const auth = build({ client });
  const res = await auth.authenticate('alice', '');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-input');
  assert.equal(client.binds.length, 0);
});

test('TLS enforcement: plaintext bind to a non-local host is refused', async () => {
  const client = fakeClient({ userEntry: aliceAdmin });
  const auth = build({ cfgOver: { use_tls: false, host: 'ad.acme.dk' }, client });
  const res = await auth.authenticate('alice', 'pw');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'tls-required');
  assert.equal(client.binds.length, 0);
});

test('TLS not required for localhost (plaintext allowed)', async () => {
  const auth = build({
    cfgOver: { use_tls: false, host: '127.0.0.1' }, client: fakeClient({ userEntry: aliceAdmin }),
    maps: [{ ldap_group_dn: 'cn=admins,dc=x', blueeye_role: 'admin' }],
  });
  const res = await auth.authenticate('alice', 'pw');
  assert.equal(res.ok, true);
});

test('ldapts unavailable (factory returns null) -> ok:false unavailable', async () => {
  const auth = createLdapAuth({ config: { authEnabled: true }, ldapConfigRepo: cfgRepo(), ldapRoleMapRepo: mapRepo([]), secretBox: box, clientFactory: () => null });
  const res = await auth.authenticate('alice', 'pw');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unavailable');
});

test('group_filter fallback is used when memberOf is absent', async () => {
  const auth = build({
    cfgOver: { group_filter: '(member={{dn}})' },
    client: fakeClient({ userEntry: { dn: 'cn=carol,dc=x', mail: 'carol@x' }, groupEntries: [{ dn: 'cn=ops,dc=x' }] }),
    maps: [{ ldap_group_dn: 'cn=ops,dc=x', blueeye_role: 'operator' }],
  });
  const res = await auth.authenticate('carol', 'pw');
  assert.equal(res.ok, true);
  assert.equal(res.role, 'operator');
});

test('the username is escaped in the filter (LDAP injection guard)', async () => {
  const client = fakeClient({ userEntry: aliceAdmin });
  const auth = build({ client, maps: [{ ldap_group_dn: 'cn=admins,dc=x', blueeye_role: 'admin' }] });
  await auth.authenticate('a*)(uid=*', 'pw');
  const filter = client.searches[0].opts.filter;
  assert.ok(!filter.includes('*)('), `filter not escaped: ${filter}`);
  assert.ok(filter.includes('\\2a')); // '*' escaped
});

test('uses ldaps:// for use_tls and ldap:// otherwise', async () => {
  const st = {};
  const tls = build({ client: fakeClient({ userEntry: aliceAdmin }), maps: [{ ldap_group_dn: 'cn=admins,dc=x', blueeye_role: 'admin' }], captureFactory: (s) => { Object.assign(st, { ref: s }); } });
  await tls.authenticate('alice', 'pw');
  assert.match(st.ref.url, /^ldaps:\/\/ad\.acme\.dk:636$/);
});

test('testConnection: ok on bind, tls-required refusal off-localhost', async () => {
  const ok = build({ client: fakeClient({ userEntry: aliceAdmin }) });
  assert.equal((await ok.testConnection()).ok, true);
  const refused = build({ cfgOver: { use_tls: false, host: 'ad.acme.dk' }, client: fakeClient({}) });
  const r = await refused.testConnection();
  assert.equal(r.ok, false);
  assert.match(r.detail, /TLS required/);
});
