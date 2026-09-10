'use strict';

const { KIND, EXPLANATION } = require('../runner/classify');
const { STATUS } = require('./certificates');

// What Service Assurance DOES about what it found — the decision layer, pure.
//
// classify.js answers "what broke?". This answers "is that worth waking someone
// for, and how loudly?". Keeping them apart matters: the classification is a
// fact about one run and never changes, while the reaction depends on how many
// runs in a row, how many days are left, and what the operator set as their
// threshold.
//
// Every rule here is stated, bounded and explainable. No ML, no scoring model —
// an operator who asks "why did this page me at 02:00" gets a sentence, not a
// number (repo convention: analysis is local + explainable).

const SEVERITY = { INFO: 'INFO', WARN: 'WARN', CRIT: 'CRIT' };
const RANK = { INFO: 1, WARN: 2, CRIT: 3 };

const rank = (s) => RANK[String(s || '').toUpperCase()] || 0;
const worse = (a, b) => (rank(a) >= rank(b) ? a : b);

// Failures that mean the service is DOWN for a real user, not that the test
// drifted from the page. A wrong selector is the test's problem and opens a WARN;
// a refused connection is the service's problem and opens a CRIT immediately.
const OUTAGE_KINDS = new Set([
  KIND.DNS,
  KIND.CONNECTION_REFUSED,
  KIND.TLS,
  KIND.HTTP_500,
  KIND.HTTP_502,
  KIND.HTTP_503,
  KIND.HTTP_5XX,
]);

// Failures that say the TEST is wrong, not the service. They still open an
// incident — a test nobody fixes is a service nobody is watching — but they
// never escalate past WARN, so a renamed button cannot page someone at night.
const TEST_HEALTH_KINDS = new Set([
  KIND.ELEMENT_NOT_FOUND,
  KIND.ELEMENT_NOT_VISIBLE,
  KIND.ASSERTION_FAILED,
  KIND.BLOCKED,
  KIND.CREDENTIAL_MISSING,
]);

// Certificate incident kinds. Deliberately distinct from KIND.TLS: that one
// means "a test could not connect", these mean "the certificate itself is the
// finding", and an operator filtering their alerts wants to tell them apart.
const CERT_KIND = {
  EXPIRED: 'certificate_expired',
  EXPIRING: 'certificate_expiring',
  INVALID: 'certificate_invalid',
  UNREACHABLE: 'certificate_unreachable',
};

const CERT_EXPLANATION = {
  [CERT_KIND.EXPIRED]: {
    summary: 'The TLS certificate has expired.',
    cause: 'An unrenewed certificate',
    detail: 'Every browser now refuses this address with a full-page security warning. Renewing the certificate is the only fix; nothing else about the service is wrong.',
  },
  [CERT_KIND.EXPIRING]: {
    summary: 'The TLS certificate expires soon.',
    cause: 'A certificate approaching its renewal date',
    detail: 'The service works today. On the expiry date every browser will refuse it, so this is a deadline rather than a fault — renew it before then and nothing happens.',
  },
  [CERT_KIND.INVALID]: {
    summary: 'The TLS certificate did not verify.',
    cause: 'The certificate chain or the name on it',
    detail: 'The peer answered, but the certificate is self-signed, issued for a different name, or its chain is incomplete. Visitors see a security warning even though the service is running.',
  },
  [CERT_KIND.UNREACHABLE]: {
    summary: 'The certificate could not be read — nothing answered.',
    cause: 'The host, the network or a firewall',
    detail: 'No TLS handshake completed, so there is nothing to say about the certificate. Either the address is wrong or the service is down.',
  },
};

// The plain-language record for any incident kind, whichever side it came from.
function explain(kind) {
  return CERT_EXPLANATION[kind] || EXPLANATION[kind] || EXPLANATION[KIND.UNKNOWN];
}

// ------------------------------------------------------------- certificates
// Severity for one certificate row. `null` means "nothing to react to" — which
// includes a certificate that is merely inside the warning window when the
// operator has set the warning window to zero days.
function certificateReaction(cert, { warnDays = 30, criticalDays = 7 } = {}) {
  if (!cert) return null;
  const days = cert.days_remaining;
  if (cert.status === STATUS.UNREACHABLE) {
    return { kind: CERT_KIND.UNREACHABLE, severity: SEVERITY.WARN };
  }
  if (cert.status === STATUS.EXPIRED) {
    return { kind: CERT_KIND.EXPIRED, severity: SEVERITY.CRIT };
  }
  if (cert.status === STATUS.INVALID) {
    return { kind: CERT_KIND.INVALID, severity: SEVERITY.CRIT };
  }
  // `status` was decided at check time against whatever the warning window was
  // THEN; the days remaining are re-judged here against the window as it is NOW,
  // so lowering the window quiets an incident without waiting for the next poll.
  if (!Number.isFinite(days) || days > warnDays) return null;
  return {
    kind: CERT_KIND.EXPIRING,
    severity: days <= criticalDays ? SEVERITY.CRIT : SEVERITY.WARN,
  };
}

// The one-line "what an operator needs to read first" for a certificate.
function certificateSummary(cert, kind) {
  const where = `${cert.host}${cert.port && cert.port !== 443 ? `:${cert.port}` : ''}`;
  const days = cert.days_remaining;
  switch (kind) {
    case CERT_KIND.EXPIRED:
      return Number.isFinite(days)
        ? `The certificate for ${where} expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago.`
        : `The certificate for ${where} has expired.`;
    case CERT_KIND.EXPIRING:
      return days === 0
        ? `The certificate for ${where} expires today.`
        : `The certificate for ${where} expires in ${days} day${days === 1 ? '' : 's'}.`;
    case CERT_KIND.INVALID:
      return `The certificate for ${where} did not verify${cert.error_message ? ` (${cert.error_message})` : ''}.`;
    case CERT_KIND.UNREACHABLE:
      return `No TLS handshake with ${where}${cert.error_message ? ` (${cert.error_message})` : ''}.`;
    default:
      return `The certificate for ${where} needs attention.`;
  }
}

// ------------------------------------------------------------------- tests
// Severity for a run of consecutive failures on one test.
//
//   * below the streak threshold          → nothing (one bad run is not an outage)
//   * a test-health failure               → WARN, and it stays WARN
//   * an outage failure                   → CRIT
//   * anything else                       → WARN, CRIT once it has failed twice
//                                           the threshold (it is not going away)
function runReaction({ failureKind, streak = 0 }, { failureStreak = 2 } = {}) {
  const threshold = Math.max(1, Number(failureStreak) || 1);
  if (!failureKind || streak < threshold) return null;
  if (TEST_HEALTH_KINDS.has(failureKind)) return { kind: failureKind, severity: SEVERITY.WARN };
  if (OUTAGE_KINDS.has(failureKind)) return { kind: failureKind, severity: SEVERITY.CRIT };
  return { kind: failureKind, severity: streak >= threshold * 2 ? SEVERITY.CRIT : SEVERITY.WARN };
}

function runSummary({ testName, failureKind, streak, errorMessage }) {
  const what = explain(failureKind).summary;
  const times = `${streak} run${streak === 1 ? '' : 's'} in a row`;
  const tail = errorMessage ? ` — ${String(errorMessage).slice(0, 200)}` : '';
  return `"${testName}" has failed ${times}: ${what}${tail}`;
}

module.exports = {
  SEVERITY, RANK, rank, worse,
  OUTAGE_KINDS, TEST_HEALTH_KINDS,
  CERT_KIND, CERT_EXPLANATION, explain,
  certificateReaction, certificateSummary,
  runReaction, runSummary,
};
