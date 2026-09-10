'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyElement, isFollowable } = require('../safety');
const { extractElements, extractPage, detectLogin } = require('../extract');
const { crawl, canonical, sameHost, STOP } = require('../crawl');
const { suggestTests } = require('../../suggest/rules');
const { createHostPolicy } = require('../../security/hostPolicy');

// ------------------------------------------------------------------ safety
// Getting this wrong is not a failing test — it is a deleted record in someone's
// production system. So the rule is inverted: safe only when we can see why.
test('anything that could change data is refused, in both languages', () => {
  const destructive = [
    { kind: 'button', text: 'Delete customer' },
    { kind: 'button', text: 'Slet kunde' },
    { kind: 'button', text: 'Pay now' },
    { kind: 'button', text: 'Betal' },
    { kind: 'button', text: 'Send message' },
    { kind: 'button', text: 'Nulstil adgangskode' },
    { kind: 'link', text: 'Home', href: '/admin/users' },
    { kind: 'link', text: 'Ud', href: '/logout' },
  ];
  for (const el of destructive) assert.equal(classifyElement(el).destructive, true, JSON.stringify(el));
});

test('a form is never submitted, whatever its method', () => {
  assert.equal(classifyElement({ kind: 'form', method: 'post' }).destructive, true);
  assert.equal(classifyElement({ kind: 'form', method: 'get' }).destructive, true);
  assert.equal(classifyElement({ kind: 'button', type: 'submit', text: 'Søg' }).destructive, true);
});

test('an element whose effect cannot be determined is left alone', () => {
  // The branch that keeps Discovery honest: an unlabelled button is not "safe
  // because we found no dangerous word".
  assert.equal(classifyElement({ kind: 'button', text: '' }).destructive, true);
  assert.equal(classifyElement({ kind: 'button' }).destructive, true);
  assert.match(classifyElement({ kind: 'button', text: '' }).reason, /could not be determined/);
});

test('ordinary navigation links are followable', () => {
  assert.equal(isFollowable({ kind: 'link', text: 'View details', href: '/customers/1' }), true);
  assert.equal(isFollowable({ kind: 'link', text: 'Vis detaljer', href: '/kunder/1' }), true);
  assert.equal(isFollowable({ kind: 'link', text: 'Kunder', href: '/customers' }), true);
  assert.equal(isFollowable({ kind: 'button', text: 'Vis' }), false, 'only links are followed');
});

test('a word inside a longer word does not trigger a false positive', () => {
  // "reorder" contains "order"; "created" contains "create".
  assert.equal(classifyElement({ kind: 'link', text: 'Reorder list', href: '/list' }).destructive, false);
});

// ------------------------------------------------------------------ login
test('a login flow is only claimed when a password field is present', () => {
  assert.equal(detectLogin([{ label: 'Search' }], [{ text: 'Log in' }], '/login').possible, false,
    'wording alone must never be reported as a login flow');
  const found = detectLogin(
    [{ label: 'Username', name: 'user', autocomplete: 'username' }, { label: 'Password', type: 'password' }],
    [{ text: 'Login', role: 'button', accessibleName: 'Login' }],
    'https://app.test/login'
  );
  assert.equal(found.possible, true);
  assert.equal(found.confidence, 'high');
  assert.ok(found.username_field && found.password_field && found.submit);
});

test('a lone password field is low confidence — a change-password form looks the same', () => {
  const found = detectLogin([{ label: 'New password', type: 'password' }], [], '/profile');
  assert.equal(found.possible, true);
  assert.equal(found.confidence, 'low');
});

test('the extractor never records a field VALUE, only its metadata', () => {
  const { elements } = extractElements({
    url: 'https://app.test/login',
    inputs: [{ label: 'Password', type: 'password', name: 'pass' }],
    buttons: [], links: [], forms: [],
  });
  const input = elements.find((e) => e.kind === 'input');
  assert.ok(input);
  assert.equal(input.attributes.value, undefined, 'a prefilled field must not put user data in the discovery record');
});

