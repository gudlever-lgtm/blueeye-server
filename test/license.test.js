import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  randomUUID,
} from 'node:crypto';
import { WebSocket } from 'ws';

import { createLicenseManager, initLicense, getLicense } from '../src/license/manager.js';
import { readCache } from '../src/license/cache.js';
import { initDb, closeDb } from '../src/db/database.js';
import * as registry from '../src/ws/registry.js';
import { startWsServer } from '../src/ws/server.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// A throwaway signing identity that stands in for the license server.
const vendor = generateKeyPairSync('ed25519');
const vendorPublicKey = vendor.publicKey.export({ type: 'spki', format: 'pem' });
// An unrelated key, used to forge a response with a bad signature.
const attacker = generateKeyPairSync('ed25519');

const LICENSE_KEY = 'BE-TEST-0001';
const SERVER_ID = 'srv-test';

function tmpCachePath() {
  return join(tmpdir(), `blueeye-license-${randomUUID()}.json`);
}

/** Mint a signed license token exactly as the license server would. */
function signToken(claims, privateKey = vendor.privateKey) {
  const bytes = Buffer.from(JSON.stringify(claims), 'utf8');
  return {
    signedLicense: bytes.toString('base64'),
    signature: cryptoSign(null, bytes, privateKey).toString('base64'),
    alg: 'ed25519',
  };
}

function validClaims(overrides = {}) {
  return {
    licenseKey: LICENSE_KEY,
    serverId: SERVER_ID,
    maxAgents: 5,
    plan: 'pro',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 365 * DAY_MS,
    active: true,
    ...overrides,
  };
}

/** fetch stub that returns a 200 with the given token. */
function okFetch(token) {
  return async () => ({ ok: true, status: 200, json: async () => token });
}
/** fetch stub that simulates being offline. */
function offlineFetch() {
  return async () => {
    throw new Error('ECONNREFUSED');
  };
}

