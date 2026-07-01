'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLicenseVerifier } = require('../licenseVerifier');
const { createOfflineLicenseManager } = require('../offlineLicenseManager');
const { createPlanService } = require('../planService');
const { canonicalize } = require('../../lib/canonicalize');

// A throwaway Ed25519 key pair — the offline license is signed with the PRIVATE
// key (as blueeye-licens would) and verified here with the PUBLIC key only.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });

function sign(payload) {
  return crypto.sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey).toString('base64');
}
function licenseFile(payload) {
  return { payload, signature: sign(payload) };
}

const T = Date.parse('2026-06-07T00:00:00Z'); // fixed "now"
const basePayload = {
  organization_id: 'org-42',
  plan_key: 'professional',
  serverId: 'srv-1',
  valid_from: '2026-01-01T00:00:00Z',
  valid_until: '2027-01-01T00:00:00Z',
  max_agents_override: 50,
  max_test_paths_override: 300,
  enabled_features_override: ['rbac', 'sso_oidc', 'not_a_real_feature'],
};

function verifier(now = () => T, serverId = 'srv-1') {
  return createLicenseVerifier({ publicKey: PUBLIC_PEM, serverId, now });
}

// ---- LicenseVerifier ------------------------------------------------------

test('verifies a well-formed, in-window, correctly-signed license', () => {
  const r = verifier().verify(licenseFile(basePayload));
  assert.equal(r.valid, true);
  assert.equal(r.status, 'valid');
  assert.equal(r.plan, 'professional');
  assert.equal(r.organizationId, 'org-42');
  assert.deepEqual(r.limits, { max_agents: 50, max_test_paths: 300 });
  // Unknown feature keys are dropped (fail-closed); known ones pass.
  assert.deepEqual(r.features, { rbac: true, sso_oidc: true });
});

test('rejects a tampered payload (signature no longer verifies)', () => {
  const file = licenseFile(basePayload);
  file.payload = { ...basePayload, max_agents_override: 99999 }; // tamper after signing
  const r = verifier().verify(file);
  assert.equal(r.valid, false);
  assert.equal(r.status, 'invalid_signature');
});

test('rejects a license bound to a different server', () => {
  const r = verifier(() => T, 'srv-OTHER').verify(licenseFile(basePayload));
  assert.equal(r.valid, false);
  assert.equal(r.status, 'server_mismatch');
});

test('flags an expired license', () => {
  const r = verifier(() => Date.parse('2027-06-01T00:00:00Z')).verify(licenseFile(basePayload));
  assert.equal(r.valid, false);
  assert.equal(r.status, 'expired');
});

test('flags a not-yet-valid license', () => {
  const r = verifier(() => Date.parse('2025-06-01T00:00:00Z')).verify(licenseFile(basePayload));
  assert.equal(r.valid, false);
  assert.equal(r.status, 'not_yet_valid');
});

test('rejects a malformed file (missing signature)', () => {
  assert.equal(verifier().verify({ payload: basePayload }).status, 'malformed');
  assert.equal(verifier().verify(null).status, 'malformed');
  assert.equal(verifier().verify({ payload: basePayload, signature: 'not-base64-sig' }).status, 'invalid_signature');
});

test('a missing validity window is malformed, never perpetual', () => {
  // The issuer always emits both bounds; a correctly-signed payload without
  // them must fail closed rather than become a perpetual license.
  const noUntil = { ...basePayload };
  delete noUntil.valid_until;
  assert.equal(verifier().verify(licenseFile(noUntil)).status, 'malformed');

  const noFrom = { ...basePayload };
  delete noFrom.valid_from;
  assert.equal(verifier().verify(licenseFile(noFrom)).status, 'malformed');

  const nullWindow = { ...basePayload, valid_from: null, valid_until: null };
  assert.equal(verifier().verify(licenseFile(nullWindow)).status, 'malformed');
});

test('null overrides mean "use the plan default"', () => {
  const p = { ...basePayload, max_agents_override: null, max_test_paths_override: null, enabled_features_override: null };
  const r = verifier().verify(licenseFile(p));
  assert.equal(r.valid, true);
  assert.deepEqual(r.limits, { max_agents: null, max_test_paths: null });
  assert.deepEqual(r.features, {});
});

test('verifyFile: missing file → status missing (no throw)', () => {
  const r = verifier().verifyFile('/nope/does-not-exist.json');
  assert.equal(r.status, 'missing');
});

