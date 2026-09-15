'use strict';

const { createResolver } = require('../dnsResolve');
const { ok, failed, unreachable, misconfigured, KIND } = require('../result');

// "Is the address we send mail from on a blacklist?"
//
// A listing is the quietest possible outage: the mail server keeps accepting,
// the queue keeps draining, and the recipients' servers keep refusing. Nobody
// finds out from their own logs — they find out when a customer says "I never
// got your invoice".
//
// The lookup is the standard DNSBL convention: reverse the octets, append the
// list's domain, ask for an A record. An answer means listed (and the address
// returned, usually 127.0.0.x, says why); NXDOMAIN means not listed.

// 1.2.3.4 → 4.3.2.1. IPv6 is not supported by most lists and is not attempted:
// a check that silently asks a question nobody answers is worse than one that
// says it cannot.
function reverseIpv4(ip) {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return null;
  if (!parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reverse().join('.');
}

function createRblCheck({ resolver = null, now = () => Date.now() } = {}) {
  const dns = resolver || createResolver({ now });

  async function check(monitor) {
    const cfg = monitor.config || {};
    const reversed = reverseIpv4(cfg.ip);
    if (!reversed) {
      return misconfigured({ summary: `"${cfg.ip || ''}" is not an IPv4 address — blacklists are indexed by address, not by name.` });
    }
    const lists = Array.isArray(cfg.lists) && cfg.lists.length ? cfg.lists : [];
    if (!lists.length) return misconfigured({ summary: 'No blacklists to check.' });

    const started = now();
    const listed = [];
    const errors = [];
    let answered = 0;

    for (const list of lists) {
      const name = `${reversed}.${list}`;
      try {
        // eslint-disable-next-line no-await-in-loop
        const a = await dns.resolve(name, 'A', { server: cfg.resolver || null, timeoutMs: cfg.timeout_ms || 5000 });
        answered += 1;
        if (!a.answers.length) continue;
        let reason = null;
        try {
          // The TXT alongside the listing is the human reason ("Spamhaus SBL
          // CSS"). Best-effort: the listing itself is the finding.
          // eslint-disable-next-line no-await-in-loop
          const txt = await dns.resolve(name, 'TXT', { server: cfg.resolver || null, timeoutMs: cfg.timeout_ms || 5000 });
          reason = txt.answers[0] || null;
        } catch { reason = null; }
        listed.push({ list, codes: a.answers, reason });
      } catch (err) {
        errors.push({ list, error: (err && err.message) || String(err) });
      }
    }

    const ms = now() - started;
    const detail = { ip: cfg.ip, lists, listed, errors };

    if (listed.length) {
      const names = listed.map((l) => l.list).join(', ');
      return failed(KIND.RBL_LISTED, {
        summary: `${cfg.ip} is listed on ${listed.length} of ${lists.length} blacklist(s): ${names}.`,
        value: listed.length,
        unit: 'count',
        durationMs: ms,
        detail,
      });
    }
    // Every list failed to answer: that is a DNS problem here, and reporting
    // "not listed" would be reporting a fact nobody established.
    if (!answered) {
      return unreachable({
        summary: `None of the ${lists.length} blacklist(s) could be queried.`,
        error: errors.length ? errors[0].error : null,
        durationMs: ms,
        detail,
      });
    }
    return ok({
      summary: `${cfg.ip} is not listed on ${answered} blacklist(s).`,
      value: 0,
      unit: 'count',
      durationMs: ms,
      detail,
    });
  }

  return { check };
}

module.exports = { createRblCheck, reverseIpv4 };
