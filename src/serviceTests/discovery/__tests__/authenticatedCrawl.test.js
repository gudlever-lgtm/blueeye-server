'use strict';

// A crawl that was signed in (V2 Discovery, extended).
//
// One behaviour matters more than everything else here: a crawl that loses its
// session must STOP. If it carries on, it maps the public site and hands back a
// result that everything downstream will treat as a map of the authenticated
// application — and nothing could tell the difference afterwards.
//
// Half a private map, labelled as half, is worth having. A public map labelled
// as private is not.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { crawl, bestLogin, STOP } = require('../crawl');

const page = (url, over = {}) => ({
  url, title: 'Cases', http_status: 200,
  links: [], buttons: [], inputs: [], forms: [], requests: [],
  ...over,
});

// A site where /cases links onward, and the third page has been logged out.
function siteWithSessionLoss() {
  return {
    'https://app.test/': page('https://app.test/', {
      links: [{ href: '/cases', text: 'Cases' }],
    }),
    'https://app.test/cases': page('https://app.test/cases', {
      links: [{ href: '/cases/1', text: 'View case' }],
    }),
    // Logged out: a password field is back.
    'https://app.test/cases/1': page('https://app.test/cases/1', {
      title: 'Log ind', links: [], inputs: [{ type: 'password', name: 'password' }],
    }),
  };
}

const browserFor = (site) => ({
  visit: async (url) => site[url] || page(url, { http_status: 404 }),
});

test('a signed-in crawl counts the pages it saw while signed in', async () => {
  const site = {
    'https://app.test/': page('https://app.test/', { links: [{ href: '/cases', text: 'Cases' }] }),
    'https://app.test/cases': page('https://app.test/cases'),
  };
  const result = await crawl({
    browser: browserFor(site), startUrl: 'https://app.test/', signedIn: true,
  });
  assert.equal(result.summary.page_count, 2);
  // The number that says whether authenticating was worth it.
  assert.equal(result.summary.authenticated_page_count, 2);
  assert.equal(result.sessionLostAtPage, null);
  assert.equal(result.stopped, STOP.COMPLETE);
});

test('losing the session STOPS the crawl rather than continuing anonymously', async () => {
  const result = await crawl({
    browser: browserFor(siteWithSessionLoss()), startUrl: 'https://app.test/', signedIn: true,
  });

  assert.equal(result.stopped, STOP.SESSION_LOST);
  assert.match(result.sessionLostReason, /session has gone/);
  // The page that PROVED the session went is not itself counted as private.
  assert.equal(result.summary.authenticated_page_count, 2);
  assert.equal(result.sessionLostAtPage, 2);
});

test('an anonymous crawl never claims authenticated pages and never trips the check', async () => {
  // The same site, crawled without signing in. A password field on a page is
  // completely normal here — it is the login page.
  const result = await crawl({
    browser: browserFor(siteWithSessionLoss()), startUrl: 'https://app.test/',
  });
  assert.equal(result.summary.authenticated_page_count, 0);
  assert.equal(result.sessionLostAtPage, null);
  assert.notEqual(result.stopped, STOP.SESSION_LOST);
});

test('the detected login form is kept so the NEXT discovery can sign in', async () => {
  // The answer to the chicken-and-egg, at the level that produces it: the
  // anonymous pass hands back the form it found.
  const site = {
    'https://app.test/': page('https://app.test/', { links: [{ href: '/login', text: 'Log ind' }] }),
    'https://app.test/login': page('https://app.test/login', {
      title: 'Log ind',
      inputs: [
        { type: 'text', name: 'email', label: 'Email', autocomplete: 'username' },
        { type: 'password', name: 'password', label: 'Password' },
      ],
      forms: [{ action: '/login', method: 'post' }],
    }),
  };
  const result = await crawl({ browser: browserFor(site), startUrl: 'https://app.test/' });
  assert.ok(result.summary.detected_login, 'the login form was not kept');
  assert.equal(result.summary.detected_login.url, 'https://app.test/login');
});

test('the most confident login form wins when a site has several', () => {
  // Three detected forms usually means one real login and two password-change
  // boxes.
  const best = bestLogin([
    { possible: true, confidence: 'low', url: '/change-password' },
    { possible: true, confidence: 'high', url: '/login' },
    { possible: true, confidence: 'medium', url: '/reset' },
  ]);
  assert.equal(best.url, '/login');
  assert.equal(bestLogin([]), null);
  assert.equal(bestLogin(null), null);
});

test('the kept login form carries field DESCRIPTIONS, never values', () => {
  // It is written to a database column and read by a UI. A credential must not
  // be able to reach it even by accident.
  const best = bestLogin([{
    possible: true, confidence: 'high', url: '/login',
    usernameField: { label: 'Email', name: 'email' },
    passwordField: { label: 'Password', name: 'password' },
    submitLabel: 'Log ind',
  }]);
  const text = JSON.stringify(best);
  assert.ok(!/value/i.test(text), 'no field value may be carried');
  assert.deepEqual(Object.keys(best).sort(),
    ['confidence', 'passwordField', 'submitLabel', 'url', 'usernameField']);
});
