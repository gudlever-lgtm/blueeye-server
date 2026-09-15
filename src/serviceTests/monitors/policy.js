'use strict';

const { STATUS, KIND } = require('./types');

// What a monitor result MEANS — pure, and separate from the check that produced
// it for the same reason classify.js is separate from policy.js one directory
// up: the observation is a fact about one moment and never changes, while the
// reaction depends on how many times in a row, on the operator's thresholds, and
// on how much of the answer is ours to fix.

const SEVERITY = { INFO: 'INFO', WARN: 'WARN', CRIT: 'CRIT' };

// Conditions that are TRUE the first time they are seen. A certificate expiring
// in six days does not become more true by being checked twice, and a DNS record
// that is gone is gone. Everything else waits for the operator's failure streak,
// because one bad minute is not an outage.
const IMMEDIATE = new Set([
  KIND.TLS_EXPIRING,
  KIND.TLS_EXPIRED,
  KIND.TLS_INVALID,
  KIND.RBL_LISTED,
  KIND.DNS_RECORD_MISSING,
  KIND.DNS_RECORD_MISMATCH,
  KIND.DNS_UNEXPECTED_RECORD,
  KIND.MISCONFIGURED,
]);

// The service is down for a real user. These page.
const OUTAGE = new Set([
  KIND.MAIL_REJECTED,
  KIND.MAIL_UNDELIVERED,
  KIND.RBL_LISTED,
  KIND.LDAP_BIND_FAILED,
  KIND.DB_QUERY_FAILED,
  KIND.TCP_REFUSED,
  KIND.TLS_EXPIRED,
  KIND.TLS_INVALID,
  KIND.UNREACHABLE,
]);

// Advisory: real, worth fixing, never worth waking someone for. A monitor whose
// own credentials are wrong is in here on purpose — that is our configuration,
// and paging an operator because BlueEyes mistyped a password is how alerting
// loses its audience.
const ADVISORY = new Set([
  KIND.MAIL_AUTH_FAILED,
  KIND.NTP_OFFSET_HIGH,
  KIND.TCP_BANNER_MISMATCH,
  KIND.LDAP_SEARCH_EMPTY,
  KIND.MISCONFIGURED,
]);

