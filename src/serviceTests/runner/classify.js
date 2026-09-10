'use strict';

// Failure classification (spec §21).
//
// Simple, stated rules — no ML, no cloud, and deliberately no pretence of
// intelligence. Each classification says WHAT was observed, WHY that is the
// conclusion, and leaves the raw technical detail alongside it. An operator
// reading "Likely cause: Authentication service" can see the 503 from
// /api/auth/login that produced it.
//
// Pure: evidence in, explanation out. No I/O.

const KIND = {
  DNS: 'dns_failure',
  CONNECTION_REFUSED: 'connection_refused',
  TLS: 'tls_failure',
  TIMEOUT: 'timeout',
  HTTP_404: 'http_404',
  HTTP_4XX: 'http_4xx',
  HTTP_500: 'http_500',
  HTTP_502: 'http_502',
  HTTP_503: 'http_503',
  HTTP_5XX: 'http_5xx',
  JS_ERROR: 'javascript_error',
  ELEMENT_NOT_FOUND: 'element_not_found',
  ELEMENT_NOT_VISIBLE: 'element_not_visible',
  ASSERTION_FAILED: 'assertion_failed',
  UNEXPECTED_REDIRECT: 'unexpected_redirect',
  BLOCKED: 'blocked_by_policy',
  CREDENTIAL_MISSING: 'credential_unavailable',
  UNKNOWN: 'unknown',
};

// Plain-language explanation per kind: what the operator reads first.
const EXPLANATION = {
  [KIND.DNS]: {
    summary: 'The address could not be looked up.',
    cause: 'DNS or the host name',
    detail: 'The name did not resolve, so no connection was attempted. Either the name is wrong or DNS is failing.',
  },
  [KIND.CONNECTION_REFUSED]: {
    summary: 'The server refused the connection.',
    cause: 'The web server or a firewall',
    detail: 'The address resolved but nothing accepted the connection — the service may be down, or a firewall is blocking the port.',
  },
  [KIND.TLS]: {
    summary: 'The secure connection could not be established.',
    cause: 'The TLS certificate',
    detail: 'The certificate is expired, self-signed, or issued for a different name.',
  },
  [KIND.TIMEOUT]: {
    summary: 'The step took too long and was stopped.',
    cause: 'A slow response or an element that never appeared',
    detail: 'Nothing answered within the time limit. That is usually a slow backend, or a page that never finished loading.',
  },
  [KIND.HTTP_404]: {
    summary: 'The page or endpoint was not found.',
    cause: 'A wrong address, or a page that has moved',
    detail: 'The server answered 404. The test may be pointing at an address that no longer exists.',
  },
  [KIND.HTTP_4XX]: {
    summary: 'The server rejected the request.',
    cause: 'Permissions or the request itself',
    detail: 'A 4xx response means the server understood the request and refused it — often a login, a permission or a validation problem.',
  },
  [KIND.HTTP_500]: {
    summary: 'The application returned an internal error.',
    cause: 'The application',
    detail: 'A 500 comes from the application itself. The network and the web server did their job.',
  },
  [KIND.HTTP_502]: {
    summary: 'A gateway got a bad response from the application behind it.',
    cause: 'The application behind the proxy',
    detail: 'A 502 means the reverse proxy reached the application and got something it could not use — the backend is usually down or crashing.',
  },
  [KIND.HTTP_503]: {
    summary: 'The service was unavailable.',
    cause: 'The service behind this address',
    detail: 'A 503 means the service is up enough to answer but not to serve — overloaded, restarting, or in maintenance.',
  },
  [KIND.HTTP_5XX]: {
    summary: 'The server returned an error.',
    cause: 'The server',
    detail: 'A 5xx response means the failure is on the server side, not in the test.',
  },
  [KIND.JS_ERROR]: {
    summary: 'The page raised a script error.',
    cause: 'The application front-end',
    detail: 'JavaScript on the page threw an error, which often leaves the page half-rendered so later steps cannot find what they need.',
  },
  [KIND.ELEMENT_NOT_FOUND]: {
    summary: 'The element was not found on the page.',
    cause: 'A changed page, or a page that did not load as expected',
    detail: 'None of the ways this step knows to find the element matched. Either the page changed, or an earlier step left the wrong page open.',
  },
  [KIND.ELEMENT_NOT_VISIBLE]: {
    summary: 'The element exists but is not visible.',
    cause: 'A hidden or covered element',
    detail: 'The element is in the page but hidden, off-screen, or behind something else — a cookie banner or a dialog is the usual reason.',
  },
  [KIND.ASSERTION_FAILED]: {
    summary: 'The page did not show what the test expected.',
    cause: 'The application',
    detail: 'The step ran, and what it found did not match what was expected.',
  },
  [KIND.UNEXPECTED_REDIRECT]: {
    summary: 'The browser ended up somewhere else.',
    cause: 'A redirect, often a session that was not valid',
    detail: 'The page redirected away from the expected address — being bounced back to a login page is the common case.',
  },
  [KIND.BLOCKED]: {
    summary: 'The address was blocked by this application\'s security policy.',
    cause: 'The allowed-hosts policy',
    detail: 'Service Tests only reaches an application\'s own hosts and the ones an administrator has allowed. This address is not among them.',
  },
  [KIND.CREDENTIAL_MISSING]: {
    summary: 'The login for this test could not be used.',
    cause: 'The stored credential',
    detail: 'The credential is missing, or could not be decrypted — which happens when the encryption key changed after it was saved.',
  },
  [KIND.UNKNOWN]: {
    summary: 'The step failed.',
    cause: 'Unknown',
    detail: 'The failure did not match any known pattern. The technical details below are the full record.',
  },
};

