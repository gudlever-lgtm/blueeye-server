'use strict';

// Signing in before a crawl (V2 Discovery, extended).
//
// Discovery has always crawled what a logged-out visitor sees. It DETECTS the
// login form and stops — so everything behind the sign-in, which is where the
// actual user journeys live, has been invisible.
//
// PURE: descriptions in, decisions out. No browser, no database, no credentials.
// Every judgement about "can we sign in with this" and "are we still signed in"
// lives here where it can be argued with in a test; the worker does the driving.
//
// Two ways in, because of the chicken-and-egg — on a brand new application there
// is no login test yet:
//
//   1. Replay an existing LOGIN TEST. Most reliable: it already encodes how to
//      sign into this application, quirks included.
//   2. Use the login form the ANONYMOUS PASS ALREADY FOUND, with a stored
//      credential. Needs no prior setup, which is what makes the first
//      authenticated discovery possible at all.
//
// The second bootstraps the first.

// Steps that can appear in a test used purely to sign in. A "login" test that
// also creates a case is not a login test — replaying it would leave data behind
// on every discovery, and discovery is supposed to READ.
const SIGN_IN_STEP_TYPES = ['open', 'fill', 'click', 'select', 'checkbox', 'login', 'wait', 'assert_visible', 'assert_url_contains'];

// Steps that write. Present in a test, it is not safe to replay before a crawl.
const WRITING_STEP_TYPES = ['api_request', 'upload', 'download'];

// Words that mean "you are looking at a login page". Used to notice that the
// session went — in both languages the product ships in.
const LOGIN_PAGE_WORDS = [
  'log in', 'login', 'log on', 'logon', 'sign in', 'signin',
  'log ind', 'logind', 'adgangskode', 'kodeord', 'password',
];

