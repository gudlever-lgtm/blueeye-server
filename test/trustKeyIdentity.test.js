'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const {
  assessKeyIdentity,
  createKeyIdentityGuard,
  fingerprintOfPem,
  isDrift,
  CLEARED_FINGERPRINT,
  KIND_AGENT_RELEASE,
  KIND_LICENSE,
} = require('../src/license/keyIdentity');
const { makeApp, authHeader } = require('../test-support/fakes');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

// ---- The decision, without a database --------------------------------------

test('assessKeyIdentity covers every transition a key can make', () => {
  const at = (recorded, current) => assessKeyIdentity({ recorded, current }).state;

  assert.equal(at(null, null), 'absent', 'a fresh server before its key is generated is not an error');
  assert.equal(at(null, A), 'first', 'the first sighting has nothing to have changed from');
  assert.equal(at({ fingerprint: A }, A), 'unchanged', 'the normal answer, on every boot, forever');
  assert.equal(at({ fingerprint: A }, B), 'changed');
  assert.equal(at({ fingerprint: A }, null), 'cleared', 'the key was deleted');
});

test('a deleted key stays cleared without re-recording itself on every boot', () => {
  // The row that a deletion wrote: the sentinel as the fingerprint, the real key
  // kept as `previous`. Booting again must not look like a second change.
  const row = { fingerprint: CLEARED_FINGERPRINT, previous_fingerprint: A };
  const again = assessKeyIdentity({ recorded: row, current: null });
  assert.equal(again.state, 'cleared');
  assert.equal(again.persist, false, 'nothing new happened, so nothing is written — change_count must not inflate');
  assert.equal(again.previous, A, 'and the warning can still name the key that was lost');
});

test('delete-then-generate is a CHANGE, judged against the last real key', () => {
  // This is the sequence an admin actually performs when "rotating", and the one
  // that silently breaks the fleet. Comparing the new key against the sentinel
  // would have read as a harmless first sighting.
  const row = { fingerprint: CLEARED_FINGERPRINT, previous_fingerprint: A };
  const v = assessKeyIdentity({ recorded: row, current: B });
  assert.equal(v.state, 'changed');
  assert.equal(v.previous, A);
  assert.equal(isDrift(v.state), true);
});

test('putting the SAME key back after a deletion is not an alarm', () => {
  const row = { fingerprint: CLEARED_FINGERPRINT, previous_fingerprint: A };
  const v = assessKeyIdentity({ recorded: row, current: A });
  assert.equal(v.state, 'restored');
  assert.equal(isDrift(v.state), false, "the fleet's pins are valid again — nothing to warn about");
  assert.equal(v.persist, true, 'but the row has to stop saying the key is gone');
});

test('fingerprintOfPem agrees with the hash the release key service stores', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(fingerprintOfPem(pem), crypto.createHash('sha256').update(pem).digest('hex'));
  assert.equal(fingerprintOfPem(''), null);
  assert.equal(fingerprintOfPem(null), null);
});

// ---- The guard, against an in-memory repo ----------------------------------

function memoryRepo(seed = {}) {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    async get(kind) { return rows.get(kind) || null; },
    async record({ kind, fingerprint, firstSeenAt }) {
      const prev = rows.get(kind);
      rows.set(kind, { ...(prev || { change_count: 0, first_seen_at: firstSeenAt }), kind, fingerprint });
    },
    async recordChange({ kind, fingerprint, previous, changedAt }) {
      const prev = rows.get(kind) || { change_count: 0, first_seen_at: changedAt };
      rows.set(kind, {
        ...prev,
        kind,
        fingerprint: fingerprint || CLEARED_FINGERPRINT,
        previous_fingerprint: previous,
        changed_at: changedAt,
        change_count: (prev.change_count || 0) + 1,
        acknowledged_fingerprint: null,
      });
    },
    async acknowledge({ kind, fingerprint, at, userId }) {
      const prev = rows.get(kind) || {};
      rows.set(kind, { ...prev, acknowledged_fingerprint: fingerprint, acknowledged_at: at, acknowledged_by: userId });
    },
  };
}

function quietLogger() {
  const lines = [];
  return { lines, info() {}, warn(m) { lines.push(['warn', m]); }, error(m) { lines.push(['error', m]); } };
}