function fromHttpStatus(status) {
  const n = Number(status);
  if (!Number.isFinite(n)) return null;
  if (n === 404) return KIND.HTTP_404;
  if (n === 500) return KIND.HTTP_500;
  if (n === 502) return KIND.HTTP_502;
  if (n === 503) return KIND.HTTP_503;
  if (n >= 500) return KIND.HTTP_5XX;
  if (n >= 400) return KIND.HTTP_4XX;
  return null;
}

// Maps a driver/network error to a kind. Matching is on stable substrings that
// the browser and Node both produce; anything unmatched stays UNKNOWN rather
// than being forced into a category it does not belong to.
function fromErrorMessage(message) {
  const m = String(message || '').toLowerCase();
  if (!m) return null;
  if (/enotfound|name_not_resolved|getaddrinfo|dns/.test(m)) return KIND.DNS;
  if (/econnrefused|connection_refused|connection refused/.test(m)) return KIND.CONNECTION_REFUSED;
  if (/cert|ssl|tls|err_cert/.test(m)) return KIND.TLS;
  if (/timeout|timed out|exceeded/.test(m)) return KIND.TIMEOUT;
  if (/blocked by policy|not allowlisted|permanently blocked/.test(m)) return KIND.BLOCKED;
  if (/credential/.test(m)) return KIND.CREDENTIAL_MISSING;
  if (/not visible|hidden|outside of the viewport|intercepts pointer/.test(m)) return KIND.ELEMENT_NOT_VISIBLE;
  if (/not found|no element|resolved to 0 elements|waiting for locator/.test(m)) return KIND.ELEMENT_NOT_FOUND;
  return null;
}

// The classifier. Evidence is whatever the runner collected around the failure:
//   { step, error, httpStatus, consoleErrors, networkErrors, url, expectedUrl }
//
// Order matters and is deliberate: a policy refusal or a missing credential is a
// fact about the test setup and outranks anything the page did; an HTTP status
// from the failing request outranks a generic driver timeout, because "503" is
// more useful than "timeout" when both are true.
function classify(evidence = {}) {
  const e = evidence && typeof evidence === 'object' ? evidence : {};
  const reasons = [];

  let kind = null;
  // The status the classification was actually based on — which may come from a
  // failing sub-request rather than the step's own response.
  let observedStatus = e.httpStatus ?? null;

  const direct = fromErrorMessage(e.error && (e.error.message || e.error));
  if (direct === KIND.BLOCKED || direct === KIND.CREDENTIAL_MISSING) {
    kind = direct;
    reasons.push('The step was refused before it reached the application.');
  }

  // A failing request on the wire beats the driver's own description: "503" is
  // more useful than "timeout" when both are true.
  //
  // The failing SUB-REQUEST is checked before e.httpStatus, because httpStatus
  // is whatever the last navigation returned — usually a healthy 200 from the
  // page that then made a failing XHR. Reading that 200 first would classify a
  // dead auth API as a plain timeout.
  if (!kind) {
    const failing = (Array.isArray(e.networkErrors) ? e.networkErrors : [])
      .filter((n) => n && Number(n.status) >= 400)
      .sort((a, b) => Number(b.status) - Number(a.status))[0];
    const status = failing ? failing.status : e.httpStatus;
    const httpKind = fromHttpStatus(status);
    if (httpKind) {
      kind = httpKind;
      observedStatus = status;
      reasons.push(failing && failing.url
        ? `HTTP ${status} from ${failing.url}`
        : `HTTP ${status} from the page`);
    }
  }

  if (!kind && direct) {
    kind = direct;
    if (direct === KIND.TIMEOUT) reasons.push('The step reached its time limit.');
  }

  // A script error explains a missing element better than "not found" does.
  if ((!kind || kind === KIND.ELEMENT_NOT_FOUND) && Array.isArray(e.consoleErrors) && e.consoleErrors.length) {
    kind = KIND.JS_ERROR;
    reasons.push(`The page reported ${e.consoleErrors.length} script error${e.consoleErrors.length === 1 ? '' : 's'}.`);
  }

  if (!kind && e.expectedUrl && e.url && e.url !== e.expectedUrl) {
    kind = KIND.UNEXPECTED_REDIRECT;
    reasons.push(`The browser ended on ${e.url} instead of ${e.expectedUrl}.`);
  }

  if (!kind && e.assertionFailed) {
    kind = KIND.ASSERTION_FAILED;
  }

  if (!kind) kind = KIND.UNKNOWN;

  const explanation = EXPLANATION[kind] || EXPLANATION[KIND.UNKNOWN];
  return {
    kind,
    summary: explanation.summary,
    likely_cause: explanation.cause,
    explanation: explanation.detail,
    // Every reason we actually observed, so the conclusion can be audited rather
    // than trusted.
    evidence: reasons,
    http_status: observedStatus,
  };
}

module.exports = { classify, fromHttpStatus, fromErrorMessage, KIND, EXPLANATION };
