'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createCommandSigner } = require('../src/services/commandSigner');
const { canonicalize } = require('../src/lib/canonicalize');

// A stand-in for releaseKeyService holding a managed private key.
function makeKeyService({ canSign = true, throws = false } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    service: {
      canSign: () => canSign,
      sign: (manifest) => {
        if (throws) throw new Error('key unavailable');
        return crypto.sign(null, Buffer.from(canonicalize(manifest)), privateKey).toString('base64');
      },
    },
  };
}

// Mirrors blueeye-agent src/commandAuth.js: verify over the canonical bytes of
// everything except the signature and the transport correlation id.
function agentVerifies(command, publicPem) {
  const payload = {};
  for (const [k, v] of Object.entries(command)) {
    if (k === 'commandSignature' || k === 'id') continue;
    payload[k] = v;
  }
  return crypto.verify(null, Buffer.from(canonicalize(payload)), publicPem, Buffer.from(command.commandSignature, 'base64'));
}

test('a signed command verifies with the agent\'s rules and is bound to agent + time', () => {
  const { publicPem, service } = makeKeyService();
  const signer = createCommandSigner({ releaseKeyService: service });

  const command = signer.sign(42, { name: 'delete', auditId: 7 });
  assert.equal(command.agentId, 42);
  assert.ok(Number.isFinite(Date.parse(command.issuedAt)), 'issuedAt must be a timestamp');
  assert.ok(command.commandSignature, 'commandSignature must be set');
  assert.equal(agentVerifies(command, publicPem), true);
});

test('the transport correlation id can be added afterwards without breaking the signature', () => {
  const { publicPem, service } = makeKeyService();
  const signer = createCommandSigner({ releaseKeyService: service });
  // sendCommandAndWait spreads an `id` onto the command at send time.
  const command = { ...signer.sign(42, { name: 'update', version: '1.2.3' }), id: 's123-4' };
  assert.equal(agentVerifies(command, publicPem), true);
});

test('every signed field is covered — tampering breaks verification', () => {
  const { publicPem, service } = makeKeyService();
  const signer = createCommandSigner({ releaseKeyService: service });
  const command = signer.sign(42, { name: 'install-tool', tool: 'traceroute', auditId: 7 });

  assert.equal(agentVerifies({ ...command, tool: 'mtr' }, publicPem), false);
  assert.equal(agentVerifies({ ...command, agentId: 43 }, publicPem), false);
  assert.equal(agentVerifies({ ...command, auditId: 8 }, publicPem), false);
  assert.equal(agentVerifies({ ...command, issuedAt: new Date(0).toISOString() }, publicPem), false);
});

test('a server without a managed signing key sends the command unchanged', () => {
  const { service } = makeKeyService({ canSign: false });
  const signer = createCommandSigner({ releaseKeyService: service });
  const command = signer.sign(42, { name: 'delete' });
  assert.deepEqual(command, { name: 'delete' }, 'no agentId/issuedAt/signature is added');
  assert.equal(signer.canSign(), false);

  // …and so does a server with no release key service at all.
  assert.deepEqual(createCommandSigner({}).sign(42, { name: 'delete' }), { name: 'delete' });
});

test('a signing failure REFUSES the command — it is never sent unsigned', () => {
  // The old behaviour was to warn and send it unsigned, which handed an attacker
  // a downgrade: break the signer and every agent that has not yet latched
  // accepts socket-only authority again.
  const { service } = makeKeyService({ throws: true });
  const errors = [];
  const audited = [];
  const signer = createCommandSigner({
    releaseKeyService: service,
    logger: { error: (m) => errors.push(m), warn: () => {}, info: () => {} },
    onFailure: (f) => audited.push(f),
  });

  assert.throws(() => signer.sign(42, { name: 'delete' }), (err) => {
    assert.equal(err.code, 'COMMAND_SIGNING_FAILED');
    assert.equal(err.statusCode, 503, 'the operator gets a 503, not a silent success');
    assert.equal(err.expose, true);
    return true;
  });
  assert.match(errors[0], /could not sign/);
  assert.deepEqual(audited.map((f) => [f.code, f.command]), [['COMMAND_SIGNING_FAILED', 'delete']]);
});

test('an auditing failure does not swallow the refusal', () => {
  const { service } = makeKeyService({ throws: true });
  const signer = createCommandSigner({
    releaseKeyService: service,
    onFailure: () => { throw new Error('audit db down'); },
  });
  assert.throws(() => signer.sign(42, { name: 'delete' }), /could not sign/);
});

test('BLUEEYE_REQUIRE_COMMAND_SIGNING refuses a privileged command a keyless server cannot sign', () => {
  const { service } = makeKeyService({ canSign: false });
  const signer = createCommandSigner({ releaseKeyService: service, requireSigning: true });
  assert.throws(() => signer.sign(42, { name: 'delete' }), (err) => {
    assert.equal(err.code, 'COMMAND_SIGNING_UNAVAILABLE');
    assert.equal(err.statusCode, 503);
    return true;
  });
});

test('each signed command carries a unique id and an explicit expiry', () => {
  const { publicPem, service } = makeKeyService();
  const issued = new Date('2026-01-01T12:00:00.000Z');
  const signer = createCommandSigner({ releaseKeyService: service, now: () => issued, ttlMs: 120000 });

  const a = signer.sign(42, { name: 'delete' });
  const b = signer.sign(42, { name: 'delete' });
  assert.notEqual(a.commandId, b.commandId, 'two identical commands must not share a nonce');
  assert.match(a.commandId, /^[0-9a-f-]{36}$/);
  assert.equal(a.expiresAt, '2026-01-01T12:02:00.000Z');

  // Both fields are INSIDE the signature, so neither can be edited in flight.
  assert.equal(agentVerifies(a, publicPem), true);
  assert.equal(agentVerifies({ ...a, commandId: b.commandId }, publicPem), false);
  assert.equal(agentVerifies({ ...a, expiresAt: '2026-12-01T00:00:00.000Z' }, publicPem), false);
});
