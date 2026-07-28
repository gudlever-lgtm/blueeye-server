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

test('a signing failure degrades to an unsigned command rather than blocking the action', () => {
  const { service } = makeKeyService({ throws: true });
  const warnings = [];
  const signer = createCommandSigner({ releaseKeyService: service, logger: { warn: (m) => warnings.push(m) } });
  const command = signer.sign(42, { name: 'delete' });
  assert.deepEqual(command, { name: 'delete' });
  assert.match(warnings[0], /command signing failed/);
});
