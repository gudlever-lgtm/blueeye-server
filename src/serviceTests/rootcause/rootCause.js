'use strict';

const { numOrNull } = require('../storage/shape');

// Root cause analysis (V3 Phase 2, docs/service-assurance-v3.md §"Root Cause
// Analysis").
//
// Correlation names a LAYER — "likely an application or API problem". That is
// as far as evidence about layers can take you, and it is not far enough to act
// on: "the API layer" is not something anybody fixes. This ranks the specific
// causes inside and across those layers — DNS, network, firewall, TLS, load
// balancer, web server, authentication, API, application, database, dependency,
// timeout, configuration, browser/client — and says what to look at next.
//
// PURE: a correlation and its observations in, a ranked list out. No database,
// no clock, no network.
//
// Four rules, and the third is the one that makes this honest:
//
//   1. RANKED, never named. A single cause presented as the answer is a guess
//      wearing a conclusion's clothes. The list is ordered, the gap between
//      first and second is published, and when that gap is small the summary
//      says it could be either.
//   2. Nothing is ranked from nothing. No correlation, or no failing
//      observation, means no analysis — not an empty list dressed up as "no
//      problems found".
//   3. WHAT BLUEEYES CAN SEE AND WHAT IT CAN ONLY SUPPOSE ARE DIFFERENT CLAIMS.
//      A synthetic browser test observes DNS, TLS, HTTP status and timing. It
//      never observes a database. "The database is slow" from an HTTP 500 is a
//      hypothesis, and ranking it beside a directly observed TLS failure as
//      though both were seen is the single most misleading thing this module
//      could do. So every candidate carries its BASIS, and a cause that can
//      only ever be supposed has a hard ceiling it cannot pass however many
//      signatures fire.
//   4. Every candidate carries the evidence that put it there. A candidate with
//      no evidence is not listed at all.

// ------------------------------------------------------------- the vocabulary
const CAUSE = {
  DNS: 'dns',
  NETWORK: 'network',
  FIREWALL: 'firewall',
  TLS: 'tls',
  LOAD_BALANCER: 'load_balancer',
  WEB_SERVER: 'web_server',
  AUTHENTICATION: 'authentication',
  API: 'api',
  APPLICATION: 'application',
  DATABASE: 'database',
  DEPENDENCY: 'dependency',
  TIMEOUT: 'timeout',
  CONFIGURATION: 'configuration',
  CLIENT: 'browser_client',
};

// How a cause can be known.
//
//   observed     — BlueEyes saw the thing itself. A TLS handshake that failed is
//                  a TLS failure; there is nothing to deduce.
//   inferred     — deduced from something else. An HTTP 502 says a gateway
//                  answered for an upstream that did not; no load balancer was
//                  ever inspected.
//   unobservable — BlueEyes cannot see this from a browser, ever. It can only be
//                  proposed as a thing to go and look at.
const BASIS = { OBSERVED: 'observed', INFERRED: 'inferred', UNOBSERVABLE: 'unobservable' };

// The ceiling each basis may reach. This is rule 3 expressed as arithmetic:
// however many signatures fire, a supposition never outranks a sighting.
const CEILING = {
  [BASIS.OBSERVED]: 90,
  [BASIS.INFERRED]: 70,
  [BASIS.UNOBSERVABLE]: 40,
};

// A cause is only listed once it has this much behind it. Below it, one weak
// signature would put a whole extra row on the screen for an operator to
// dismiss — and a list nobody trusts is read by nobody.
const LISTING_FLOOR = 20;

// How far ahead the leader has to be before the answer is "it is this" rather
// than "it is one of these". Two causes four points apart are a tie, and
// presenting the first as the conclusion would be an artefact of the arithmetic.
const DECISIVE_GAP = 12;
const DECISIVE_FLOOR = 50;

// Agreement with the correlation's layer. Small on purpose: the correlation and
// this are reading the same observations, so a large bonus would be the same
// evidence counted twice.
const LAYER_AGREEMENT = 8;