const EXPLANATION = {
  [KIND.MAIL_REJECTED]: {
    summary: 'The mail server refused the message.',
    cause: 'The mail server or its policy',
    detail: 'The probe reached the server and was told no. The code it answered with says why — authentication, a relay policy, a rejected sender or recipient. No mail matching this probe is leaving the server.',
  },
  [KIND.MAIL_UNDELIVERED]: {
    summary: 'The mail was accepted but never arrived.',
    cause: 'The queue, a filter or a forwarding rule',
    detail: 'The sending server took the message and reported success, and it was not in the destination mailbox before the deadline. This is the failure that never appears in a sending log: a stalled queue, a spam filter that quarantined it, or an alias pointing somewhere else. Mail is being lost silently.',
  },
  [KIND.MAIL_SLOW]: {
    summary: 'The mail arrived, but slowly.',
    cause: 'A backed-up queue or a slow filter',
    detail: 'Delivery worked and took longer than the limit set for it. Password resets and one-time codes stop being usable long before mail stops being delivered, so this is a real fault while everything still technically works.',
  },
  [KIND.MAIL_AUTH_FAILED]: {
    summary: 'The mail server rejected the probe credentials.',
    cause: 'The credentials this monitor uses',
    detail: 'The server answered and refused the login. Nothing is said about whether real mail is flowing — this is the monitor\'s own account, and the fix is in the monitor unless the same account is what the application sends with.',
  },
  [KIND.DNS_RECORD_MISSING]: {
    summary: 'The DNS record is gone.',
    cause: 'A DNS change',
    detail: 'The name resolves but the record this monitor watches is not there. For SPF, DKIM or DMARC that means receiving servers have nothing to check against and mail starts being treated as unauthenticated — usually noticed days later, as "our mail goes to spam".',
  },
  [KIND.DNS_RECORD_MISMATCH]: {
    summary: 'The DNS record no longer says what it should.',
    cause: 'A DNS edit',
    detail: 'The record exists, and something the monitor requires is no longer in it — an include that was dropped, a policy that was weakened, a host that was replaced. Everything still resolves, which is why nothing else reports it.',
  },
  [KIND.DNS_UNEXPECTED_RECORD]: {
    summary: 'The DNS record contains something it must not.',
    cause: 'A DNS edit',
    detail: 'A value the operator explicitly required to be absent is present again — a DMARC policy back at p=none, or a sender that was meant to be removed.',
  },
  [KIND.RBL_LISTED]: {
    summary: 'The sending address is on a blacklist.',
    cause: 'A listing at the receiving end',
    detail: 'Receiving mail servers that use this list will refuse or quarantine mail from this address. Nothing here is broken and nothing local will report it: the failure happens at every recipient, and is discovered when somebody says they never got the message.',
  },
  [KIND.LDAP_BIND_FAILED]: {
    summary: 'The directory refused the bind.',
    cause: 'The directory or the account',
    detail: 'The directory answered and would not accept these credentials. If the application signs in the same way, nobody is signing in.',
  },
  [KIND.LDAP_SEARCH_EMPTY]: {
    summary: 'The directory bound but returned nothing.',
    cause: 'The directory\'s data or the search base',
    detail: 'Authentication works and the search that follows it does not. A server that binds but cannot read is a half-working directory — applications that look users up after signing them in will fail after a successful login.',
  },
  [KIND.NTP_OFFSET_HIGH]: {
    summary: 'The clock is out.',
    cause: 'Time synchronisation on that host',
    detail: 'The offset is past the limit set for it. Clock drift presents as everything except a clock problem: Kerberos refuses tickets past five minutes, one-time codes stop matching, and correlating logs across hosts quietly stops working.',
  },
  [KIND.TLS_EXPIRING]: {
    summary: 'The certificate on this port expires soon.',
    cause: 'A certificate approaching its renewal date',
    detail: 'The service works today. On the expiry date the clients that use this port — mail clients, directory clients, anything with TLS required — will refuse it. This is a deadline, not a fault.',
  },
  [KIND.TLS_EXPIRED]: {
    summary: 'The certificate on this port has expired.',
    cause: 'An unrenewed certificate',
    detail: 'Anything that verifies certificates now refuses this port. Renewing it is the only fix; nothing else about the service is wrong.',
  },
  [KIND.TLS_INVALID]: {
    summary: 'The certificate on this port did not verify.',
    cause: 'The certificate chain or the name on it',
    detail: 'The peer answered with a certificate that is self-signed, issued for a different name, or missing part of its chain. Strict clients refuse it; lenient ones warn.',
  },
  [KIND.TCP_REFUSED]: {
    summary: 'Nothing is listening on that port.',
    cause: 'The service, the host or a firewall',
    detail: 'The connection was refused, timed out or could not be routed. Whatever depends on this port is not working.',
  },
  [KIND.TCP_BANNER_MISMATCH]: {
    summary: 'The port answered with something unexpected.',
    cause: 'The service behind the port',
    detail: 'Something accepted the connection and did not identify itself the way it should. A port that is open without the right service behind it — a load balancer answering for a backend that is gone — looks healthy to anything that only checks whether the port opens.',
  },
  [KIND.DB_QUERY_FAILED]: {
    summary: 'The database refused the check.',
    cause: 'The database or its credentials',
    detail: 'The server answered and the connection or the query did not succeed — a rotated password, a connection limit, a database that is no longer there. Applications using the same credentials are failing the same way.',
  },
  [KIND.SLOW]: {
    summary: 'The check passed, but slowly.',
    cause: 'Load somewhere along the path',
    detail: 'The answer was correct and took longer than the limit set for it. Slow is the state before down, and it is the state a user complains about first.',
  },
  [KIND.UNREACHABLE]: {
    summary: 'Nothing answered.',
    cause: 'The host, the network or a firewall',
    detail: 'No connection was made, so there is no answer to judge. Either the address is wrong or the service is down.',
  },
  [KIND.MISCONFIGURED]: {
    summary: 'The monitor cannot run.',
    cause: 'This monitor\'s own configuration',
    detail: 'Something the check needs is missing or refused — a credential, a mailbox, a driver. Nothing is being measured, which means the silence from this monitor means nothing. This is ours to fix, not the monitored service\'s.',
  },
};

