'use strict';

// Authenticated discovery, END TO END through the worker.
//
// The pure decisions (`discovery/authenticate.js`) and the crawl loop
// (`discovery/crawl.js`) are covered in their own specs. What was NOT covered is
// the function that wires them to a browser and a credential: `signIn()` inside
// the worker. That is where a wiring mistake hides — the right decision taken
// against the wrong driver, a credential resolved and never used, a sign-in that
// fails and is recorded as a success.
//
// The failure this file exists to prevent: discovery reports a map of the PUBLIC
// site as the authenticated application. Nothing downstream can tell the
// difference afterwards, so every assertion about `authenticated` here is about
// whether it got IN — never about whether it was asked to.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createQueue } = require('../queue');
const { createWorker } = require('../worker');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');
const { makeFakeDriver } = require('../../runner/__tests__/fakeDriver');

const START = 'https://customer.example.com/';
const LOGIN_URL = 'https://customer.example.com/login';
const ACCOUNT_URL = 'https://customer.example.com/account';
const ORDERS_URL = 'https://customer.example.com/orders';

const LOGIN_PAGE = {
  url: LOGIN_URL, title: 'Log ind', status: 200, links: [],
  buttons: [{ text: 'Log ind', role: 'button', accessibleName: 'Log ind' }],
  inputs: [
    { label: 'Brugernavn', name: 'username', autocomplete: 'username' },
    { label: 'Adgangskode', name: 'password', type: 'password' },
  ],
  forms: [{ action: '/login', method: 'post' }],
};

// A site that behaves like a real one: what it serves depends on whether THIS
// browser is signed in. Signed out it offers a front page and a login form;
// signed in it offers the account pages and sends anyone asking for /login back
// to their account, the way an authenticated site does.
//
// The session lives on the BROWSER, not on the site. That is deliberate: it is
// what makes this fixture able to catch a sign-in performed in a separate
// browser context, where the cookies would be left behind and the crawl would
// map the public site while the record said "authenticated". Pressing the
// sign-in button is the only thing that flips it, so a spec reaches the private
// pages only by driving the real steps through the real driver.
function makeSite({ lostAfter = null, failSignInWith = null } = {}) {
  const anonymous = {
    [START]: {
      url: START, title: 'Forside', status: 200,
      links: [{ text: 'Log ind', href: '/login' }, { text: 'Konto', href: '/account' }],
      buttons: [], inputs: [], forms: [],
    },
    [LOGIN_URL]: LOGIN_PAGE,
    // A logged-out visitor asking for a private page gets the login form.
    [ACCOUNT_URL]: { ...LOGIN_PAGE, url: ACCOUNT_URL },
  };
  const authenticated = {
    [START]: {
      url: START, title: 'Forside', status: 200,
      links: [{ text: 'Konto', href: '/account' }],
      buttons: [], inputs: [], forms: [],
    },
    [ACCOUNT_URL]: {
      url: ACCOUNT_URL, title: 'Min konto', status: 200,
      links: [{ text: 'Ordrer', href: '/orders' }], buttons: [], inputs: [], forms: [],
    },
    [ORDERS_URL]: {
      url: ORDERS_URL, title: 'Ordrer', status: 200, links: [],
      buttons: [{ text: 'Ny ordre', role: 'button', accessibleName: 'Ny ordre' }], inputs: [], forms: [],
    },
    // An authenticated visitor is sent away from the sign-in page.
    [LOGIN_URL]: { url: LOGIN_URL, title: 'Min konto', status: 200, links: [], buttons: [], inputs: [], forms: [] },
  };

  const site = { browsers: [], visited: [] };

  site.open = function open() {
    const session = { signedIn: false };
    const driver = makeFakeDriver({
      url: START,
      failOn: {
        click: () => {
          if (failSignInWith) throw failSignInWith;
          session.signedIn = true;
        },
      },
    });
    const crawler = {
      async visit(url) {
        site.visited.push(url);
        // The session expires mid-crawl: the site answers with the login form
        // again, whatever was asked for.
        if (session.signedIn && lostAfter !== null && site.visited.length > lostAfter) {
          return { ...LOGIN_PAGE, url };
        }
        const map = session.signedIn ? authenticated : anonymous;
        return map[url] || { url, status: 404, links: [], buttons: [], inputs: [], forms: [] };
      },
    };
    const browser = { session, driver, crawler, close: async () => {} };
    site.browsers.push(browser);
    return browser;
  };

  return site;
}