// The catalogue. Order here is the tie-break order, so a tie resolves the same
// way every time rather than however the sort happened to land — outward-in,
// the way somebody actually works through an outage.
const CATALOGUE = [
  {
    cause: CAUSE.CONFIGURATION,
    layer: 'assurance',
    basis: BASIS.OBSERVED,
    label: 'BlueEyes’ own configuration',
    next_step: 'Check the application’s allowed hosts and its stored login — this is a setting here, not a fault in the service.',
  },
  {
    cause: CAUSE.DNS,
    layer: 'network',
    basis: BASIS.OBSERVED,
    label: 'DNS or the host name',
    next_step: 'Resolve the host name from another machine. If it resolves there, the resolver this worker uses is the difference.',
  },
  {
    cause: CAUSE.FIREWALL,
    layer: 'network',
    basis: BASIS.INFERRED,
    label: 'A firewall or a closed port',
    next_step: 'Open a connection to the host and port from the worker. The name resolved, so the block is between the connection and the service.',
  },
  {
    cause: CAUSE.NETWORK,
    layer: 'network',
    basis: BASIS.OBSERVED,
    label: 'The network path',
    next_step: 'Look at whether more than one host is affected. Several unrelated hosts failing at once is the path, not the services.',
  },
  {
    cause: CAUSE.TLS,
    layer: 'infrastructure',
    basis: BASIS.OBSERVED,
    label: 'The TLS certificate',
    next_step: 'Read the certificate on the host: its expiry, its names, and who issued it.',
  },
  {
    cause: CAUSE.LOAD_BALANCER,
    layer: 'infrastructure',
    basis: BASIS.INFERRED,
    label: 'A load balancer or reverse proxy',
    next_step: 'A gateway answered for an upstream that did not. Check the proxy’s upstream health and its own logs — the application may be fine.',
  },
  {
    cause: CAUSE.WEB_SERVER,
    layer: 'server',
    basis: BASIS.INFERRED,
    label: 'The web server',
    next_step: 'Check whether the service is running and accepting work — a 503 is usually a server that is up and refusing, not one that is down.',
  },
  {
    cause: CAUSE.AUTHENTICATION,
    layer: 'api',
    basis: BASIS.OBSERVED,
    label: 'Authentication',
    next_step: 'Check the stored login and whether the account is still valid. A password that expired looks exactly like this.',
  },
  {
    cause: CAUSE.API,
    layer: 'api',
    basis: BASIS.OBSERVED,
    label: 'One API endpoint',
    next_step: 'Look at that endpoint alone. Its neighbours answered, so whatever is wrong is narrower than the service.',
  },
  {
    cause: CAUSE.APPLICATION,
    layer: 'application',
    basis: BASIS.OBSERVED,
    label: 'The application',
    next_step: 'Read the application’s own logs around the time of the run — a 500 means it reached the code and the code threw.',
  },
  {
    cause: CAUSE.DEPENDENCY,
    layer: 'api',
    basis: BASIS.OBSERVED,
    label: 'A third-party dependency',
    next_step: 'The failing address is not this application’s. Check that provider’s status before looking at your own service.',
  },
  {
    cause: CAUSE.DATABASE,
    layer: 'application',
    basis: BASIS.UNOBSERVABLE,
    label: 'The database behind the application',
    next_step: 'BlueEyes cannot see a database from a browser — this is a place to look, not a finding. Check connections, locks and slow queries around this time.',
  },
  {
    cause: CAUSE.TIMEOUT,
    layer: 'server',
    basis: BASIS.OBSERVED,
    label: 'Something was too slow to answer',
    next_step: 'A timeout names the symptom, not the cause. Find what was slow — the page, one request, or the backend behind it.',
  },
  {
    cause: CAUSE.CLIENT,
    layer: 'browser',
    basis: BASIS.OBSERVED,
    label: 'The page, or the test itself',
    next_step: 'Nothing underneath reported a problem. Open the page and check whether it changed shape — this is often a test that needs updating rather than a service that broke.',
  },
];

const BY_CAUSE = new Map(CATALOGUE.map((c) => [c.cause, c]));
const ORDER = new Map(CATALOGUE.map((c, i) => [c.cause, i]));

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const text = (v) => (v === null || v === undefined ? '' : String(v));