const explain = (kind) => EXPLANATION[kind] || EXPLANATION[KIND.UNREACHABLE];

// The severity for one result, or null when there is nothing to react to.
//
//   ok                           → null
//   below the failure streak     → null (unless the condition is IMMEDIATE)
//   misconfigured / advisory     → WARN, and it stays WARN
//   an outage                    → CRIT
//   slow                         → whatever the threshold pass judged
//   anything else                → WARN, CRIT once it has failed twice the streak
function monitorReaction(result, { failureStreak = 2, streak = 0, criticalDays = 7 } = {}) {
  if (!result || result.status === STATUS.OK) return null;
  const kind = result.kind || KIND.UNREACHABLE;
  const threshold = Math.max(1, Number(failureStreak) || 1);
  const count = Math.max(1, Number(streak) || 1);
  if (!IMMEDIATE.has(kind) && count < threshold) return null;

  if (result.status === STATUS.MISCONFIGURED) return { kind: KIND.MISCONFIGURED, severity: SEVERITY.WARN };

  if (result.status === STATUS.SLOW) {
    return { kind, severity: result.severity_hint === 'CRIT' ? SEVERITY.CRIT : SEVERITY.WARN };
  }

  // A certificate deadline is re-judged from the days remaining every time, so
  // moving the critical window quiets or escalates it on the next check rather
  // than on the next expiry.
  if (kind === KIND.TLS_EXPIRING) {
    const days = Number.isFinite(result.value) ? result.value : null;
    return { kind, severity: days !== null && days <= criticalDays ? SEVERITY.CRIT : SEVERITY.WARN };
  }

  if (ADVISORY.has(kind)) return { kind, severity: SEVERITY.WARN };
  if (OUTAGE.has(kind)) return { kind, severity: SEVERITY.CRIT };
  return { kind, severity: count >= threshold * 2 ? SEVERITY.CRIT : SEVERITY.WARN };
}

// What an operator reads first. The check already wrote a sentence about what it
// saw; this puts the monitor's name and the streak around it, because "failed
// once" and "failed for six hours" are different messages.
function monitorSummary(monitor, result, streak = 1) {
  const what = (result && result.summary) || explain(result && result.kind).summary;
  const name = (monitor && monitor.name) || 'monitor';
  if (streak > 1) return `"${name}" — ${what} (${streak} checks in a row)`;
  return `"${name}" — ${what}`;
}

// The evidence list on the incident. Plain lines, no JSON: this is read by a
// person at two in the morning.
function monitorEvidence(monitor, result, streak = 1) {
  const detail = (result && result.detail) || {};
  const lines = [
    `Monitor: ${monitor.name} (${monitor.type})`,
    `Target: ${monitor.target}`,
    result && result.value !== null && result.value !== undefined && result.unit
      ? `Measured: ${Math.round(result.value)} ${result.unit}`
      : null,
    streak > 1 ? `Consecutive failures: ${streak}` : null,
    result && result.error_message ? `Reported: ${String(result.error_message).slice(0, 300)}` : null,
  ];
  if (detail.smtp_code) lines.push(`SMTP said: ${detail.smtp_code} ${String(detail.smtp_response || '').slice(0, 120)}`);
  if (detail.queue_id) lines.push(`Queue id: ${detail.queue_id}`);
  if (Array.isArray(detail.answers) && detail.answers.length) lines.push(`Answers: ${detail.answers.slice(0, 3).join(' | ').slice(0, 300)}`);
  if (Array.isArray(detail.listed) && detail.listed.length) lines.push(`Listed on: ${detail.listed.map((l) => l.list).join(', ')}`);
  if (detail.valid_to) lines.push(`Expires: ${String(detail.valid_to).slice(0, 10)}`);
  return lines.filter(Boolean);
}

// Whether a result counts as a failure for the streak. `slow` does: a service
// that is over its limit five times running is not having a moment.
const isFailure = (result) => !!result && result.status !== STATUS.OK;

module.exports = {
  SEVERITY, IMMEDIATE, OUTAGE, ADVISORY, EXPLANATION,
  explain, monitorReaction, monitorSummary, monitorEvidence, isFailure,
};
