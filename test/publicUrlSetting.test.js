'use strict';

// The address agents are told to use.
//
// One string ends up in every install script, every update one-liner and every
// enrolled agent's launcher — and an agent carries its token and the customer's
// network metadata on that connection. It has lived in BLUEEYE_PUBLIC_URL, an
// env var, which is answered by somebody with a shell and a redeploy while the
// address changes for reasons that reach the dashboard first.
//
// What that cost once: a proxy began redirecting http to https, the stored
// address still said http, and the fleet spent a day logging
// "handshake failed: HTTP 301" — a WebSocket handshake does not follow
// redirects. Nothing on either side said what was wrong.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSettingsService } = require('../src/services/settings');
const { resolveServerUrl, secureServerUrl } = require('../src/routes/enroll');

function makeService({ stored = null, envPublicUrl = '' } = {}) {
  const rows = new Map();
  if (stored) rows.set('publicUrl', stored);
  const livePublicUrl = { publicUrl: envPublicUrl, allowHttp: false };
  const service = createSettingsService({
    settingsRepo: {
      get: async (k) => (rows.has(k) ? rows.get(k) : null),
      set: async (k, v) => { rows.set(k, v); },
    },
    config: { geo: {}, discovery: {}, publicUrl: envPublicUrl },
    livePublicUrl,
  });
  return { service, livePublicUrl, rows };
}

const req = (host, proto = 'https') => ({ get: (h) => (h.toLowerCase() === 'host' ? host : ''), protocol: proto });

// ---- https is the default -------------------------------------------------

test('an http address is upgraded to https, and the port is kept', () => {
  assert.equal(secureServerUrl('http://blueeye.kunde.dk'), 'https://blueeye.kunde.dk');
  // :3000 was spelled out by somebody. Guessing 443 would break the one
  // deployment that bothered to say which port it listens on.
  assert.equal(secureServerUrl('http://blueeye.kunde.dk:3000'), 'https://blueeye.kunde.dk:3000');
  assert.equal(secureServerUrl('https://blueeye.kunde.dk'), 'https://blueeye.kunde.dk');
});

test('loopback is left alone — that is the dev server, not a deployment', () => {
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.equal(secureServerUrl(url), url, url);
  }
});

test('allowHttp is the way out, and nothing else is', () => {
  assert.equal(secureServerUrl('http://blueeye.intern', { allowHttp: true }), 'http://blueeye.intern');
  assert.equal(secureServerUrl('http://blueeye.intern', { allowHttp: false }), 'https://blueeye.intern');
  // Unparseable input is handed back as it came rather than mangled.
  assert.equal(secureServerUrl('not a url'), 'not a url');
  assert.equal(secureServerUrl(''), '');
});

// ---- what the install script gets -----------------------------------------

test('the stored address wins over the environment, and both win over the request', () => {
  const live = () => 'https://set-in-settings.dk';
  assert.equal(resolveServerUrl(req('whatever.dk'), { publicUrl: live }), 'https://set-in-settings.dk');
  // A plain string still works: that is how the tests and older wiring pass it.
  assert.equal(resolveServerUrl(req('whatever.dk'), { publicUrl: 'https://plain.dk' }), 'https://plain.dk');
  // Nothing configured: the request's own host, over https.
  assert.equal(resolveServerUrl(req('derived.dk', 'http'), {}), 'https://derived.dk');
});

test('a configured http address is STILL upgraded — this is the fleet-wide rule', () => {
  assert.equal(resolveServerUrl(req('x'), { publicUrl: () => 'http://blueeye.kunde.dk' }), 'https://blueeye.kunde.dk');
  assert.equal(
    resolveServerUrl(req('x'), { publicUrl: () => 'http://blueeye.intern', allowHttp: () => true }),
    'http://blueeye.intern',
    'an admin who said plain http is deliberate gets plain http',
  );
});

test('a forged Host header cannot be reflected into an install script', () => {
  const hostile = { get: () => 'evil.dk/../../x', protocol: 'https' };
  assert.equal(resolveServerUrl(hostile, {}), 'https://localhost');
});

// ---- the setting ----------------------------------------------------------

test('the setting reads back what was stored, beside what the environment says', async () => {
  const { service } = makeService({ envPublicUrl: 'https://from-env.dk' });
  const before = await service.getPublicUrl();
  assert.equal(before.publicUrl, '', 'nobody has set one');
  assert.equal(before.envPublicUrl, 'https://from-env.dk');
  assert.equal(before.effective, 'https://from-env.dk', 'so the env var is in force');

  const after = await service.setPublicUrl({ publicUrl: 'https://blueeye.kunde.dk/' });
  assert.equal(after.publicUrl, 'https://blueeye.kunde.dk', 'the trailing slash is trimmed on the way in');
  assert.equal(after.effective, 'https://blueeye.kunde.dk', 'and it wins over the env var');
});

test('saving it reaches the enroll router without a restart', async () => {
  // The router reads this per request and cannot await a database read, so the
  // live object is the seam. An address changed in Settings must be in the NEXT
  // install script, not after the next restart.
  const { service, livePublicUrl } = makeService({ envPublicUrl: 'https://old.dk' });
  await service.setPublicUrl({ publicUrl: 'https://new.dk' });
  assert.equal(livePublicUrl.publicUrl, 'https://new.dk');
  assert.equal(resolveServerUrl(req('x'), { publicUrl: () => livePublicUrl.publicUrl }), 'https://new.dk');

  // Cleared: back to the environment, not to an empty address.
  await service.setPublicUrl({ publicUrl: '' });
  assert.equal(livePublicUrl.publicUrl, 'https://old.dk');
});

test('allowHttp round-trips to the live object too', async () => {
  const { service, livePublicUrl } = makeService();
  await service.setPublicUrl({ publicUrl: 'http://blueeye.intern', allowHttp: true });
  assert.equal(livePublicUrl.allowHttp, true);
  assert.equal((await service.getPublicUrl()).publicUrl, 'http://blueeye.intern',
    'stored as typed — the upgrade happens where the address is handed out, so the screen shows the truth');
});

test('a stored override survives a restart', async () => {
  const { service, livePublicUrl } = makeService({ stored: { publicUrl: 'https://stored.dk', allowHttp: false }, envPublicUrl: 'https://env.dk' });
  assert.equal(livePublicUrl.publicUrl, 'https://env.dk', 'before the overrides are applied');
  await service.applyStoredOverrides();
  assert.equal(livePublicUrl.publicUrl, 'https://stored.dk');
});

test('what the validator refuses, and what it accepts', async () => {
  const { service } = makeService();
  for (const bad of ['notaurl', 'ftp://x.dk', 'https://x.dk/path', 'https://x.dk?a=1', 'https://x.dk#f']) {
    await assert.rejects(() => service.setPublicUrl({ publicUrl: bad }), (e) => e.statusCode === 400, bad);
  }
  // http IS accepted and stored as typed: refusing to store the truth would
  // leave the screen showing something nobody set. It is upgraded on the way
  // out, and the banner says so.
  assert.equal((await service.setPublicUrl({ publicUrl: 'http://x.dk' })).publicUrl, 'http://x.dk');
  assert.equal((await service.setPublicUrl({ publicUrl: 'https://x.dk:8443' })).publicUrl, 'https://x.dk:8443');
});
