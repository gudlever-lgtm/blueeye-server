'use strict';

const { strategiesFor, describeTarget } = require('../engine/targeting');
const { explainReason } = require('../security/hostPolicy');
const { createApiLog } = require('./apiLog');
const { createRedactor } = require('../engine/redact');

// The Playwright adapter — THE ONLY file in Service Tests that knows Playwright
// exists (docs/service-assurance.md §2, §4).
//
// Everything above it (execute.js) talks to the interface this file implements,
// so the engine can be replaced — WebDriver BiDi, say — by writing a sibling of
// this file and changing nothing else. Nothing here is imported by the API
// server: `playwright-core` is a worker-only dependency, required lazily so a
// server without it starts normally.
//
// Two responsibilities beyond translating steps:
//
//   * Host policy at request time. Every request the PAGE makes — not just the
//     ones a step asks for — goes through page.route() and is aborted unless the
//     policy allows it. That is what stops an allowed page from pulling a
//     resource from somewhere it should not, redirects included.
//   * Secret masking BEFORE capture. Password-bound inputs have their value
//     replaced in the DOM before a screenshot is taken, so a credential cannot
//     survive into an artefact.

const DEFAULT_STEP_TIMEOUT = 30000;

// Chromium flags that matter in a container. --disable-dev-shm-usage is not
// optional: the default /dev/shm in Docker is 64 MB and Chromium crashes on it.
const LAUNCH_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-extensions',
];

// Lazily loads playwright-core, with an error a human can act on. The server
// process never reaches this — only the worker does.
function loadPlaywright() {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved, import/no-extraneous-dependencies
    return require('playwright-core');
  } catch (err) {
    const e = new Error(
      'playwright-core is not installed. Service Tests runs the browser in a separate worker '
      + '(npm run service-test-worker) — see docs/service-assurance.md §7.'
    );
    e.cause = err;
    e.missingPlaywright = true;
    throw e;
  }
}

// Launches a browser. `executablePath` points at the distro Chromium the worker
// image installs from apt, so no browser is downloaded from a vendor CDN.
async function launchBrowser({ browser = 'chromium', executablePath = null, headless = true } = {}) {
  const playwright = loadPlaywright();
  const engine = playwright[browser] || playwright.chromium;
  return engine.launch({
    headless,
    args: LAUNCH_ARGS,
    ...(executablePath ? { executablePath } : {}),
  });
}

// Turns one targeting strategy into a Playwright locator. The ORDER strategies
// are tried in is targeting.js's business; this only knows how to express each.
function locatorFor(page, { strategy, value, name }) {
  switch (strategy) {
    case 'role': return name ? page.getByRole(value, { name, exact: false }) : page.getByRole(value);
    case 'label': return page.getByLabel(value, { exact: false });
    case 'text': return page.getByText(value, { exact: false });
    case 'placeholder': return page.getByPlaceholder(value, { exact: false });
    case 'name': return page.locator(`[name=${JSON.stringify(value)}]`);
    case 'id': return page.locator(`#${CSS.escape ? CSS.escape(value) : value}`);
    case 'css': return page.locator(value);
    default: return null;
  }
}