// ------------------------------------------------------------------ context
//
// Everything the signatures ask about, derived once. Built defensively: this
// runs on a dashboard someone opens DURING an outage, and one malformed row in
// the observation list must not be the thing that blanks the page explaining
// the outage.
function contextFrom(correlation, observations, input) {
  const list = (Array.isArray(observations) ? observations : []).filter((o) => o && typeof o === 'object');
  const bad = list.filter((o) => o.outcome === 'bad');

  // Every HTTP status the run saw, and which of them failed. `detail.status`
  // is where the observation model puts it; a status is a number or it is not
  // there at all — numOrNull, because Number(null) and Number('') are both 0
  // and a status of 0 already means something else entirely.
  const statuses = [];
  for (const o of list) {
    const status = numOrNull(o.detail && o.detail.status);
    if (status !== null) statuses.push({ status, outcome: o.outcome, subject: o.subject, summary: o.summary });
  }
  const failedStatuses = statuses.filter((s) => s.outcome === 'bad');
  const hasStatus = (pred) => failedStatuses.find((s) => pred(s.status)) || null;

  const apiOk = list.filter((o) => o.layer === 'api' && o.outcome === 'ok');
  const apiBad = list.filter((o) => o.layer === 'api' && o.outcome === 'bad');
  const networkBad = list.filter((o) => o.layer === 'network' && o.outcome === 'bad');
  const pageBad = list.filter((o) => o.layer === 'page' && o.outcome === 'bad');

  // The run's own classification, which V1 already worked out from the error
  // string. Read rather than re-derived: two modules disagreeing about what a
  // timeout looks like is worse than either being wrong.
  const outcome = list.find((o) => o.kind === 'run.outcome');
  const failureKind = text((outcome && outcome.detail && outcome.detail.failure_kind) || input.failureKind) || null;

  // Which hosts failed, so a third-party dependency can be told apart from the
  // application itself. Without a base host nothing is claimed either way —
  // guessing that an unfamiliar host is third-party is how a service gets
  // blamed on its CDN.
  const baseHost = hostOf(input.baseUrl);
  const failedHosts = [];
  for (const o of bad) {
    const host = hostOf(o.subject);
    if (host && !failedHosts.includes(host)) failedHosts.push(host);
  }
  const foreignHosts = baseHost ? failedHosts.filter((h) => !sameSite(h, baseHost)) : [];
  const ownHostFailed = baseHost ? failedHosts.some((h) => sameSite(h, baseHost)) : false;

  const errorText = bad.map((o) => text(o.summary)).join(' \n ').toLowerCase();

  return {
    list,
    bad,
    statuses,
    failedStatuses,
    hasStatus,
    apiOk,
    apiBad,
    networkBad,
    pageBad,
    failureKind,
    errorText,
    baseHost,
    failedHosts,
    foreignHosts,
    ownHostFailed,
    correlationLayer: (correlation && correlation.layer) || null,
    notChecked: (correlation && Array.isArray(correlation.not_checked)) ? correlation.not_checked : [],
    // A technical layer failed underneath the browser. Several signatures turn
    // on this: a selector that did not resolve while the API was returning 500
    // is a symptom, not the fault.
    somethingUnderneathFailed: (correlation && Array.isArray(correlation.failed))
      ? correlation.failed.some((l) => l !== 'browser')
      : bad.some((o) => o.layer && o.layer !== 'browser' && o.layer !== 'assurance'),
    certificate: (input.certificate && typeof input.certificate === 'object') ? input.certificate : null,
  };
}

function hostOf(value) {
  const raw = text(value).trim();
  if (!raw) return null;
  try { return new URL(raw).hostname.toLowerCase(); } catch { /* not a URL */ }
  // A bare host, as a network error often carries.
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw) ? raw.toLowerCase() : null;
}

// Same site, not same string. `api.kunde.dk` and `www.kunde.dk` belong to one
// service; treating a subdomain as a third party would blame the customer's own
// API on somebody else.
function sameSite(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const tail = (h) => h.split('.').slice(-2).join('.');
  return tail(a) === tail(b);
}