function baseOpts(extra = {}) {
  return {
    enabled: true,
    licenseKey: LICENSE_KEY,
    serverId: SERVER_ID,
    publicKey: vendorPublicKey,
    graceMs: 14 * DAY_MS,
    cachePath: tmpCachePath(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. Valid validation
// ---------------------------------------------------------------------------
test('valid validation: verified license becomes operational and is cached', async () => {
  const cachePath = tmpCachePath();
  const token = signToken(validClaims({ maxAgents: 5 }));
  const mgr = createLicenseManager(baseOpts({ fetchImpl: okFetch(token), cachePath }));

  const state = await mgr.validateNow();

  assert.equal(state.status, 'valid');
  assert.equal(state.operational, true);
  assert.equal(state.maxAgents, 5);
  assert.equal(mgr.maxAgents(), 5);

  // The verified token is persisted so the grace period survives a restart.
  const cached = readCache(cachePath);
  assert.ok(cached, 'expected a cache file to be written');
  assert.equal(cached.signedLicense, token.signedLicense);
  assert.equal(typeof cached.validatedAt, 'number');

  rmSync(cachePath, { force: true });
});

// ---------------------------------------------------------------------------
// 2. Invalid signature
// ---------------------------------------------------------------------------
test('invalid signature: forged response is rejected, not adopted', async () => {
  const cachePath = tmpCachePath();
  // Signed by the attacker key, which the manager does not trust.
  const forged = signToken(validClaims(), attacker.privateKey);
  const mgr = createLicenseManager(baseOpts({ fetchImpl: okFetch(forged), cachePath }));

  const state = await mgr.validateNow();

  assert.equal(state.status, 'invalid');
  assert.equal(state.operational, false);
  assert.match(state.lastError, /signature verification failed/);
  // No cache should have been written for an untrusted response.
  assert.equal(readCache(cachePath), null);

  // And enforcement refuses agents in this state.
  const decision = mgr.canRegisterAgent('AG-1', []);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 4001);
});

// ---------------------------------------------------------------------------
// 3. Offline with cache (grace period)
// ---------------------------------------------------------------------------
test('offline with fresh cache: stays operational within the grace period', async () => {
  const cachePath = tmpCachePath();
  const token = signToken(validClaims({ maxAgents: 3 }));
  // Pretend we successfully validated 2 days ago, then went offline.
  writeFileSync(
    cachePath,
    JSON.stringify({
      signedLicense: token.signedLicense,
      signature: token.signature,
      validatedAt: Date.now() - 2 * DAY_MS,
    })
  );

  const mgr = createLicenseManager(baseOpts({ fetchImpl: offlineFetch(), cachePath }));
  // Cache is loaded at construction, before any network call.
  assert.equal(mgr.getState().status, 'grace');

  const state = await mgr.validateNow();
  assert.equal(state.status, 'grace');
  assert.equal(state.operational, true);
  assert.equal(state.maxAgents, 3);
  assert.equal(mgr.canRegisterAgent('AG-1', []).ok, true);

  rmSync(cachePath, { force: true });
});

test('offline with stale cache: hard fails once grace has expired', async () => {
  const cachePath = tmpCachePath();
  const token = signToken(validClaims());
  // Last validated 20 days ago — beyond the 14 day grace window.
  writeFileSync(
    cachePath,
    JSON.stringify({
      signedLicense: token.signedLicense,
      signature: token.signature,
      validatedAt: Date.now() - 20 * DAY_MS,
    })
  );

  const mgr = createLicenseManager(baseOpts({ fetchImpl: offlineFetch(), cachePath }));
  const state = await mgr.validateNow();

  assert.equal(state.status, 'invalid');
  assert.equal(state.operational, false);
  assert.equal(mgr.canRegisterAgent('AG-1', []).ok, false);

  rmSync(cachePath, { force: true });
});

test('offline with no cache: hard fails immediately', async () => {
  const mgr = createLicenseManager(baseOpts({ fetchImpl: offlineFetch() }));
  const state = await mgr.validateNow();
  assert.equal(state.operational, false);
  assert.notEqual(state.status, 'valid');
});

// ---------------------------------------------------------------------------
// 4. Agent over the limit
// ---------------------------------------------------------------------------
test('agent over limit: new agents beyond maxAgents are refused, reconnects are not', async () => {
  const token = signToken(validClaims({ maxAgents: 2 }));
  const mgr = createLicenseManager(baseOpts({ fetchImpl: okFetch(token) }));
  await mgr.validateNow();

  assert.equal(mgr.canRegisterAgent('A', []).ok, true);
  assert.equal(mgr.canRegisterAgent('B', ['A']).ok, true);

  const over = mgr.canRegisterAgent('C', ['A', 'B']);
  assert.equal(over.ok, false);
  assert.equal(over.code, 4002);

  // An already-connected agent may always reconnect, even at the cap.
  assert.equal(mgr.canRegisterAgent('A', ['A', 'B']).ok, true);
});

test('disabled license: enforcement is a no-op', () => {
  const mgr = createLicenseManager({ enabled: false });
  assert.equal(mgr.getState().status, 'disabled');
  assert.equal(mgr.maxAgents(), Infinity);
  assert.equal(mgr.canRegisterAgent('anything', ['x', 'y', 'z']).ok, true);
});

// ---------------------------------------------------------------------------
// End-to-end enforcement through the real WebSocket server
// ---------------------------------------------------------------------------
const dbPath = join(tmpdir(), `blueeye-license-ws-${randomUUID()}.db`);
initDb(dbPath);

test.after(() => {
  closeDb();
  rmSync(dbPath, { force: true });
});

async function startWs() {
  const wss = startWsServer(0);
  await new Promise((resolve) => {
    if (wss.address()) resolve();
    else wss.once('listening', resolve);
  });
  return { wss, url: `ws://127.0.0.1:${wss.address().port}` };
}

/**
 * Open a socket, send a register message, and report the outcome:
 *   { rejected: false }                         – server registered the agent
 *   { rejected: true, code, reason }            – server closed the socket
 */
function registerAgent(url, agentId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve({ ws, ...v });
      }
    };
    ws.on('open', () =>
      ws.send(
        JSON.stringify({ type: 'register', agentId, hostname: 'h', platform: 'linux' })
      )
    );
    ws.on('close', (code, reason) =>
      finish({ rejected: true, code, reason: reason?.toString() ?? '' })
    );
    ws.on('error', () => {});
    // Poll for server-side acceptance (in-process registry is authoritative).
    const started = Date.now();
    const iv = setInterval(() => {
      if (settled) return clearInterval(iv);
      if (registry.has(agentId)) {
        clearInterval(iv);
        finish({ rejected: false });
      } else if (Date.now() - started > 2000) {
        clearInterval(iv);
        finish({ rejected: true, code: 0, reason: 'timeout' });
      }
    }, 10);
  });
}

test('WS register is rejected with 4002 when over the agent limit', async () => {
  initLicense(baseOpts({ fetchImpl: okFetch(signToken(validClaims({ maxAgents: 2 }))) }));
  await getLicense().validateNow();

  const { wss, url } = await startWs();
  const opened = [];
  try {
    const a = await registerAgent(url, 'WS-A');
    const b = await registerAgent(url, 'WS-B');
    opened.push(a.ws, b.ws);
    assert.equal(a.rejected, false);
    assert.equal(b.rejected, false);

    const c = await registerAgent(url, 'WS-C');
    opened.push(c.ws);
    assert.equal(c.rejected, true);
    assert.equal(c.code, 4002);
  } finally {
    for (const ws of opened) ws.close();
    registry.unregister('WS-A');
    registry.unregister('WS-B');
    wss.close();
  }
});

test('WS register is rejected with 4001 when the license is not operational', async () => {
  // Offline, no cache → not operational.
  initLicense(baseOpts({ fetchImpl: offlineFetch() }));
  await getLicense().validateNow();
  assert.equal(getLicense().isOperational(), false);

  const { wss, url } = await startWs();
  try {
    const a = await registerAgent(url, 'WS-DENY');
    assert.equal(a.rejected, true);
    assert.equal(a.code, 4001);
    a.ws.close();
  } finally {
    wss.close();
  }
});