test('a page row carries the status, redirects and failed requests', () => {
  const page = extractPage({
    url: 'https://app.test/a', title: 'A', status: 200, redirectedTo: 'https://app.test/b',
    loadMs: 120, consoleErrors: ['TypeError: x'], requests: [{ url: '/api/x', status: 503 }, { url: '/ok', status: 200 }],
  }, 2);
  assert.equal(page.http_status, 200);
  assert.equal(page.redirected_to, 'https://app.test/b');
  assert.equal(page.depth, 2);
  assert.equal(page.failed_requests.length, 1);
  assert.equal(page.console_errors.length, 1);
});

// ------------------------------------------------------------------ crawl
function makeSite(pages) {
  return { visit: async (url) => pages[url] || { url, status: 404, links: [], buttons: [], inputs: [], forms: [] } };
}

const SITE = {
  'https://app.test/': {
    url: 'https://app.test/', title: 'Forside', status: 200,
    links: [
      { text: 'Log ind', href: '/login' },
      { text: 'View customers', href: '/customers' },
      { text: 'Ekstern', href: 'https://other.example/' },
      { text: 'Slet alt', href: '/delete-all' },
    ],
    buttons: [], inputs: [], forms: [],
  },
  'https://app.test/login': {
    url: 'https://app.test/login', title: 'Log ind', status: 200,
    links: [], buttons: [{ text: 'Login', role: 'button', accessibleName: 'Login' }],
    inputs: [{ label: 'Username', name: 'user', autocomplete: 'username' }, { label: 'Password', type: 'password' }],
    forms: [{ action: '/login', method: 'post' }],
  },
  'https://app.test/customers': {
    url: 'https://app.test/customers', title: 'Kunder', status: 200,
    links: [], buttons: [], inputs: [], forms: [],
  },
};

test('the crawl stays on the application host and records external links without following them', async () => {
  const result = await crawl({ browser: makeSite(SITE), startUrl: 'https://app.test/' });
  assert.deepEqual(result.pages.map((p) => p.url).sort(), [
    'https://app.test/', 'https://app.test/customers', 'https://app.test/login',
  ]);
  assert.deepEqual(result.externalLinks, ['https://other.example/']);
  assert.equal(result.stopped, STOP.COMPLETE);
});

test('a destructive link is never followed', async () => {
  const result = await crawl({ browser: makeSite(SITE), startUrl: 'https://app.test/' });
  assert.ok(!result.pages.some((p) => p.url.includes('delete-all')), 'Discovery must not visit a delete link');
});

test('budgets stop the crawl and say which one bit', async () => {
  const many = {};
  const links = [];
  for (let i = 0; i < 30; i += 1) {
    links.push({ text: `Vis side ${i}`, href: `/p${i}` });
    many[`https://app.test/p${i}`] = { url: `https://app.test/p${i}`, status: 200, links: [], buttons: [], inputs: [], forms: [] };
  }
  many['https://app.test/'] = { url: 'https://app.test/', status: 200, links, buttons: [], inputs: [], forms: [] };

  const result = await crawl({ browser: makeSite(many), startUrl: 'https://app.test/', budgets: { maxPages: 5 } });
  assert.equal(result.pages.length, 5);
  assert.equal(result.stopped, STOP.MAX_PAGES);
});

test('the wall-clock budget stops a crawl that would otherwise run forever', async () => {
  let clock = 0;
  const result = await crawl({
    browser: { visit: async (url) => { clock += 1000; return { url, status: 200, links: [{ text: 'Vis mere', href: '/' + clock }], buttons: [], inputs: [], forms: [] }; } },
    startUrl: 'https://app.test/',
    budgets: { maxPages: 1000, maxDurationMs: 3000 },
    now: () => clock,
  });
  assert.equal(result.stopped, STOP.TIMEOUT);
});

