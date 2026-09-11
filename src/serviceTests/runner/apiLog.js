'use strict';

const { numOrNull } = require('../storage/shape');

// The API calls behind a run — what the page asked the service for, and what it
// got back (V2 §5, API correlation).
//
// A failing browser test says the journey broke. The operator's next question is
// always "was that the browser, the page, or the service behind it?", and until
// now nothing could answer it: the runner watched every request the page made
// and kept only the failures, with no method and no timing.
//
// Pure. The driver feeds it observations; everything about WHAT is worth keeping
// and WHAT must never be stored is decided here, where it is testable without a
// browser.

// Only the requests that answer the question. A page load is a hundred images,
// fonts and stylesheets; none of them tell you whether the service works, and
// keeping them would bury the four calls that do.
const KEPT_TYPES = new Set(['xhr', 'fetch', 'document']);

// A hard ceiling per run. A single-page app polling every second for a five
// minute test would otherwise write tens of thousands of rows into one JSON
// column. The newest are kept: a failure is at the END of a run.
const MAX_CALLS = 100;

// Query parameters whose VALUE is a credential. A token in a query string is
// still a token, and this column is rendered in a UI and read by support — so
// the value never reaches storage, masked at the boundary rather than at render
// time, where one forgotten template would leak it.
const SECRET_PARAMS = [
  'token', 'access_token', 'refresh_token', 'id_token', 'auth', 'authorization',
  'key', 'api_key', 'apikey', 'secret', 'client_secret', 'password', 'passwd', 'pwd',
  'sig', 'signature', 'session', 'sessionid', 'sid', 'code', 'state', 'nonce',
];
// ASCII on purpose: URLSearchParams percent-encodes anything else, so a "•••"
// mask reaches the screen as %E2%80%A2%E2%80%A2%E2%80%A2 — unreadable, and it
// stops looking like a deliberate redaction.
const MASK = 'REDACTED';

// The URL as it is safe to store: sensitive query values masked, credentials in
// userinfo dropped, length bounded. An unparseable URL is truncated rather than
// guessed at — never returned raw at full length.
function safeUrl(raw, { maxLength = 512 } = {}) {
  const text = String(raw == null ? '' : raw);
  let url;
  try { url = new URL(text); } catch { return text.slice(0, maxLength); }
  // Credentials in the authority (https://user:pass@host/…) are a credential
  // pair in plain sight.
  url.username = '';
  url.password = '';
  for (const [name] of [...url.searchParams]) {
    if (SECRET_PARAMS.includes(name.toLowerCase())) url.searchParams.set(name, MASK);
  }
  return url.toString().slice(0, maxLength);
}

// Is this call worth keeping? `document` earns its place because a navigation
// that answers 302 or 500 IS the story on a login test.
function isWorthKeeping({ resourceType }) {
  return KEPT_TYPES.has(String(resourceType || '').toLowerCase());
}

// The verdict an operator reads first — the V2 §13 shape:
//
//   Browser ✓ · Page ✓ · API ✗ · HTTP 503
//
// Deliberately three separate answers rather than one. "The test failed" is what
// they already know; WHICH layer failed is what they came for, and collapsing
// them into a single status is what made the old result unreadable.
//
// `browserOk` is false only when the run never got off the ground (no browser);
// `pageOk` is false when the page itself errored or a navigation failed;
// `apiOk` is false when an xhr/fetch call answered 4xx/5xx or never answered.
function verdictOf({ calls = [], consoleErrors = [], failedToStart = false } = {}) {
  // A stored run is read back from a JSON column written by an older version, so
  // a row that is null or not an object is a shape this can actually be handed —
  // and a failure report must never be the thing that throws.
  const kept = (Array.isArray(calls) ? calls : []).filter((c) => c && typeof c === 'object');
  const documents = kept.filter((c) => c.resource_type === 'document');
  const apis = kept.filter((c) => c.resource_type !== 'document');
  const bad = (c) => c.status === 0 || (Number.isFinite(c.status) && c.status >= 400);

  const failedApi = apis.filter(bad).sort((a, b) => (b.status || 0) - (a.status || 0))[0] || null;
  const failedDocument = documents.filter(bad)[0] || null;

  return {
    browser: !failedToStart,
    page: !failedToStart && !failedDocument && !(consoleErrors || []).length,
    api: !failedToStart && !failedApi,
    // The status worth printing next to the verdict: the API failure if there is
    // one, else a failing navigation.
    http_status: (failedApi && failedApi.status) || (failedDocument && failedDocument.status) || null,
    failed_call: failedApi || failedDocument || null,
  };
}

// Collects observations from the driver and hands back the stored shape.
//
//   const log = createApiLog();
//   log.start(id, { method, url, resourceType }, atMs);
//   log.finish(id, { status }, atMs);
//   log.fail(id, { error }, atMs);
//   log.calls()  ->  [{ method, url, status, duration_ms, resource_type, error }]
//
// `now` is injected so a spec can assert a duration without sleeping.
// Milliseconds between two instants, or null when either is not a real instant.
function durationBetween(startedAt, endedAt) {
  const a = numOrNull(startedAt);
  const b = numOrNull(endedAt);
  if (a === null || b === null) return null;
  return Math.max(0, Math.round(b - a));
}

function createApiLog({ now = () => Date.now(), max = MAX_CALLS, redact = null } = {}) {
  const open = new Map();
  const done = [];
  const mask = redact && typeof redact.text === 'function' ? redact.text : (s) => s;

  function start(id, { method, url, resourceType } = {}, at = now()) {
    if (!isWorthKeeping({ resourceType })) return false;
    open.set(id, {
      method: String(method || 'GET').toUpperCase().slice(0, 10),
      // Masked on the way IN: a secret that never enters the array cannot leave
      // it through a path someone forgot to scrub.
      url: mask(safeUrl(url)),
      resource_type: String(resourceType || '').toLowerCase(),
      startedAt: at,
    });
    return true;
  }

  function settle(id, patch, at = now()) {
    const started = open.get(id);
    if (!started) return false;
    open.delete(id);
    const { startedAt, ...rest } = started;
    done.push({
      ...rest,
      // Subtraction is the arithmetic cousin of the Number(null) trap: `5 - null`
      // is 5, so a missing startedAt would report the absolute clock value as a
      // duration. startedAt is always set by open(), but the guard is explicit
      // rather than relying on that staying true.
      duration_ms: durationBetween(startedAt, at),
      ...patch,
    });
    // Keep the NEWEST: a failure is at the end of a run, and the first hundred
    // requests of a page load are the least interesting thing in it.
    while (done.length > max) done.shift();
    return true;
  }

  return {
    start,
    finish: (id, { status } = {}, at = now()) => settle(id, { status: Number(status) || 0, error: null }, at),
    fail: (id, { error } = {}, at = now()) => settle(id, { status: 0, error: mask(String(error || 'request failed')).slice(0, 200) }, at),
    // A request still in flight when the run ended never answered — which is
    // exactly what a hung API looks like, so it is reported rather than dropped.
    calls() {
      const pending = [...open.values()].map(({ startedAt, ...rest }) => ({
        ...rest, status: 0, duration_ms: null, error: 'no response before the run ended',
      }));
      return [...done, ...pending].slice(-max);
    },
    get size() { return done.length + open.size; },
  };
}

module.exports = { createApiLog, safeUrl, verdictOf, isWorthKeeping, SECRET_PARAMS, KEPT_TYPES, MAX_CALLS, MASK };
