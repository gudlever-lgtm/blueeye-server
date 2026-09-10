'use strict';

const { detectLogin } = require('../discovery/extract');

// Rule-based test suggestions (spec §11-12).
//
// EXPLICITLY NOT AI. Each rule is a stated condition over what Discovery found,
// and each suggestion carries the reason it was proposed, so an operator can
// judge it rather than trust it:
//
//   Login · Confidence: High
//   Reason: Detected username field, password field and Login button.
//
// Pure: a discovery result in, suggestions out.

const CONFIDENCE = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

const pathOf = (url) => { try { return new URL(url).pathname; } catch { return String(url || ''); } };

// ---------------------------------------------------------------- login
// A password field plus corroboration. The steps are built from the actual
// targets Discovery recorded, so an accepted suggestion is runnable as-is.
function suggestLogin(result) {
  const login = (result.logins || [])[0];
  if (!login || !login.possible) return null;

  const steps = [{ type: 'open', url: pathOf(login.url) }];
  if (login.username_field) steps.push({ type: 'fill', target: login.username_field, value: '{{credential.username}}' });
  if (login.password_field) steps.push({ type: 'fill', target: login.password_field, value: '{{credential.password}}' });
  if (login.submit) steps.push({ type: 'click', target: login.submit });

  // Something that only appears after signing in is the assertion. A page the
  // crawl reached that is NOT the login page is the best available guess.
  const after = (result.pages || []).find((p) => p.url !== login.url && !/login|signin|sign-in/i.test(p.url));
  if (after && after.title) {
    steps.push({ type: 'assert_text_contains', target: { text: after.title.slice(0, 60) }, value: after.title.slice(0, 60) });
  } else {
    steps.push({ type: 'assert_url_contains', value: '/' });
  }

  return {
    name: 'Login',
    description: 'Verify that a user can sign in and reach the page behind the login.',
    confidence: login.confidence || CONFIDENCE.MEDIUM,
    reason: `${login.reasons.join(', ')}.`,
    proposed_steps: steps,
  };
}

// ---------------------------------------------------------------- logout
function suggestLogout(result) {
  const logout = (result.elements || []).find((e) => {
    const text = `${e.label || ''} ${(e.attributes && e.attributes.href) || ''}`.toLowerCase();
    return /log ?out|log ?ud|sign ?out|logoff/.test(text);
  });
  if (!logout) return null;
  const target = (logout.attributes && logout.attributes.target) || { text: logout.label };
  return {
    name: 'Logout',
    description: 'Verify that signing out works and the session ends.',
    confidence: CONFIDENCE.MEDIUM,
    reason: `Found a sign-out control labelled "${logout.label}".`,
    proposed_steps: [
      { type: 'click', target },
      { type: 'assert_url_contains', value: 'login' },
    ],
  };
}

// ---------------------------------------------------------------- search
function suggestSearch(result) {
  const input = (result.elements || []).find((e) => {
    if (e.kind !== 'input') return false;
    const h = `${e.label || ''} ${JSON.stringify(e.attributes || {})}`.toLowerCase();
    return /search|søg|query|find/.test(h);
  });
  if (!input) return null;
  const target = (input.attributes && input.attributes.target) || { label: input.label };
  return {
    name: 'Search',
    description: 'Verify that searching returns a result page.',
    confidence: CONFIDENCE.MEDIUM,
    reason: `Found a search field ("${input.label}").`,
    proposed_steps: [
      { type: 'fill', target, value: 'test' },
      { type: 'wait', ms: 1000 },
      { type: 'assert_url_contains', value: '' },
    ],
  };
}

// ---------------------------------------------------------------- contact form
// Suggested, never auto-run: Discovery does not submit forms, and a contact form
// sends mail to a real person (spec §12).
function suggestContactForm(result) {
  const forms = (result.elements || []).filter((e) => e.kind === 'form');
  if (!forms.length) return null;
  const inputs = (result.elements || []).filter((e) => e.kind === 'input');
  const has = (re) => inputs.some((i) => re.test(`${i.label || ''} ${JSON.stringify(i.attributes || {})}`.toLowerCase()));
  const name = has(/\bname\b|navn/);
  const email = has(/email|e-mail|mail/);
  const message = has(/message|besked|comment|kommentar/);
  if (!(name && email && message)) return null;

  return {
    name: 'Contact form',
    description: 'Fill in the contact form and check that it is accepted. Review the steps before running — this sends a real message.',
    confidence: CONFIDENCE.LOW,
    reason: 'Found name, email and message fields together with a form. Discovery did not submit it.',
    proposed_steps: [
      { type: 'open', url: pathOf((forms[0] && forms[0].pageUrl) || '/') },
      { type: 'assert_exists', target: { text: 'Send' } },
    ],
  };
}

// ---------------------------------------------------------------- navigation
// A journey through the pages the crawl actually reached. Only suggested when
// there is a login, because "click through three public pages" is a weaker test
// than "sign in and reach the pages behind it".
function suggestAuthenticatedNavigation(result) {
  const login = (result.logins || [])[0];
  if (!login || !login.possible) return null;
  const pages = (result.pages || [])
    .filter((p) => p.url !== login.url && p.http_status === 200)
    .slice(0, 3);
  if (pages.length < 2) return null;

  const steps = [{ type: 'open', url: pathOf(login.url) }];
  if (login.username_field) steps.push({ type: 'fill', target: login.username_field, value: '{{credential.username}}' });
  if (login.password_field) steps.push({ type: 'fill', target: login.password_field, value: '{{credential.password}}' });
  if (login.submit) steps.push({ type: 'click', target: login.submit });
  for (const page of pages) {
    steps.push({ type: 'open', url: pathOf(page.url) });
    steps.push({ type: 'assert_http_status', status: 200 });
  }

  return {
    name: 'Authenticated navigation',
    description: `Sign in and visit ${pages.length} pages behind the login.`,
    confidence: CONFIDENCE.MEDIUM,
    reason: `Discovery reached ${pages.length} pages after a possible login flow: ${pages.map((p) => pathOf(p.url)).join(' → ')}.`,
    proposed_steps: steps,
  };
}

// ---------------------------------------------------------------- availability
// The fallback that always applies: the application answered at all.
function suggestAvailability(result) {
  const first = (result.pages || [])[0];
  if (!first) return null;
  return {
    name: 'Availability',
    description: 'Open the front page and check that it answers.',
    confidence: CONFIDENCE.HIGH,
    reason: `Discovery reached ${first.url} and got HTTP ${first.http_status ?? 'no response'}.`,
    proposed_steps: [
      { type: 'open', url: pathOf(first.url) },
      { type: 'assert_http_status', status: 200 },
      ...(first.title ? [{ type: 'assert_text_contains', target: { text: first.title.slice(0, 60) }, value: first.title.slice(0, 60) }] : []),
    ],
  };
}

const RULES = [
  suggestAvailability,
  suggestLogin,
  suggestAuthenticatedNavigation,
  suggestSearch,
  suggestLogout,
  suggestContactForm,
];

// Runs every rule over a discovery result. A rule that throws is skipped rather
// than failing the whole suggestion pass — one bad heuristic must not cost the
// operator the other five.
function suggestTests(result = {}) {
  const safe = result && typeof result === 'object' ? result : {};
  const out = [];
  for (const rule of RULES) {
    try {
      const suggestion = rule(safe);
      if (suggestion && suggestion.proposed_steps && suggestion.proposed_steps.length) out.push(suggestion);
    } catch { /* skip this rule */ }
  }
  return out;
}

module.exports = { suggestTests, RULES, CONFIDENCE, pathOf };
