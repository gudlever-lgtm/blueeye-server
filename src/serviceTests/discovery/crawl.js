'use strict';

const { extractPage, extractElements } = require('./extract');
const { isFollowable } = require('./safety');

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
    summary: {
      page_count: pages.length,
      form_count: elements.filter((e) => e.kind === 'form').length,
      element_count: elements.length,
      request_count: requestCount,
      login_count: logins.length,
    },
  };
}

module.exports = { crawl, canonical, sameHost, STOP };
