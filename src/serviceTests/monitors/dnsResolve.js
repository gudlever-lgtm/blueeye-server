'use strict';

const dns = require('dns');

// One DNS lookup, normalised to strings.
//
// Every record type node hands back in its own shape — TXT as an array of
// chunks, MX as objects, SOA as one object — and every consumer here wants the
// same thing: "what are the answers, as text, so I can look for something in
// them". So the shape flattening lives in one place.
//
// TXT chunking is the one that matters. A long SPF or DKIM record is split into
// 255-byte strings on the wire, and a check for `include:spf.example.com` finds
// nothing if the chunks are compared one at a time. They are joined with no
// separator, which is what every mail server does with them.

const RECORD_ERRORS = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

function flatten(record, answers) {
  const rows = Array.isArray(answers) ? answers : [answers];
  switch (String(record).toUpperCase()) {
    case 'TXT':
      return rows.map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
    case 'MX':
      return rows.map((r) => `${r.priority} ${r.exchange}`);
    case 'SRV':
      return rows.map((r) => `${r.priority} ${r.weight} ${r.port} ${r.name}`);
    case 'SOA':
      return rows.map((r) => `${r.nsname} ${r.hostmaster} ${r.serial}`);
    default:
      return rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
  }
}

// `server` asks a specific resolver instead of the system's. During a DNS change
// the authoritative answer and what the internet sees are different facts, and
// which one was asked must never be a guess.
function createResolver({ Resolver = dns.promises.Resolver, now = () => Date.now() } = {}) {
  async function resolve(name, record, { server = null, timeoutMs = 5000 } = {}) {
    const started = now();
    const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
    if (server) resolver.setServers([server]);
    const method = `resolve${String(record).toUpperCase() === 'A' ? '4' : String(record).toUpperCase()}`;
    const fn = resolver[method] || resolver.resolve;
    try {
      const answers = fn === resolver.resolve
        ? await resolver.resolve(name, String(record).toUpperCase())
        : await fn.call(resolver, name);
      return { answers: flatten(record, answers), ms: now() - started, code: null };
    } catch (err) {
      const code = (err && err.code) || null;
      // "There is no such record" is an ANSWER — the finding this check exists
      // for — not a failure to reach DNS. The caller tells them apart by `code`.
      if (RECORD_ERRORS.has(code)) return { answers: [], ms: now() - started, code };
      const wrapped = new Error((err && err.message) || 'the lookup failed');
      wrapped.code = code;
      wrapped.unreachable = true;
      throw wrapped;
    }
  }

  return { resolve };
}

module.exports = { createResolver, flatten };