// --------------------------------------------------------------- signatures
//
// Each returns the points it is worth and the sentence that justifies them.
// Points are arguable — that is the point of publishing them. A weighting
// nobody can question is worth no more than no weighting at all.
//
// Read the rules as: what would have to be true for this cause, and what did we
// actually see?
function signatures(c) {
  const out = [];
  const add = (cause, points, why) => { if (points > 0 && why) out.push({ cause, points, why }); };
  const saw = (re) => re.test(c.errorText);

  // --- BlueEyes' own configuration ------------------------------------------
  // Separated from "a firewall" deliberately, and ranked first in the
  // catalogue. `network.blocked` means THIS server refused the address because
  // it is not on the allowlist. Reporting that as a customer firewall sends
  // somebody to the wrong building.
  if (c.list.some((o) => o.kind === 'network.blocked')) {
    add(CAUSE.CONFIGURATION, 60, 'BlueEyes refused the address itself — it is not on this application\u2019s allowed hosts');
  }
  if (c.failureKind === 'blocked_by_policy') {
    add(CAUSE.CONFIGURATION, 55, 'the run was stopped by the host allowlist, not by anything at the other end');
  }
  if (c.failureKind === 'credential_unavailable') {
    add(CAUSE.CONFIGURATION, 55, 'the stored login could not be read, so the test never got as far as the service');
  }
  if (c.failureKind === 'http_404' || c.hasStatus((s) => s === 404)) {
    add(CAUSE.CONFIGURATION, 30, 'a 404 — the address the test opens may simply have moved');
  }

  // --- DNS -------------------------------------------------------------------
  if (c.failureKind === 'dns_failure') add(CAUSE.DNS, 50, 'the run was classified as a name-lookup failure');
  if (c.list.some((o) => o.kind === 'network.dns' && o.outcome === 'bad')) {
    add(CAUSE.DNS, 45, 'a name lookup was observed to fail');
  }
  if (saw(/enotfound|getaddrinfo|name not resolved|dns/)) {
    add(CAUSE.DNS, 40, 'the error names the lookup rather than the connection');
  }

  // --- TLS -------------------------------------------------------------------
  if (c.failureKind === 'tls_failure') add(CAUSE.TLS, 50, 'the run was classified as a TLS failure');
  if (c.list.some((o) => o.kind === 'infrastructure.tls' && o.outcome === 'bad')) {
    add(CAUSE.TLS, 45, 'the TLS handshake was observed to fail');
  }
  if (saw(/err_cert|certificate|ssl|handshake/)) {
    add(CAUSE.TLS, 40, 'the error names the certificate or the handshake');
  }
  if (c.certificate && ['expired', 'invalid'].includes(text(c.certificate.status))) {
    add(CAUSE.TLS, 35, `the stored certificate check for this host says ${text(c.certificate.status)}`);
  }

  // --- firewall / closed port ------------------------------------------------
  // Inferred, never observed: BlueEyes sees a connection that did not open. It
  // cannot see a firewall, and a service that is simply not running looks
  // identical from here.
  if (c.failureKind === 'connection_refused') {
    add(CAUSE.FIREWALL, 40, 'the address resolved and nothing accepted the connection');
  }
  if (saw(/econnrefused|connection refused|econnreset/)) {
    add(CAUSE.FIREWALL, 35, 'the connection was refused or reset at the socket');
  }
  if (saw(/etimedout|connect etimedout/)) {
    add(CAUSE.FIREWALL, 25, 'the connection attempt timed out without an answer, which is what a dropped packet looks like');
  }

  // --- the network path ------------------------------------------------------
  if (c.failedHosts.length > 1 && c.networkBad.length) {
    add(CAUSE.NETWORK, 40, `${c.failedHosts.length} different hosts failed at once, which is wider than any one service`);
  }
  if (c.list.some((o) => o.kind === 'network.request_failed')) {
    add(CAUSE.NETWORK, 30, 'a request never completed at all — nothing answered to be judged');
  }

  // --- gateway ---------------------------------------------------------------
  if (c.failureKind === 'http_502' || c.hasStatus((s) => s === 502 || s === 504)) {
    add(CAUSE.LOAD_BALANCER, 45, 'a 502 or 504 — something in front answered for an upstream that did not');
  }
  if (c.failureKind === 'http_503' || c.hasStatus((s) => s === 503)) {
    add(CAUSE.WEB_SERVER, 40, 'a 503 — the server answered, and said it would not take the work');
  }

  // --- authentication --------------------------------------------------------
  if (c.hasStatus((s) => s === 401 || s === 403)) {
    add(CAUSE.AUTHENTICATION, 45, 'a 401 or 403 — the service answered, and refused this caller');
  }
  if (c.bad.some((o) => /log ?in|log ?ind|sign ?in|authenticat/i.test(text(o.subject) + ' ' + text(o.summary)))) {
    add(CAUSE.AUTHENTICATION, 25, 'the step that failed is the one that signs in');
  }

  // --- one endpoint, versus the application ---------------------------------
  // The difference that decides where somebody looks. One endpoint failing
  // while its neighbours answer is a much narrower fault than the tier being
  // down, and the two are told apart by what ELSE answered.
  if (c.apiBad.length && c.apiOk.length) {
    add(CAUSE.API, 40, `${c.apiBad.length} call${c.apiBad.length === 1 ? '' : 's'} failed while ${c.apiOk.length} other${c.apiOk.length === 1 ? '' : 's'} answered normally`);
  }
  if (c.hasStatus((s) => s === 500)) {
    add(CAUSE.APPLICATION, 40, 'a 500 — the request reached the application\u2019s own code and it threw');
  }
  if (c.apiBad.length && !c.apiOk.length && c.apiBad.length > 1) {
    add(CAUSE.APPLICATION, 30, 'every API call the run made failed, so the fault is wider than one endpoint');
  }
  if (c.failureKind === 'javascript_error' || c.pageBad.length) {
    add(CAUSE.APPLICATION, 25, 'the page reported script errors of its own');
  }

  // --- a third party ---------------------------------------------------------
  if (c.foreignHosts.length) {
    add(CAUSE.DEPENDENCY, 45, `the failing address (${c.foreignHosts[0]}) is not this application\u2019s own host`);
    if (!c.ownHostFailed) {
      add(CAUSE.DEPENDENCY, 15, 'nothing on the application\u2019s own host failed');
    }
  }

  // --- the database ----------------------------------------------------------
  // Never observed, and never listed on its own. A 500 is the only door to this
  // hypothesis, and even then it is capped and labelled as a place to look.
  if (c.hasStatus((s) => s === 500)) {
    if (saw(/deadlock|too many connections|connection pool|sqlstate|query/)) {
      add(CAUSE.DATABASE, 35, 'the error text names a database condition, though BlueEyes did not see the database');
    } else if (c.failureKind === 'timeout' || saw(/timeout|timed out/)) {
      add(CAUSE.DATABASE, 25, 'a 500 alongside a timeout is often a slow query, but nothing here observed one');
    }
  }

  // --- timeout ---------------------------------------------------------------
  if (c.failureKind === 'timeout') add(CAUSE.TIMEOUT, 45, 'the step was stopped for taking too long');
  if (saw(/timeout \d+ ?ms exceeded|timed out/)) add(CAUSE.TIMEOUT, 30, 'the error says the wait was exceeded');

  // --- the page, or the test -------------------------------------------------
  if (['element_not_found', 'element_not_visible', 'assertion_failed', 'unexpected_redirect'].includes(c.failureKind)) {
    add(CAUSE.CLIENT, 45, 'the step failed on the page itself — an element that was not there, or an assertion that did not hold');
    if (!c.somethingUnderneathFailed) {
      add(CAUSE.CLIENT, 20, 'and nothing underneath the browser reported a problem');
    }
  }

  return out;
}