function makeFixture({ site } = {}) {
  const st = makeServiceTests();
  const queue = createQueue({
    runsRepo: st.repositories.runs,
    discoveryRepo: st.repositories.discovery,
    schedulesRepo: st.repositories.schedules,
    settings: st.settings,
  });
  const worker = createWorker({
    workerId: 'test-worker',
    queue,
    repositories: st.repositories,
    settings: st.settings,
    browserFactory: async () => site.open(),
    resolve: async () => ['93.184.216.34'],
    logger: { info() {}, warn() {}, error() {} },
  });
  // The driver the discovery will be handed. Reading it through the site keeps
  // the assertions honest about WHICH browser signed in.
  const driver = () => (site.browsers[0] ? site.browsers[0].driver : { calls: [] });
  return { st, worker, driver };
}

// A completed anonymous discovery that found the login form — the state a real
// first pass leaves behind, and the thing that makes the credential route work.
async function seedDetectedLogin(st, overrides = {}) {
  const row = await st.repositories.discovery.enqueue({ application_id: 1, scope_url: START, budgets: {} });
  await st.repositories.discovery.finish(row.id, {
    status: 'complete',
    page_count: 2,
    login_count: 1,
    detected_login: {
      possible: true,
      confidence: 'high',
      url: LOGIN_URL,
      usernameField: { label: 'Brugernavn', name: 'username' },
      passwordField: { label: 'Adgangskode', name: 'password' },
      submitLabel: 'Log ind',
      ...overrides,
    },
  });
  return row;
}

// A login test of the kind `canSignInWith` accepts.
async function seedLoginTest(st) {
  return st.repositories.tests.save(1, {
    definition: {
      version: 1,
      name: 'Customer Login',
      steps: [
        { type: 'open', url: '/login' },
        { type: 'fill', target: { label: 'Brugernavn' }, value: '{{credential.username}}' },
        { type: 'fill', target: { label: 'Adgangskode' }, value: '{{credential.password}}' },
        { type: 'click', target: { role: 'button', name: 'Log ind' } },
      ],
    },
    credential_id: 1,
  });
}

// ------------------------------------------------------- the credential route
test('with no login test at all, a stored credential fills in the form the last pass found', async () => {
  const site = makeSite();
  const { st, worker, driver } = makeFixture({ site });
  await seedDetectedLogin(st);

  const job = await st.repositories.discovery.enqueue({
    application_id: 1, scope_url: START, budgets: {}, credential_id: 1,
  });
  await worker.tick();

  const finished = await st.repositories.discovery.findById(job.id);
  assert.equal(finished.status, 'complete');
  assert.equal(finished.authenticated, true, 'the sign-in went through');
  assert.equal(finished.credential_id, 1);

  // The steps were built from the DETECTED form, not from a test.
  assert.deepEqual(driver().calls.filter((c) => c.method === 'open').map((c) => c.args[0]), [LOGIN_URL]);
  const fills = driver().calls.filter((c) => c.method === 'fill');
  assert.deepEqual(fills.map((c) => c.args[0]), ['Brugernavn', 'Adgangskode']);
  assert.equal(fills[1].args[1], 'hunter2-correct-horse', 'the driver receives the real secret');

  // And the crawl inherited that session: the private pages were reached.
  assert.ok(site.visited.includes(ACCOUNT_URL), 'the crawl went behind the login');
  assert.equal(finished.authenticated_page_count, finished.page_count,
    'every page of a signed-in crawl was seen signed in');
});