// Is this test usable to sign in before a crawl?
//
// Refused with a reason rather than attempted and half-failed: a discovery that
// replays the wrong test leaves data behind, and a refusal an operator can read
// is repairable.
function canSignInWith(test, { applicationId = null } = {}) {
  if (!test || typeof test !== 'object') return { ok: false, reason: 'that test does not exist' };
  if (applicationId != null && Number(test.application_id) !== Number(applicationId)) {
    // A journey is about one service, and so is a sign-in.
    return { ok: false, reason: 'that test belongs to a different application' };
  }
  if (test.enabled === false) return { ok: false, reason: 'that test is turned off' };

  const steps = (test.definition && Array.isArray(test.definition.steps)) ? test.definition.steps : [];
  if (!steps.length) return { ok: false, reason: 'that test has no steps' };

  const writing = steps.find((s) => s && WRITING_STEP_TYPES.includes(s.type));
  if (writing) {
    return {
      ok: false,
      reason: `that test does more than sign in (it has a "${writing.type}" step), and discovery only reads`,
    };
  }
  const unknown = steps.find((s) => s && !SIGN_IN_STEP_TYPES.includes(s.type));
  if (unknown) {
    return { ok: false, reason: `that test has a "${unknown.type}" step, which discovery will not replay` };
  }

  // It has to actually sign in. A test that merely opens the front page would
  // "succeed" and leave the crawl anonymous while reporting it authenticated.
  const signsIn = steps.some((s) => s && (s.type === 'login'
    || (s.type === 'fill' && /\{\{credential\./.test(String(s.value || '')))));
  if (!signsIn) {
    return { ok: false, reason: 'that test never signs in — it uses no login step and no credential' };
  }
  if (!test.credential_id) {
    return { ok: false, reason: 'that test signs in but has no login selected' };
  }
  return { ok: true };
}

// Build sign-in steps from the login form the anonymous pass already found.
//
// This is the answer to "there is no login test yet". Discovery found the form
// on its first pass — the password field, the username field, the page it was
// on — so a rediscover can fill it in.
//
// Returns null rather than a guess when the detection is too weak. A speculative
// sign-in against a form that is not a login form types a username into
// somebody's search box and presses enter.
function signInStepsFromDetectedLogin(login, { minConfidence = 'medium' } = {}) {
  if (!login || typeof login !== 'object' || !login.possible) return null;
  const rank = { low: 0, medium: 1, high: 2 };
  if ((rank[login.confidence] ?? -1) < (rank[minConfidence] ?? 1)) return null;
  if (!login.url) return null;

  const username = login.usernameField || null;
  const password = login.passwordField || null;
  // Without a password field there is no login form, whatever else was detected.
  if (!password) return null;

  const steps = [{ type: 'open', url: login.url }];
  if (username) {
    steps.push({ type: 'fill', target: targetFor(username), value: '{{credential.username}}' });
  }
  steps.push({ type: 'fill', target: targetFor(password), value: '{{credential.password}}' });
  steps.push(login.submitLabel
    ? { type: 'click', target: { role: 'button', name: login.submitLabel } }
    // No named button: submitting the password field is what a person pressing
    // Enter does, and it is more reliable than guessing at a button.
    : { type: 'click', target: { role: 'button' } });
  return steps;
}

// The most stable way to point at a detected field, in the same preference
// order the runner resolves targets in.
function targetFor(field) {
  if (!field || typeof field !== 'object') return {};
  if (field.label) return { label: field.label };
  if (field.name) return { name: field.name };
  if (field.id) return { id: field.id };
  if (field.placeholder) return { placeholder: field.placeholder };
  return { css: field.css || 'input' };
}

// Are we STILL signed in?
//
// The failure mode this exists to prevent: a crawl gets logged out halfway,
// carries on mapping the PUBLIC site, and reports the result as a map of the
// authenticated application. That is worse than not having the feature, because
// the map would be trusted.
//
// Deliberately conservative. It only says "lost" when the page looks like the
// login page AGAIN — a password field where there was none, or a URL that went
// back to the sign-in path. A false "lost" merely stops a crawl early and says
// why; a false "still fine" produces a map of the wrong thing.
function sessionLost(pageSnapshot, { loginUrl = null } = {}) {
  if (!pageSnapshot || typeof pageSnapshot !== 'object') return { lost: false };

  const url = String(pageSnapshot.url || '');
  if (loginUrl && url && samePath(url, loginUrl)) {
    return { lost: true, reason: `the crawl was sent back to the sign-in page (${url})` };
  }

  // A password field on a page we reached while signed in is the clearest sign
  // the session went.
  const inputs = Array.isArray(pageSnapshot.inputs) ? pageSnapshot.inputs : [];
  const password = inputs.find((i) => i && String(i.type || '').toLowerCase() === 'password');
  if (password) {
    return { lost: true, reason: `a password field appeared on ${url || 'a page'}, so the session has gone` };
  }

  // A title that says "log in" is weaker evidence, and is only trusted when the
  // page also offers nothing else — a "Log in" LINK in the header of a normal
  // page is not a lost session, it is a header.
  const title = String(pageSnapshot.title || '').toLowerCase();
  const links = Array.isArray(pageSnapshot.links) ? pageSnapshot.links : [];
  if (LOGIN_PAGE_WORDS.some((w) => title.includes(w)) && links.length <= 3) {
    return { lost: true, reason: `the page is titled "${pageSnapshot.title}" and has almost nothing on it` };
  }
  return { lost: false };
}

function samePath(a, b) {
  try { return new URL(a).pathname.replace(/\/+$/, '') === new URL(b).pathname.replace(/\/+$/, ''); }
  catch { return false; }
}

// What to say about a discovery that asked to sign in.
//
// The headline number is what it found BEHIND the login, because that is the
// only reason to do this. And a discovery that could not get in says so plainly
// rather than quietly returning the public site.
function describeAuthentication({ requested = false, authenticated = false, note = null, pages = 0, authenticatedPages = 0, sessionLostAtPage = null } = {}) {
  if (!requested) return null;
  if (!authenticated) {
    return note
      ? `Could not sign in, so this is the public site only — ${note}`
      : 'Could not sign in, so this is the public site only.';
  }
  if (sessionLostAtPage !== null && sessionLostAtPage !== undefined) {
    return `Signed in, but the session was lost after ${sessionLostAtPage} page${sessionLostAtPage === 1 ? '' : 's'}. `
      + `${authenticatedPages} of ${pages} pages were seen while signed in — the rest are the public site.`;
  }
  return `Signed in. ${authenticatedPages} of ${pages} pages were only reachable once signed in.`;
}

module.exports = {
  canSignInWith, signInStepsFromDetectedLogin, sessionLost, describeAuthentication, targetFor,
  SIGN_IN_STEP_TYPES, WRITING_STEP_TYPES, LOGIN_PAGE_WORDS,
};