// ------------------------------------------------------------------ ranking
function analyseRootCause(rawInput = {}) {
  // A default parameter covers `undefined` and nothing else. Null, a string and
  // a number all reach here otherwise.
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  const correlation = (input.correlation && typeof input.correlation === 'object') ? input.correlation : null;

  // Rule 2: nothing is ranked from nothing. Correlation already refuses to
  // conclude without a failure, so no correlation means there was nothing wrong
  // to explain — and an empty ranking on a healthy service reads as a finding.
  if (!correlation) return null;

  const c = contextFrom(correlation, input.observations, input);
  const fired = signatures(c);
  if (!fired.length) {
    // Something failed and no signature recognised it. That is an honest and
    // common answer — and inventing a ranking for it would be exactly the
    // behaviour this module exists to avoid.
    return unrecognised(correlation, c);
  }

  const byCause = new Map();
  for (const sig of fired) {
    const entry = byCause.get(sig.cause) || { points: 0, why: [] };
    entry.points += sig.points;
    entry.why.push(sig.why);
    byCause.set(sig.cause, entry);
  }

  const candidates = [];
  for (const [cause, entry] of byCause) {
    const meta = BY_CAUSE.get(cause);
    if (!meta) continue;
    let points = entry.points;
    const why = [...entry.why];
    // The correlation and this module read the same observations, so agreement
    // is worth a little and no more — a large bonus would be one piece of
    // evidence counted twice.
    if (c.correlationLayer && meta.layer === c.correlationLayer) {
      points += LAYER_AGREEMENT;
      why.push(`the correlation also points at the ${c.correlationLayer} layer`);
    }
    const ceiling = CEILING[meta.basis];
    const likelihood = clamp(Math.round(points), 0, ceiling);
    if (likelihood < LISTING_FLOOR) continue;
    candidates.push({
      cause,
      label: meta.label,
      layer: meta.layer,
      basis: meta.basis,
      likelihood,
      // Said out loud on every capped candidate, because the number alone
      // cannot carry it: 40 next to 40 looks like a tie between equals.
      capped: points > ceiling,
      why,
      next_step: meta.next_step,
    });
  }

  // Highest first; ties broken by the catalogue's own order so the same
  // evidence always produces the same list rather than one that shuffles.
  candidates.sort((a, b) => (b.likelihood - a.likelihood) || (ORDER.get(a.cause) - ORDER.get(b.cause)));

  if (!candidates.length) return unrecognised(correlation, c);

  const top = candidates[0];
  const runnerUp = candidates[1] || null;
  const gap = runnerUp ? top.likelihood - runnerUp.likelihood : top.likelihood;
  // Rule 1. A leader four points clear is not a conclusion, it is an artefact
  // of the arithmetic, and the screen must not read as though it were.
  const decisive = gap >= DECISIVE_GAP && top.likelihood >= DECISIVE_FLOOR;

  return {
    candidates,
    top,
    // The second place, published rather than hidden. "It is this, and the next
    // most likely is that" is the shape of an honest diagnosis.
    runner_up: runnerUp,
    gap,
    decisive,
    summary: summarise(top, runnerUp, decisive, c),
    // The causes on this list BlueEyes cannot see from where it stands. Named
    // separately so a screen can mark them without re-deriving the rule.
    supposed: candidates.filter((x) => x.basis === BASIS.UNOBSERVABLE).map((x) => x.cause),
    // The holes in the evidence, carried through from correlation. A ranking
    // built while nobody checked the network should say so.
    not_checked: c.notChecked,
    // Rules, not a model. When AI later offers a second opinion it arrives as a
    // different source and the two are never confused on screen.
    source: 'rules',
  };
}

