'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// "fellis-instance: the agent refused the update — refused: command signature
// verification failed", and then nothing. The fix for that exact refusal is one
// button in this dashboard — re-pin the agent onto the key this server signs
// with — and the operator was never offered it, because the matcher that
// decides whether to offer it did not know the agent's actual wording.
//
// The agent's refusal strings are a cross-repo contract (blueeye-agent
// src/commandAuth.js). These tests pin them, so a reworded refusal over there
// fails here rather than quietly turning the fix back into a dead end.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// The two predicates, lifted out of the dashboard bundle and run for real —
// re-implementing them in the test would only pin the test's opinion.
function loadPredicates() {
  const src = [
    APP.slice(APP.indexOf('function isPinnedKeyRefusal'), APP.indexOf('// The way out of a pinned-key deadlock')),
    'module.exports = { isPinnedKeyRefusal, clockSkewRefusal };',
  ].join('\n');
  const module = { exports: {} };
  vm.runInNewContext(src, { module, exports: module.exports });
  return module.exports;
}

const { isPinnedKeyRefusal, clockSkewRefusal } = loadPredicates();

// Verbatim from blueeye-agent src/commandAuth.js.
const AGENT_REFUSALS = {
  signatureFailed: 'refused: command signature verification failed',
  noPublicKey: 'refused: command is signed but no release public key is configured',
  unsignedRekey: 'refused: an unsigned rekey cannot replace a trust anchor this agent already holds. '
    + 'Send it signed with the key this agent pins.',
  unsignedCommand: 'refused: unsigned command (this agent requires signed commands)',
  wrongAgent: 'refused: command was signed for a different agent',
  noAgent: 'refused: signed command names no agent',
  replay: 'refused: signed command is outside the accepted time window (replay?)',
};

test('the refusal a wrong pinned key produces offers the re-pin', async () => {
  // THE regression. This string is what a fleet sees when the server's signing
  // key was regenerated after the agents were installed.
  assert.equal(isPinnedKeyRefusal(AGENT_REFUSALS.signatureFailed), true);
  assert.equal(isPinnedKeyRefusal(AGENT_REFUSALS.noPublicKey), true);
  assert.equal(isPinnedKeyRefusal(AGENT_REFUSALS.unsignedRekey), true);
  // The wordings that were already covered stay covered.
  assert.equal(isPinnedKeyRefusal('refusing unsigned update: a release public key is pinned'), true);
  assert.equal(isPinnedKeyRefusal('release signature did not verify'), true);
});

test('a refusal a re-pin would NOT fix does not offer one', async () => {
  // Offering the wrong fix is worse than offering none: it costs a trust change
  // on a production host and still leaves the update broken.
  //
  // The server cannot sign → the fix is a signing key, not a new anchor.
  assert.equal(isPinnedKeyRefusal(AGENT_REFUSALS.unsignedCommand), false);
  // Clock skew → the fix is the clock.
  assert.equal(isPinnedKeyRefusal(AGENT_REFUSALS.replay), false);
  assert.equal(clockSkewRefusal(AGENT_REFUSALS.replay), true);
  // An identity mix-up → re-pinning changes nothing about which agent it is.
  assert.equal(isPinnedKeyRefusal(AGENT_REFUSALS.wrongAgent), false);
  assert.equal(isPinnedKeyRefusal(AGENT_REFUSALS.noAgent), false);
});

test('nothing at all is not a key problem', async () => {
  for (const v of [undefined, null, '', 'the agent gave no reason']) {
    assert.equal(isPinnedKeyRefusal(v), false, String(v));
    assert.equal(clockSkewRefusal(v), false, String(v));
  }
});

test('the refusal path offers the re-pin, not just a toast', async () => {
  // The audit-follow path already did this; the REFUSAL path — the one that
  // fires while the operator is still looking at the screen — did not.
  const refusalBranch = APP.slice(APP.indexOf('async function updateAgent'), APP.indexOf('async function followAgentAction'));
  assert.match(refusalBranch, /isPinnedKeyRefusal\(r\.reason\)/);
  assert.match(refusalBranch, /showRepinCommand\(a, r\.reason, \{ retryUpdate: true \}\)/);
});

// ------------------------------------------------- what the agent tells us
const { validateCapabilities } = require('../src/validation/agentValidation');

test('an agent may report WHICH release key it trusts', async () => {
  const fp = 'a'.repeat(64);
  const errors = {};
  const caps = validateCapabilities({ sources: ['proc'], releaseKeyFingerprint: fp.toUpperCase() }, errors);
  assert.deepEqual(errors, {});
  assert.equal(caps.releaseKeyFingerprint, fp, 'normalised to lower case, so a comparison is a comparison');
});

test('a junk fingerprint is dropped, never a reason to refuse the report', async () => {
  // The fingerprint is a diagnostic. An agent whose report is rejected over one
  // stops telling the server what it can do — which is the thing that actually
  // matters.
  for (const bad of ['nope', 'a'.repeat(63), 'g'.repeat(64), 42, {}]) {
    const errors = {};
    const caps = validateCapabilities({ sources: ['proc'], releaseKeyFingerprint: bad }, errors);
    assert.deepEqual(errors, {}, JSON.stringify(bad));
    assert.equal(caps.releaseKeyFingerprint, null, JSON.stringify(bad));
  }
});

test('an agent that reports no fingerprint is unchanged', async () => {
  const errors = {};
  const caps = validateCapabilities({ sources: ['proc'] }, errors);
  assert.deepEqual(errors, {});
  assert.equal('releaseKeyFingerprint' in caps, false, 'an old agent is not given a null it never sent');
});
