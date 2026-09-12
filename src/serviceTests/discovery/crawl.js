'use strict';

const { extractPage, extractElements } = require('./extract');
const { isFollowable } = require('./safety');
const { sessionLost } = require('./authenticate');

// The crawler. Drives an injected browser port, so this file — the orchestration,
// the budgets, the scope rule — is testable without Playwright.
//
// The browser port:
//   visit(url) → snapshot (see extract.js) — navigates and reads the page
//   close()
//
// Three guarantees, in the order they matter:
//   1. SCOPE. Only the application's own host is crawled. An external link is
//      recorded and never followed (spec §9).
//   2. SAFETY. Only elements safety.js calls followable are followed; nothing is
//      clicked, no form is submitted (spec §8).
//   3. BUDGETS. Pages, depth, requests and wall-clock are all bounded, and the
//      reason a crawl stopped is recorded rather than inferred.

const STOP = {
  COMPLETE: 'complete',
  MAX_PAGES: 'max_pages',
  MAX_DEPTH: 'max_depth',
  MAX_REQUESTS: 'max_requests',
  TIMEOUT: 'max_duration',
  // The crawl was signed in and got logged out. Its own stop reason, because
  // "the crawl ended" and "the crawl ended because it stopped being trusted"
  // are different facts and only one of them makes the result partial.
  SESSION_LOST: 'session_lost',
};

// Normalises a URL for the visited set: drops the fragment (same page) and the
// trailing slash, keeps the query (a different query is a different page).
function canonical(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch { return null; }
}

function sameHost(a, b) {
  try { return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase(); } catch { return false; }
}

// Runs one crawl. Returns the pages, elements, suggestions input and the stop
// reason — it writes nothing itself, so the caller decides what to persist.
async function crawl({
  browser,
  startUrl,
  policy = null,
  budgets = {},
  now = () => Date.now(),
  onPage = null,
  logger = null,
  // Set when the crawler was signed in before this crawl. Turns on the
  // session-loss check: a crawl that gets logged out halfway would otherwise map
  // the PUBLIC site and report it as the authenticated application, which is
  // worse than not having the feature because the map would be trusted.
  signedIn = false,
  loginUrl = null,
} = {}) {
  const maxPages = budgets.maxPages ?? 100;
  const maxDepth = budgets.maxDepth ?? 5;
  const maxRequests = budgets.maxRequests ?? 500;
  const maxDurationMs = budgets.maxDurationMs ?? 300000;

  const startedAt = now();
  const start = canonical(startUrl);
  if (!start) return { pages: [], elements: [], externalLinks: [], stopped: STOP.COMPLETE, error: 'the start address is not valid' };

  const queue = [{ url: start, depth: 0 }];
  const seen = new Set([start]);
  const pages = [];
  const elements = [];
  const externalLinks = new Set();
  const logins = [];
  let requestCount = 0;
  let stopped = STOP.COMPLETE;
  let authenticatedPages = 0;
  let sessionLostAtPage = null;
  let sessionLostReason = null;

  while (queue.length) {
    if (pages.length >= maxPages) { stopped = STOP.MAX_PAGES; break; }
    if (now() - startedAt >= maxDurationMs) { stopped = STOP.TIMEOUT; break; }
    if (requestCount >= maxRequests) { stopped = STOP.MAX_REQUESTS; break; }

    const { url, depth } = queue.shift();

    // The host policy is consulted for every navigation, not only the first:
    // a redirect chain can land somewhere the allowlist does not cover.
    if (policy) {
      // eslint-disable-next-line no-await-in-loop
      const verdict = await policy.check(url);
      if (!verdict.allowed) {
        if (logger && logger.warn) logger.warn(`service-tests discovery: skipped ${url} (${verdict.reason})`);
        continue;
      }
    }

    let snapshot;
    try {
      // eslint-disable-next-line no-await-in-loop
      snapshot = await browser.visit(url);
    } catch (err) {
      pages.push({ ...extractPage({ url }, depth), http_status: null, console_errors: [String(err && err.message).slice(0, 500)] });
      continue;
    }

    requestCount += 1 + ((snapshot.requests || []).length);
    const page = extractPage(snapshot, depth);
    pages.push(page);

    const { elements: found, login } = extractElements(snapshot);
    for (const el of found) elements.push({ ...el, pageUrl: page.url });
    if (login.possible) logins.push({ url: page.url, ...login });

    // Still signed in? Checked BEFORE the page is counted as authenticated, so
    // the page that proves the session went is not itself claimed as private.
    //
    // The crawl stops rather than carrying on anonymously. Half a private map,
    // labelled as half, is worth having; a public map labelled as private is
    // not — and nothing downstream could tell the difference.
    if (signedIn) {
      const lost = sessionLost(snapshot, { loginUrl });
      if (lost.lost) {
        sessionLostAtPage = pages.length - 1;
        sessionLostReason = lost.reason;
        stopped = STOP.SESSION_LOST;
        break;
      }
      authenticatedPages += 1;
      page.authenticated = true;
    }

    if (typeof onPage === 'function') {
      try { onPage(page, found); } catch { /* a reporter must never stop a crawl */ }
    }

    // Queue the links worth following.
    if (depth < maxDepth) {
      for (const link of snapshot.links || []) {
        const href = link && link.href;
        if (!href) continue;
        let absolute;
        try { absolute = canonical(new URL(href, page.url).toString()); } catch { continue; }
        if (!absolute) continue;

        if (!sameHost(absolute, start)) { externalLinks.add(absolute); continue; }
        if (seen.has(absolute)) continue;
        if (!isFollowable({ kind: 'link', ...link })) continue;

        seen.add(absolute);
        queue.push({ url: absolute, depth: depth + 1 });
      }
    } else if (queue.length === 0) {
      stopped = STOP.MAX_DEPTH;
    }
  }

  // A queue left non-empty because a budget bit means the crawl was truncated —
  // say which one, rather than letting the UI guess from the counts.
  if (queue.length && stopped === STOP.COMPLETE) stopped = STOP.MAX_PAGES;

  return {
    pages,
    elements,
    logins,
    externalLinks: [...externalLinks],
    stopped,
    requestCount,
    durationMs: now() - startedAt,
    // Which page the session went on, and why. Null when it held (or when the
    // crawl was never signed in at all).
    sessionLostAtPage,
    sessionLostReason,
    summary: {
      page_count: pages.length,
      form_count: elements.filter((e) => e.kind === 'form').length,
      element_count: elements.length,
      request_count: requestCount,
      login_count: logins.length,
      // Pages reachable ONLY once signed in — the number that says whether
      // authenticating was worth it.
      authenticated_page_count: authenticatedPages,
      // The best login form found, kept so the NEXT discovery can sign in with
      // nothing but a credential. Highest confidence wins; field descriptions
      // only, never a value.
      detected_login: bestLogin(logins),
    },
  };
}

// The login form most worth keeping: the most confident one. A site with three
// detected forms usually has one real login and two password-change boxes.
function bestLogin(logins) {
  const rank = { low: 0, medium: 1, high: 2 };
  const best = (logins || [])
    .filter((l) => l && l.possible)
    .sort((a, b) => (rank[b.confidence] ?? -1) - (rank[a.confidence] ?? -1))[0];
  if (!best) return null;
  return {
    url: best.url,
    confidence: best.confidence,
    usernameField: best.usernameField || null,
    passwordField: best.passwordField || null,
    submitLabel: best.submitLabel || null,
  };
}

module.exports = { crawl, canonical, sameHost, bestLogin, STOP };