// Something failed and nothing recognised it. Said plainly.
function unrecognised(correlation, c) {
  return {
    candidates: [],
    top: null,
    runner_up: null,
    gap: 0,
    decisive: false,
    summary: correlation.layer
      ? `Something in the ${correlation.layer} layer failed, but none of the known causes matches what was seen.`
      : 'The journey failed, and none of the known causes matches what was seen.',
    supposed: [],
    not_checked: c.notChecked,
    source: 'rules',
  };
}

// One sentence for the screen.
//
// The hedging is load-bearing, not manners. A ranked list presented as a
// conclusion is one nobody checks, and the whole feature is that the evidence
// stays visible underneath it.
function summarise(top, runnerUp, decisive, c) {
  const holes = c.notChecked.length
    ? ` ${c.notChecked.join(', ')} ${c.notChecked.length === 1 ? 'was' : 'were'} not checked.`
    : '';
  const supposition = top.basis === BASIS.UNOBSERVABLE
    ? ' BlueEyes cannot see this from a browser — it is a place to look, not a finding.'
    : '';
  if (!decisive && runnerUp) {
    return `Most likely ${top.label.toLowerCase()} (${top.likelihood}%), but ${runnerUp.label.toLowerCase()} `
      + `(${runnerUp.likelihood}%) fits the same evidence.${supposition}${holes}`;
  }
  return `Most likely ${top.label.toLowerCase()} (${top.likelihood}% \u2014 an assessment, not a fact).${supposition}${holes}`;
}

module.exports = {
  analyseRootCause,
  CAUSE, BASIS, CEILING, CATALOGUE,
  LISTING_FLOOR, DECISIVE_GAP, DECISIVE_FLOOR, LAYER_AGREEMENT,
};