test('the host policy is consulted for every navigation, not only the first', async () => {
  const checked = [];
  const policy = {
    check: async (url) => { checked.push(url); return { allowed: !url.includes('/customers'), reason: 'host_not_allowlisted' }; },
    checkSync: () => ({ allowed: true }),
  };
  const result = await crawl({ browser: makeSite(SITE), startUrl: 'https://app.test/', policy });
  assert.ok(checked.length >= 3, 'each queued page is checked');
  assert.ok(!result.pages.some((p) => p.url.includes('/customers')), 'a refused page is skipped, not crawled');
});

test('a page that fails to load is recorded rather than aborting the crawl', async () => {
  const browser = {
    visit: async (url) => {
      if (url.includes('/login')) throw new Error('net::ERR_CONNECTION_REFUSED');
      return SITE[url] || { url, status: 200, links: [], buttons: [], inputs: [], forms: [] };
    },
  };
  const result = await crawl({ browser, startUrl: 'https://app.test/' });
  const failed = result.pages.find((p) => p.url.includes('/login'));
  assert.ok(failed, 'the page that failed still appears in the record');
  assert.match(failed.console_errors[0], /ERR_CONNECTION_REFUSED/);
});

test('URL canonicalisation drops the fragment and keeps the query', () => {
  assert.equal(canonical('https://a.dk/x#frag'), 'https://a.dk/x');
  assert.equal(canonical('https://a.dk/x/'), 'https://a.dk/x');
  assert.ok(canonical('https://a.dk/x?a=1').includes('?a=1'));
  assert.equal(canonical('nonsense'), null);
  assert.equal(sameHost('https://a.dk/x', 'https://a.dk/y'), true);
  assert.equal(sameHost('https://a.dk', 'https://b.dk'), false);
});

// ------------------------------------------------------------------ suggest
test('a crawl produces the suggestions the spec asks for, each with a reason', async () => {
  const result = await crawl({ browser: makeSite(SITE), startUrl: 'https://app.test/' });
  const suggestions = suggestTests(result);
  const names = suggestions.map((s) => s.name);

  assert.ok(names.includes('Login'), 'a discovered login flow must produce a Login test');
  assert.ok(names.includes('Availability'));
  for (const s of suggestions) {
    assert.ok(s.reason && s.reason.length > 10, `${s.name} has no reason`);
    assert.ok(['low', 'medium', 'high'].includes(s.confidence), s.name);
    assert.ok(s.proposed_steps.length > 0, s.name);
  }
});

test('the Login suggestion is runnable as-is, built from the targets Discovery recorded', async () => {
  const result = await crawl({ browser: makeSite(SITE), startUrl: 'https://app.test/' });
  const login = suggestTests(result).find((s) => s.name === 'Login');

  const types = login.proposed_steps.map((s) => s.type);
  assert.deepEqual(types.slice(0, 4), ['open', 'fill', 'fill', 'click']);
  assert.equal(login.proposed_steps[1].value, '{{credential.username}}');
  assert.equal(login.proposed_steps[2].value, '{{credential.password}}');
  // The targets carry real hints, not placeholders.
  assert.ok(login.proposed_steps[1].target.label || login.proposed_steps[1].target.name);
});

test('no login flow means no Login suggestion — the rules do not invent one', () => {
  const suggestions = suggestTests({
    pages: [{ url: 'https://app.test/', title: 'Forside', http_status: 200 }],
    elements: [], logins: [],
  });
  assert.ok(!suggestions.some((s) => s.name === 'Login'));
  assert.ok(suggestions.some((s) => s.name === 'Availability'), 'the fallback still applies');
});

test('suggestTests survives garbage and a rule that throws', () => {
  for (const input of [undefined, null, 42, 'x', [], {}]) {
    assert.doesNotThrow(() => suggestTests(input));
  }
  // A malformed page entry must not cost the operator the other suggestions.
  const result = suggestTests({ pages: [null, { url: 'https://a.dk/', http_status: 200 }], elements: [null], logins: [null] });
  assert.ok(Array.isArray(result));
});