test('the first key is recorded silently; a change is logged as TRUST_KEY_CHANGED', async () => {
  const repo = memoryRepo();
  const logger = quietLogger();
  const guard = createKeyIdentityGuard({ repo, logger });

  const first = await guard.check({ kind: KIND_AGENT_RELEASE, fingerprint: A });
  assert.equal(first.state, 'first');
  assert.equal(first.drift, false);
  assert.equal(logger.lines.length, 0, 'a first sighting is not news');

  const changed = await guard.check({ kind: KIND_AGENT_RELEASE, fingerprint: B });
  assert.equal(changed.state, 'changed');
  assert.equal(changed.drift, true);
  assert.equal(changed.previous, A);
  assert.match(logger.lines[0][1], /TRUST_KEY_CHANGED/);
  assert.equal(logger.lines[0][0], 'error', 'this is not a warn-level fact');
});

test('the warning names how many agents have the old key pinned', async () => {
  const guard = createKeyIdentityGuard({ repo: memoryRepo(), logger: quietLogger() });
  await guard.check({ kind: KIND_AGENT_RELEASE, fingerprint: A });
  const v = await guard.check({
    kind: KIND_AGENT_RELEASE,
    fingerprint: B,
    impact: { total: 52, pinnedToCurrent: 0, pinnedToPrevious: 47, pinnedToOther: 0, unknown: 5 },
  });
  assert.match(v.message, /47 agents have the old key pinned/);
  assert.equal(v.impact.unknown, 5);
});

test('acknowledging is per fingerprint — it silences this change and not the next', async () => {
  const repo = memoryRepo();
  const guard = createKeyIdentityGuard({ repo, logger: quietLogger() });
  await guard.check({ kind: KIND_AGENT_RELEASE, fingerprint: A });
  await guard.check({ kind: KIND_AGENT_RELEASE, fingerprint: B });
  assert.equal(guard.status().unacknowledgedDrift, true);

  const acked = await guard.acknowledge({ kind: KIND_AGENT_RELEASE, userId: 1 });
  assert.equal(acked.acknowledged, true);
  assert.equal(guard.status().unacknowledgedDrift, false);
  assert.equal(guard.status().drift, true, 'the change is still a fact; it is just no longer shouting');

  // Acknowledging twice is not an error, it is a no-op.
  assert.equal(await guard.acknowledge({ kind: KIND_AGENT_RELEASE }), null);

  // A third key must be loud again, against a guard that has been through a
  // restart (a fresh guard reading the same rows).
  const fresh = createKeyIdentityGuard({ repo, logger: quietLogger() });
  const third = await fresh.check({ kind: KIND_AGENT_RELEASE, fingerprint: 'c'.repeat(64) });
  assert.equal(third.drift, true);
  assert.equal(third.acknowledged, false);
});

test('an acknowledged deletion does not re-alarm on every restart', async () => {
  const repo = memoryRepo();
  const first = createKeyIdentityGuard({ repo, logger: quietLogger() });
  await first.check({ kind: KIND_AGENT_RELEASE, fingerprint: A });
  await first.check({ kind: KIND_AGENT_RELEASE, fingerprint: null });
  await first.acknowledge({ kind: KIND_AGENT_RELEASE });

  const afterRestart = createKeyIdentityGuard({ repo, logger: quietLogger() });
  const v = await afterRestart.check({ kind: KIND_AGENT_RELEASE, fingerprint: null });
  assert.equal(v.state, 'cleared');
  assert.equal(v.drift, true, 'the server still cannot onboard or update anything');
  assert.equal(v.acknowledged, true, '...but an admin has already said they meant it');
  assert.equal(repo.rows.get(KIND_AGENT_RELEASE).change_count, 1, 'and it is still ONE change, not one per boot');
});

test('a repo that cannot be read never takes the server down', async () => {
  const logger = quietLogger();
  const broken = { async get() { throw new Error('db gone'); } };
  const guard = createKeyIdentityGuard({ repo: broken, logger });
  assert.equal(await guard.check({ kind: KIND_LICENSE, fingerprint: A }), null);
  assert.match(logger.lines[0][1], /drift cannot be judged/);
});

test('status() answers for both kinds even before anything has been checked', () => {
  const s = createKeyIdentityGuard({ repo: memoryRepo(), logger: quietLogger() }).status();
  assert.deepEqual(Object.keys(s.keys).sort(), [KIND_AGENT_RELEASE, KIND_LICENSE].sort());
  assert.equal(s.keys[KIND_LICENSE].state, 'unknown', 'never "no drift" for something nobody checked');
  assert.equal(s.drift, false);
});

