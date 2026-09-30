'use strict';

// knownPeersRepository (migration 142) against a scripted pool: the statements
// it sends and the parameters it binds. Whether the SQL is valid MySQL is a
// different question, answered by `npm run verify-repositories`.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createKnownPeersRepository, peerKey, scopeKey, MAX_PEERS } = require('../src/repositories/knownPeersRepository');

function scriptedPool(answers = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    pool: {
      query: async (sql, params) => {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        const a = answers[i]; i += 1;
        return a === undefined ? [[], []] : a;
      },
    },
  };
}

test('peerKey normalises an ASN and a country, and refuses anything else', () => {
  assert.equal(peerKey('asn', 15169), '15169');
  assert.equal(peerKey('asn', '15169'), '15169');
  assert.equal(peerKey('asn', 0), null);
  assert.equal(peerKey('asn', -1), null);
  assert.equal(peerKey('asn', 'AS15169'), null);
  assert.equal(peerKey('country', 'dk'), 'DK');
  assert.equal(peerKey('country', ' se '), 'SE');
  assert.equal(peerKey('country', 'DNK'), null);
  assert.equal(peerKey('country', ''), null);
  assert.equal(peerKey('mac', 'x'), null);
  assert.equal(peerKey('asn', null), null);
});

test('the scope string is the one known_devices uses', () => {
  assert.equal(scopeKey({ siteId: 3, agentId: 7 }), 'site:3');
  assert.equal(scopeKey({ siteId: null, agentId: 7 }), 'agent:7');
  assert.equal(scopeKey({}), null);
});

test('knownPeers reads once per kind and answers kind|key', async () => {
  const { pool, calls } = scriptedPool([
    [[{ peer_key: '15169' }]],
    [[{ peer_key: 'DK' }]],
  ]);
  const repo = createKnownPeersRepository({ pool });
  const known = await repo.knownPeers({
    scope: 'site:3',
    peers: [
      { kind: 'asn', key: 15169 }, { kind: 'asn', key: '15169' }, { kind: 'asn', key: 64500 },
      { kind: 'country', key: 'dk' }, { kind: 'country', key: 'NO' },
      { kind: 'asn', key: 'rubbish' },
    ],
  });
  assert.deepEqual([...known].sort(), ['asn|15169', 'country|DK']);
  assert.equal(calls.length, 2, 'one read per kind');
  assert.deepEqual(calls[0].params, ['site:3', 'asn', ['15169', '64500']], 'the duplicate ASN was sent twice');
  assert.deepEqual(calls[1].params, ['site:3', 'country', ['DK', 'NO']]);
});

test('knownPeers asks nothing without a scope or without usable peers', async () => {
  const { pool, calls } = scriptedPool();
  const repo = createKnownPeersRepository({ pool });
  assert.equal((await repo.knownPeers({ scope: null, peers: [{ kind: 'asn', key: 1 }] })).size, 0);
  assert.equal((await repo.knownPeers({ scope: 'site:3', peers: [] })).size, 0);
  assert.equal((await repo.knownPeers({ scope: 'site:3', peers: [{ kind: 'asn', key: 'x' }] })).size, 0);
  assert.equal((await repo.knownPeers({})).size, 0);
  assert.equal(calls.length, 0);
});

test('touchMany deduplicates, binds eight parameters per row and never ages a peer', async () => {
  const { pool, calls } = scriptedPool([[{ affectedRows: 2 }]]);
  const repo = createKnownPeersRepository({ pool });
  const at = new Date('2026-09-30T10:00:00Z');
  const n = await repo.touchMany('site:3', [
    { kind: 'asn', key: 15169, name: 'Google LLC', srcIp: '10.0.0.1', extIp: '8.8.8.8' },
    { kind: 'asn', key: '15169', name: 'Google LLC', srcIp: '10.0.0.2', extIp: '8.8.4.4' },
    { kind: 'country', key: 'dk' },
    { kind: 'mac', key: 'nope' },
    null,
  ], at);

  assert.equal(n, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.length, 16, 'two rows × eight parameters');
  assert.deepEqual(calls[0].params.slice(0, 8), ['site:3', 'asn', '15169', 'Google LLC', at, at, '10.0.0.2', '8.8.4.4']);
  assert.deepEqual(calls[0].params.slice(8), ['site:3', 'country', 'DK', null, at, at, null, null]);
  assert.match(calls[0].sql, /last_seen = GREATEST\(last_seen, VALUES\(last_seen\)\)/);
});

test('touchMany writes nothing without a scope or a usable peer', async () => {
  const { pool, calls } = scriptedPool();
  const repo = createKnownPeersRepository({ pool });
  assert.equal(await repo.touchMany(null, [{ kind: 'asn', key: 1 }]), 0);
  assert.equal(await repo.touchMany('site:3', []), 0);
  assert.equal(await repo.touchMany('site:3', [{ kind: 'asn', key: 'x' }]), 0);
  assert.equal(await repo.touchMany('site:3', 'nonsense'), 0);
  assert.equal(calls.length, 0);
});

test('a runaway caller is capped rather than building a statement without bound', async () => {
  const { pool, calls } = scriptedPool();
  const repo = createKnownPeersRepository({ pool });
  const peers = Array.from({ length: MAX_PEERS + 500 }, (_, i) => ({ kind: 'asn', key: i + 1 }));
  await repo.touchMany('site:3', peers);
  const bound = calls.reduce((sum, c) => sum + c.params.length / 8, 0);
  assert.equal(bound, MAX_PEERS);
  assert.ok(calls.every((c) => c.params.length <= 500 * 8), 'a statement exceeded the chunk size');
});

test('oldestFirstSeen answers a Date or null', async () => {
  const withRow = scriptedPool([[[{ oldest: '2026-09-01T00:00:00Z' }]]]);
  assert.equal(
    (await createKnownPeersRepository({ pool: withRow.pool }).oldestFirstSeen('site:3')).toISOString(),
    new Date('2026-09-01T00:00:00Z').toISOString(),
  );
  const empty = scriptedPool([[[{ oldest: null }]]]);
  assert.equal(await createKnownPeersRepository({ pool: empty.pool }).oldestFirstSeen('site:3'), null);
  const none = scriptedPool();
  assert.equal(await createKnownPeersRepository({ pool: none.pool }).oldestFirstSeen(null), null);
  assert.equal(none.calls.length, 0);
});