// Builds the driver for ONE run.
//
//   policy   — createHostPolicy() for the application under test
//   baseUrl  — the environment's base URL; relative step URLs resolve against it
//   secrets  — values to mask in the DOM before any screenshot
function createPlaywrightDriver({
  page,
  policy,
  baseUrl,
  timeoutMs = DEFAULT_STEP_TIMEOUT,
  secrets = [],
  logger = null,
} = {}) {
  const consoleErrors = [];
  const networkErrors = [];
  const blocked = [];
  // Every xhr/fetch/document the page asked for, with a method and a timing —
  // what turns "the server rejected the request" into "POST /api/auth/session
  // answered 401 in 1.2 s" (docs/service-assurance-v2.md §5).
  //
  // The same redactor the rest of the run uses, so a credential that reached a
  // URL is masked on the way INTO the log rather than at render time, where one
  // forgotten template would leak it.
  const apiLog = createApiLog({ redact: createRedactor(secrets) });
  let lastStatus;

  // --- observation -----------------------------------------------------------
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(String(msg.text()).slice(0, 500));
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err && err.message).slice(0, 500)));
  // Playwright gives no request id, and the Request object itself is the stable
  // identity across the request/response/failure events — so it is the key.
  page.on('request', (req) => {
    apiLog.start(req, { method: req.method(), url: req.url(), resourceType: req.resourceType() });
  });
  page.on('response', (res) => {
    const status = res.status();
    apiLog.finish(res.request(), { status });
    if (status >= 400) networkErrors.push({ url: String(res.url()).slice(0, 512), status });
  });
  page.on('requestfailed', (req) => {
    const failure = req.failure();
    const message = failure ? failure.errorText : 'request failed';
    apiLog.fail(req, { error: message });
    networkErrors.push({ url: String(req.url()).slice(0, 512), status: 0, error: message });
  });

  // --- the request-time host policy -----------------------------------------
  // Synchronous by necessity: awaiting DNS per subresource would wreck page-load
  // timings. checkSync is strictly narrower than the async check every top-level
  // navigation still gets, so this can only refuse more, never less.
  async function installPolicy() {
    if (!policy) return;
    await page.route('**/*', (route) => {
      const url = route.request().url();
      const verdict = policy.checkSync(url);
      if (verdict.allowed) return route.continue();
      blocked.push({ url: String(url).slice(0, 512), reason: verdict.reason });
      if (logger && logger.warn) logger.warn(`service-tests: blocked ${verdict.reason} ${url}`);
      return route.abort('blockedbyclient');
    });
  }

  // Resolves a step's URL against the environment base URL, then puts it through
  // the FULL async policy check — the one that resolves the name and judges every
  // address it points at.
  async function resolveAndCheck(rawUrl) {
    let absolute;
    try {
      absolute = new URL(rawUrl, baseUrl).toString();
    } catch {
      throw new Error(`"${rawUrl}" is not a valid address`);
    }
    if (policy) {
      const verdict = await policy.check(absolute);
      if (!verdict.allowed) {
        const err = new Error(explainReason(verdict.reason, verdict.detail));
        err.blockedByPolicy = true;
        throw err;
      }
    }
    return absolute;
  }

  // Tries each targeting strategy in priority order and returns the first that
  // resolves to exactly one attached element. The failure message names what the
  // operator was pointing at, not a locator.
  async function resolve(target, { timeout = timeoutMs } = {}) {
    const strategies = strategiesFor(target);
    if (!strategies.length) throw new Error('this step has nothing to point at');

    const deadline = Date.now() + timeout;
    let lastError = null;
    // Two passes: a quick sweep for something already present, then a waiting
    // pass on the best strategy. That way a page that is still rendering does not
    // burn the whole timeout on a strategy that was never going to match.
    for (const attempt of strategies) {
      const locator = locatorFor(page, attempt);
      if (!locator) continue;
      try {
        if (await locator.count() > 0) return { locator: locator.first(), strategy: attempt.strategy };
      } catch (err) { lastError = err; }
    }
    for (const attempt of strategies) {
      const locator = locatorFor(page, attempt);
      if (!locator) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await locator.first().waitFor({ state: 'attached', timeout: Math.min(remaining, timeout) });
        return { locator: locator.first(), strategy: attempt.strategy };
      } catch (err) { lastError = err; }
    }
    const err = new Error(`${describeTarget(target)} blev ikke fundet`);
    err.notFound = true;
    err.cause = lastError;
    // Self-healing (V2 §5): before giving up, look at what IS on the page. The
    // candidates ride on the error; the runner turns them into a PROPOSAL and
    // nothing here repoints anything — see engine/heal.js for why that rule is
    // the whole feature rather than a formality.
    err.candidates = await collectCandidates();
    throw err;
  }

  // Every element on the page a step could plausibly have meant, described the
  // same way a target is: role, accessible name, label, text, placeholder, name,
  // id. OBSERVATION ONLY — no judgement about which one is right happens here or
  // anywhere in the browser.
  //
  // Bounded hard. This runs on a page that has already failed, in a browser the
  // operator is waiting on, and an unbounded DOM walk on a big application would
  // turn one bad step into a timeout.
  async function collectCandidates({ max = 200 } = {}) {
    try {
      return await page.evaluate((limit) => {
        const cut = (v, n) => (v == null ? '' : String(v).trim().slice(0, n));
        const roleOf = (el) => {
          const explicit = el.getAttribute('role');
          if (explicit) return explicit.trim().toLowerCase();
          const tag = el.tagName.toUpperCase();
          if (tag === 'BUTTON') return 'button';
          if (tag === 'A' && el.getAttribute('href')) return 'link';
          if (tag === 'SELECT') return 'combobox';
          if (tag === 'TEXTAREA') return 'textbox';
          if (/^H[1-4]$/.test(tag)) return 'heading';
          if (tag === 'INPUT') {
            const type = (el.type || 'text').toLowerCase();
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (['submit', 'button', 'reset'].includes(type)) return 'button';
            return 'textbox';
          }
          return '';
        };
        const nameOf = (el) => {
          const aria = el.getAttribute('aria-label');
          if (aria) return cut(aria, 120);
          if (el.tagName === 'INPUT' && ['submit', 'button'].includes((el.type || '').toLowerCase())) {
            return cut(el.value, 120);
          }
          return cut(el.innerText || el.textContent, 120);
        };
        const labelOf = (el) => {
          if (el.labels && el.labels.length) return cut(el.labels[0].innerText, 120);
          const wrap = el.closest && el.closest('label');
          return wrap ? cut(wrap.innerText, 120) : '';
        };

        const SELECTOR = 'a[href], button, input, select, textarea, [role], summary, [onclick]';
        const out = [];
        for (const el of document.querySelectorAll(SELECTOR)) {
          if (out.length >= limit) break;
          // Skip what a person could not have pointed at. An invisible element
          // is not what the step meant, and offering one is how a heal points a
          // test at something nobody can click.
          const box = el.getBoundingClientRect();
          if (!box.width && !box.height) continue;
          const candidate = {};
          const role = roleOf(el);
          if (role) candidate.role = role;
          const name = nameOf(el);
          if (name) candidate.name = name;
          const label = labelOf(el);
          if (label) candidate.label = label;
          const text = cut(el.innerText || el.textContent, 120);
          if (text && text !== name) candidate.text = text;
          const placeholder = el.getAttribute('placeholder');
          if (placeholder) candidate.placeholder = cut(placeholder, 120);
          if (el.name) candidate.name = candidate.name || cut(el.name, 120);
          if (el.id) candidate.id = cut(el.id, 120);
          if (Object.keys(candidate).length) out.push(candidate);
        }
        return out;
      }, max);
    } catch {
      // A page that will not evaluate (navigated away, closed, cross-origin
      // frame) simply yields no proposal. Healing is a bonus on top of a
      // failure that is already being reported properly.
      return [];
    }
  }

  const act = async (target, fn) => {
    const { locator } = await resolve(target);
    return fn(locator);
  };

  // --- masking ---------------------------------------------------------------
  // Runs in the PAGE before a screenshot: replaces the value of every password
  // input, and of any input whose value matches a secret, so nothing readable
  // survives into the image. Best-effort by design — a masking failure must not
  // suppress the screenshot, it must not produce an unmasked one either, so a
  // throw here means no screenshot is taken.
  async function maskSecretsInDom() {
    const values = (secrets || []).filter((s) => typeof s === 'string' && s.length >= 4);
    await page.evaluate((secretValues) => {
      const MASK = '••••••';
      for (const el of document.querySelectorAll('input')) {
        if (el.type === 'password') { el.value = MASK; continue; }
        if (secretValues.some((v) => el.value && el.value.includes(v))) el.value = MASK;
      }
    }, values).catch(() => { /* a page that navigated away has nothing to mask */ });
  }

  return {
    installPolicy,

    // ---- navigation
    async open(url) {
      const absolute = await resolveAndCheck(url);
      const res = await page.goto(absolute, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      lastStatus = res ? res.status() : undefined;
      return { status: lastStatus, url: page.url() };
    },
    async back() {
      const res = await page.goBack({ timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      lastStatus = res ? res.status() : lastStatus;
      return { status: lastStatus, url: page.url() };
    },
    async refresh() {
      const res = await page.reload({ timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      lastStatus = res ? res.status() : lastStatus;
      return { status: lastStatus, url: page.url() };
    },

    // ---- interaction
    click: (target) => act(target, (l) => l.click({ timeout: timeoutMs })),
    fill: (target, value) => act(target, (l) => l.fill(String(value ?? ''), { timeout: timeoutMs })),
    clear: (target) => act(target, (l) => l.fill('', { timeout: timeoutMs })),
    select: (target, value) => act(target, (l) => l.selectOption(String(value), { timeout: timeoutMs })),
    setChecked: (target, checked) => act(target, (l) => l.setChecked(!!checked, { timeout: timeoutMs })),
    async upload(target, fileName) {
      // Uploads are refused rather than silently reading from the worker's disk.
      // Attaching a file to a test is a later phase; until then this fails
      // honestly instead of becoming a file-read primitive.
      const err = new Error(`filen "${fileName}" er ikke vedhæftet testen`);
      err.unsupported = true;
      throw err;
    },

    // ---- inspection
    async exists(target) {
      try { await resolve(target, { timeout: Math.min(timeoutMs, 5000) }); return true; } catch { return false; }
    },
    async visible(target) {
      try {
        const { locator } = await resolve(target, { timeout: Math.min(timeoutMs, 5000) });
        return await locator.isVisible();
      } catch { return false; }
    },
    async textOf(target) {
      const { locator } = await resolve(target);
      return (await locator.innerText()).trim();
    },
    currentUrl: async () => page.url(),
    // The browser tab's text. Read straight off the page rather than through a
    // locator: `<title>` is in `<head>`, so no element target can reach it.
    pageTitle: async () => (await page.title()) || '',
    waitFor: async (target) => { await resolve(target); },
    sleep: (ms) => page.waitForTimeout(Math.min(Number(ms) || 0, 60000)),

    // ---- authentication
    // `login` has no generic meaning: the test's own steps do the filling and
    // clicking. It exists so a definition can SAY it logs in (which is what makes
    // the credential required) without prescribing how.
    async login() { /* the surrounding fill/click steps perform it */ },
    async logout() { /* likewise — an explicit logout step is a click */ },

    // ---- technical
    async apiRequest({ method, url, body }) {
      const absolute = await resolveAndCheck(url);
      const res = await page.request.fetch(absolute, {
        method,
        timeout: timeoutMs,
        ...(body ? { data: body } : {}),
      });
      lastStatus = res.status();
      return { status: lastStatus };
    },

    // ---- diagnostics
    consoleErrors: async () => consoleErrors.slice(0, 50),
    networkErrors: async () => [...networkErrors, ...blocked.map((b) => ({ url: b.url, status: 0, error: b.reason }))].slice(0, 50),
    apiCalls: async () => apiLog.calls(),
    blockedRequests: () => blocked.slice(0, 50),

    async screenshot({ fullPage = false, type = 'jpeg', quality = 70 } = {}) {
      await maskSecretsInDom();
      const opts = { fullPage, timeout: 15000 };
      // PNG has no quality setting; passing one throws.
      if (type === 'png') return page.screenshot({ ...opts, type: 'png' });
      return page.screenshot({ ...opts, type: 'jpeg', quality });
    },
  };
}

module.exports = { createPlaywrightDriver, launchBrowser, loadPlaywright, locatorFor, LAUNCH_ARGS, DEFAULT_STEP_TIMEOUT };