test('an unknown kind is a programming error, not a silent no-op', async () => {
  const guard = createKeyIdentityGuard({ repo: memoryRepo(), logger: quietLogger() });
  await assert.rejects(() => guard.check({ kind: 'nope', fingerprint: A }), /unknown trust key kind/);
});

// ---- The API ----------------------------------------------------------------

function guardApp(overrides = {}) {
  return makeApp(overrides);
}

test('GET /system/trust-keys says available:false when nothing is wired (200, not a fake all-clear)', async () => {
  const res = await request(guardApp()).get('/system/trust-keys').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.available, false);
  assert.equal(res.body.drift, false);
});

test('GET /system/trust-keys needs a session (401)', async () => {
  const res = await request(guardApp()).get('/system/trust-keys');
  assert.equal(res.status, 401);
});

test('GET /system/trust-keys reports drift to a viewer — everyone should see the fleet going deaf', async () => {
  const repo = memoryRepo();
  const guard = createKeyIdentityGuard({ repo, logger: quietLogger() });
  await guard.check({ kind: KIND_AGENT_RELEASE, fingerprint: A });
  await guard.check({ kind: KIND_AGENT_RELEASE, fingerprint: B, impact: { total: 3, pinnedToCurrent: 0, pinnedToPrevious: 3, pinnedToOther: 0, unknown: 0 } });

  const res = await request(guardApp({ keyIdentityGuard: guard })).get('/system/trust-keys').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.available, true);
  assert.equal(res.body.unacknowledgedDrift, true);
  assert.equal(res.body.keys[KIND_AGENT_RELEASE].previous, A);
  assert.match(res.body.keys[KIND_AGENT_RELEASE].message, /3 agents have the old key pinned/);
});

test('a refresh that throws degrades to the last known state rather than a 500', async () => {
  const guard = createKeyIdentityGuard({ repo: memoryRepo(), logger: quietLogger() });
  await guard.check({ kind: KIND_AGENT_RELEASE, fingerprint: A });
  const app = guardApp({ keyIdentityGuard: guard, refreshKeyIdentity: async () => { throw new Error('db gone'); } });
  const res = await request(app).get('/system/trust-keys').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.keys[KIND_AGENT_RELEASE].fingerprint, A);
});

test('POST /system/trust-keys/:kind/acknowledge is admin-only (403) and validates the kind (400)', async () => {
  const guard = createKeyIdentityGuard({ repo: memoryRepo(), logger: quietLogger() });
  await guard.check({ kind: KIND_AGENT_RELEASE, fingerprint: A });
  await guard.check({ kind: KIND_AGENT_RELEASE, fingerprint: B });
  const app = guardApp({ keyIdentityGuard: guard });

  const viewer = await request(app).post(`/system/trust-keys/${KIND_AGENT_RELEASE}/acknowledge`).set('Authorization', authHeader('viewer'));
  assert.equal(viewer.status, 403);

  const anon = await request(app).post(`/system/trust-keys/${KIND_AGENT_RELEASE}/acknowledge`);
  assert.equal(anon.status, 401);

  const bad = await request(app).post('/system/trust-keys/not-a-key/acknowledge').set('Authorization', authHeader('admin'));
  assert.equal(bad.status, 400);

  const ok = await request(app).post(`/system/trust-keys/${KIND_AGENT_RELEASE}/acknowledge`).set('Authorization', authHeader('admin'));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.unacknowledgedDrift, false);

  // Nothing left to acknowledge.
  const again = await request(app).post(`/system/trust-keys/${KIND_AGENT_RELEASE}/acknowledge`).set('Authorization', authHeader('admin'));
  assert.equal(again.status, 404);
});

test('POST acknowledge is 503, not 500, when trust-key monitoring is not wired', async () => {
  const res = await request(guardApp()).post(`/system/trust-keys/${KIND_LICENSE}/acknowledge`).set('Authorization', authHeader('admin'));
  assert.equal(res.status, 503);
});

test('an acknowledge that blows up in the repo surfaces as a 500, not a lie', async () => {
  const guard = createKeyIdentityGuard({
    repo: { ...memoryRepo(), async acknowledge() { throw new Error('db gone'); } },
    logger: quietLogger(),
  });
  await guard.check({ kind: KIND_AGENT_RELEASE, fingerprint: A });
  await guard.check({ kind: KIND_AGENT_RELEASE, fingerprint: B });
  const res = await request(guardApp({ keyIdentityGuard: guard }))
    .post(`/system/trust-keys/${KIND_AGENT_RELEASE}/acknowledge`).set('Authorization', authHeader('admin'));
  assert.equal(res.status, 500);
});