test('the credential never reaches the discovery record', async () => {
  const site = makeSite();
  const { st, worker } = makeFixture({ site });
  await seedDetectedLogin(st);
  const job = await st.repositories.discovery.enqueue({
    application_id: 1, scope_url: START, budgets: {}, credential_id: 1,
  });
  await worker.tick();

  const finished = await st.repositories.discovery.findById(job.id);
  const pages = await st.repositories.discovery.pages(job.id);
  const elements = await st.repositories.discovery.elements(job.id);
  const everything = JSON.stringify({ finished, pages, elements });
  assert.ok(!everything.includes('hunter2-correct-horse'), 'no secret anywhere in what was stored');
  assert.ok(!everything.includes('svc-test'), 'and no username either');
});

test('a credential with no login form on record leaves the crawl anonymous and says so', async () => {
  // The API refuses this combination up front, so reaching the worker means the
  // form was found once and is gone now — a site that moved its login. The crawl
  // still runs; it just must not claim to be authenticated.
  const site = makeSite();
  const { st, worker } = makeFixture({ site });
  const job = await st.repositories.discovery.enqueue({
    application_id: 1, scope_url: START, budgets: {}, credential_id: 1,
  });
  await worker.tick();

  const finished = await st.repositories.discovery.findById(job.id);
  assert.equal(finished.status, 'complete', 'a public-site map is still worth having');
  assert.equal(finished.authenticated, false);
  assert.match(finished.auth_note, /Could not sign in/);
  assert.match(finished.auth_note, /no login form has been found/);
});

test('a detection too weak to act on is not guessed at', async () => {
  // Typing a username into somebody's search box and pressing enter is the
  // failure mode. No password field means no login form, whatever else was seen.
  const site = makeSite();
  const { st, worker, driver } = makeFixture({ site });
  await seedDetectedLogin(st, { passwordField: null, confidence: 'low' });
  const job = await st.repositories.discovery.enqueue({
    application_id: 1, scope_url: START, budgets: {}, credential_id: 1,
  });
  await worker.tick();

  const finished = await st.repositories.discovery.findById(job.id);
  assert.equal(finished.authenticated, false);
  assert.deepEqual(driver().calls.filter((c) => c.method === 'fill'), [], 'nothing was typed anywhere');
});

// -------------------------------------------------------- the login-test route
test('an existing login test is replayed, and its own credential is the one used', async () => {
  const site = makeSite();
  const { st, worker, driver } = makeFixture({ site });
  await seedLoginTest(st);

  const job = await st.repositories.discovery.enqueue({
    application_id: 1, scope_url: START, budgets: {}, login_test_id: 1,
  });
  await worker.tick();

  const finished = await st.repositories.discovery.findById(job.id);
  assert.equal(finished.authenticated, true);
  assert.equal(finished.login_test_id, 1);
  const fills = driver().calls.filter((c) => c.method === 'fill');
  assert.equal(fills[1].args[1], 'hunter2-correct-horse', 'the credential came off the test, not the job');
  assert.ok(site.visited.includes(ACCOUNT_URL));
});

test('a login test that does more than sign in is refused rather than replayed', async () => {
  // Discovery READS. Replaying a test that posts would leave data behind on the
  // customer's system every time somebody re-ran a discovery.
  const site = makeSite();
  const { st, worker, driver } = makeFixture({ site });
  await st.repositories.tests.save(1, {
    definition: {
      version: 1,
      name: 'Create a case',
      steps: [
        { type: 'fill', target: { label: 'Adgangskode' }, value: '{{credential.password}}' },
        { type: 'api_request', method: 'POST', url: '/api/cases' },
      ],
    },
    credential_id: 1,
  });
  const job = await st.repositories.discovery.enqueue({
    application_id: 1, scope_url: START, budgets: {}, login_test_id: 1,
  });
  await worker.tick();

  const finished = await st.repositories.discovery.findById(job.id);
  assert.equal(finished.status, 'complete');
  assert.equal(finished.authenticated, false);
  assert.match(finished.auth_note, /does more than sign in/);
  assert.deepEqual(driver().calls.filter((c) => c.method === 'apiRequest'), [], 'the write never happened');
});