test('verifyFile: reads + verifies a real file on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-lic-'));
  const fp = path.join(dir, 'license.json');
  fs.writeFileSync(fp, JSON.stringify(licenseFile(basePayload)));
  const r = verifier().verifyFile(fp);
  assert.equal(r.valid, true);
  assert.equal(r.plan, 'professional');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- Offline license manager (restricted mode) ----------------------------

// A fake verifier so the manager can be tested without touching disk.
function fakeVerifier(result) {
  return { verifyFile: () => result, verify: () => result };
}

test('offline manager: a valid license is licensed and exposes plan/limits/features', async () => {
  const r = verifier().verify(licenseFile(basePayload));
  const mgr = createOfflineLicenseManager({ verifier: fakeVerifier(r), filePath: '/x', serverId: 'srv-1' });
  await mgr.validateOnce();
  assert.equal(mgr.isLicensed(), true);
  assert.equal(mgr.getPlan(), 'professional');
  assert.equal(mgr.getMaxAgents(), 50);
  assert.equal(mgr.getMaxTestPaths(), 300);
  assert.deepEqual(mgr.getFeatures(), { rbac: true, sso_oidc: true });
  assert.equal(mgr.canAcceptNewConnection(49), true);
  assert.equal(mgr.canAcceptNewConnection(50), false);
  const st = mgr.getStatus();
  assert.equal(st.mode, 'offline');
  assert.equal(st.status, 'valid');
  assert.equal(st.organizationId, 'org-42');
});

test('offline manager: an expired license drops to restricted mode', async () => {
  const r = verifier(() => Date.parse('2027-06-01T00:00:00Z')).verify(licenseFile(basePayload));
  const mgr = createOfflineLicenseManager({ verifier: fakeVerifier(r), filePath: '/x' });
  await mgr.validateOnce();
  assert.equal(mgr.isLicensed(), false);
  assert.equal(mgr.getMaxAgents(), 0);
  assert.deepEqual(mgr.getFeatures(), {});
  assert.equal(mgr.canAcceptNewConnection(0), false); // no new agents in restricted mode
  assert.equal(mgr.getStatus().status, 'expired');
});

test('offline manager: a missing license runs (restricted), never throws', async () => {
  const mgr = createOfflineLicenseManager({ verifier: fakeVerifier({ valid: false, status: 'missing', reason: 'none' }), filePath: '' });
  await mgr.validateOnce();
  assert.equal(mgr.isLicensed(), false);
  assert.equal(mgr.getStatus().status, 'unlicensed');
});

test('offline manager: getStatus defaults publicKeyTrust to embedded/configured', async () => {
  const r = verifier().verify(licenseFile(basePayload));
  const mgr = createOfflineLicenseManager({ verifier: fakeVerifier(r), filePath: '/x' });
  await mgr.validateOnce();
  assert.deepEqual(mgr.getStatus().publicKeyTrust, { source: 'embedded', configured: true });
});

test('offline manager: getStatus surfaces an injected keyTrust (e.g. a blocked env override)', async () => {
  const r = verifier().verify(licenseFile(basePayload));
  const keyTrust = { source: 'blocked', configured: true };
  const mgr = createOfflineLicenseManager({ verifier: fakeVerifier(r), filePath: '/x', keyTrust });
  await mgr.validateOnce();
  assert.deepEqual(mgr.getStatus().publicKeyTrust, keyTrust);
});

// ---- Plan service over the offline manager --------------------------------

test('plan service resolves plan + test-path override from the offline manager', () => {
  const r = verifier().verify(licenseFile(basePayload));
  const mgr = createOfflineLicenseManager({ verifier: fakeVerifier(r), filePath: '/x', serverId: 'srv-1' });
  mgr.validateOnce();
  const ps = createPlanService({ licenseManager: mgr });
  assert.equal(ps.getPlanKey(), 'professional');
  assert.equal(ps.getPlanLimit('max_agents'), 50); // override wins over plan's 25
  assert.equal(ps.getPlanLimit('max_test_paths'), 300); // override wins over plan's 150
});

test('plan service drops to unlicensed when the offline license is invalid', () => {
  const mgr = createOfflineLicenseManager({ verifier: fakeVerifier({ valid: false, status: 'invalid_signature', reason: 'bad' }), filePath: '/x' });
  mgr.validateOnce();
  const ps = createPlanService({ licenseManager: mgr });
  assert.equal(ps.getPlanKey(), 'unlicensed');
  assert.equal(ps.getPlanLimit('max_agents'), 0);
});