test('a login test belonging to another application is refused', async () => {
  const site = makeSite();
  const { st, worker } = makeFixture({ site });
  await seedLoginTest(st);
  const job = await st.repositories.discovery.enqueue({
    application_id: 2, scope_url: START, budgets: {}, login_test_id: 1,
  });
  await worker.tick();
  const finished = await st.repositories.discovery.findById(job.id);
  assert.equal(finished.authenticated, false);
  assert.match(finished.auth_note, /different application/);
});

test('a sign-in that does not complete is recorded as a failure, not as a private map', async () => {
  // The whole point. A sign-in that silently did nothing, reported as success,
  // produces a public-site map that everything downstream trusts as private.
  const site = makeSite({ failSignInWith: new Error('Timeout 30000ms exceeded') });
  const { st, worker } = makeFixture({ site });
  await seedDetectedLogin(st);
  const job = await st.repositories.discovery.enqueue({
    application_id: 1, scope_url: START, budgets: {}, credential_id: 1,
  });
  await worker.tick();

  const finished = await st.repositories.discovery.findById(job.id);
  assert.equal(finished.status, 'complete');
  assert.equal(finished.authenticated, false);
  assert.equal(finished.authenticated_page_count, 0);
  assert.match(finished.auth_note, /Could not sign in, so this is the public site only/);
});

test('a sign-in that throws outright still leaves a usable anonymous discovery', async () => {
  const site = makeSite();
  const { st, worker } = makeFixture({ site });
  await seedDetectedLogin(st);
  st.repositories.credentials.findByIdWithSecret = async () => { throw new Error('the vault is unreachable'); };
  const job = await st.repositories.discovery.enqueue({
    application_id: 1, scope_url: START, budgets: {}, credential_id: 1,
  });
  await worker.tick();

  const finished = await st.repositories.discovery.findById(job.id);
  assert.equal(finished.status, 'complete');
  assert.equal(finished.authenticated, false);
  assert.match(finished.auth_note, /vault is unreachable/);
  assert.ok(finished.page_count > 0, 'the crawl still ran');
});

// ------------------------------------------------------------- session loss
test('a crawl that is logged out halfway stops and reports how far it got signed in', async () => {
  const site = makeSite({ lostAfter: 2 });
  const { st, worker } = makeFixture({ site });
  await seedDetectedLogin(st);
  const job = await st.repositories.discovery.enqueue({
    application_id: 1, scope_url: START, budgets: {}, credential_id: 1,
  });
  await worker.tick();

  const finished = await st.repositories.discovery.findById(job.id);
  assert.equal(finished.authenticated, true, 'it did get in');
  assert.equal(finished.session_lost_at_page, 2, 'and the page it lost the session on is named');
  assert.ok(finished.authenticated_page_count < finished.page_count,
    'the pages after the session went are not claimed as private');
  assert.match(finished.auth_note, /session was lost/);
});

// --------------------------------------------------------------- no request
test('a discovery that never asked to sign in is unchanged and carries no note', async () => {
  const site = makeSite();
  const { st, worker, driver } = makeFixture({ site });
  await seedDetectedLogin(st);
  const job = await st.repositories.discovery.enqueue({ application_id: 1, scope_url: START, budgets: {} });
  await worker.tick();

  const finished = await st.repositories.discovery.findById(job.id);
  assert.equal(finished.authenticated, false);
  assert.equal(finished.auth_note, null, 'silence, not a "could not sign in" on a job that never asked');
  assert.equal(finished.authenticated_page_count, 0);
  assert.deepEqual(driver().calls, [], 'the sign-in driver was never touched');
});
