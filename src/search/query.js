'use strict';

// Pure query analysis for the universal search field (Fase 1).
//
// The technician types what the phone told them — an IP, a MAC, a hostname, a
// site, a service name — and must not have to say which. This module decides
// what a string COULD be, so the service only runs the resolvers that can
// possibly match instead of fanning out to all of them on every keystroke.
//
// It also owns the result vocabulary (confidence, ordering), because those are
// the parts most likely to drift between resolvers if each defined its own.
//
// No I/O, no clock, no database.

const { normalizeMac, isIpv4, isIpv6 } = require('../identity/arpTable');

// Shortest query we will run. One or two characters match nearly everything, so
// the results are noise and the DB work is wasted.
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 64;

// Confidence is a fixed vocabulary, not a score: a resolver either matched an
// identifier exactly, or matched a name in a way that is more or less specific.
// A free-floating 0..1 number would invite each resolver to invent its own
// scale, and the sort would stop meaning anything.
//
//   exact  — an identifier matched exactly (IP, MAC, agent id)
//   high   — a name matched from the start (prefix), or a unique identifier-ish
//            field matched exactly (hostname)
//   medium — a name contained the query (substring)
//   low    — an indirect or weak association (e.g. a switch chassis id that
//            merely looks like the MAC being searched for)
const CONFIDENCE = ['exact', 'high', 'medium', 'low'];
const CONFIDENCE_RANK = { exact: 0, high: 1, medium: 2, low: 3 };

// Result kinds. `type` on a hit; also the UI's grouping key.
const TYPES = ['ip', 'mac', 'host', 'site', 'service', 'device', 'asset', 'event', 'ticket', 'ipam', 'user'];

// A ticket number as ITSM systems mint them: a short letter prefix and a run of
// digits (INC0012345, CHG000123, RITM0042). Used for confidence, not gating —
// the ticket resolvers also match words from a title.
const TICKET_REF_RE = /^[a-z]{2,6}\d{3,}$/i;
// A partial IPv4 or CIDR ("10.1.", "10.1.0.0/24", "192.168.1.0/2") — not an
// address (the IP resolvers match exactly, by design) but exactly what an IPAM
// prefix search answers.
const IP_PREFIX_RE = /^\d{1,3}(\.\d{1,3}){0,3}\.?(\/\d{1,2})?$/;

// Normalises the raw query: trim, collapse internal whitespace. Returns null for
// anything unusable so the caller can 400 rather than guess.
function normalizeQuery(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

// Classifies a query into the resolver families worth running.
//
// A query can belong to several: "10" is both a possible IP fragment and a
// possible agent id, and "dns" is both a hostname fragment and a service name.
// Returning a set rather than one winner is what lets the field accept whatever
// the technician actually knows.
//
// Returns { q, lower, isMac, mac, isIpExact, isAgentId, agentId, isPort, port,
//           isNumeric, families: [...] }.
function classify(raw) {
  const q = normalizeQuery(raw);
  if (q === null) return null;

  const lower = q.toLowerCase();
  const mac = normalizeMac(q);
  // Exact IP only — a partial IP ("192.168.1.") is a prefix of a name-shaped
  // field, not an address, and the spec is explicit that IP/MAC match exactly.
  const isIpExact = isIpv4(q) || isIpv6(q);
  const isNumeric = /^\d+$/.test(q);
  const agentId = isNumeric ? Number(q) : null;
  const isAgentId = isNumeric && Number.isInteger(agentId) && agentId > 0 && agentId <= 2147483647;
  const isPort = isNumeric && agentId >= 1 && agentId <= 65535;
  const isTicketRef = TICKET_REF_RE.test(q);
  const isIpPrefix = !isIpExact && !isNumeric && IP_PREFIX_RE.test(q);

  const families = [];
  // Ordered by the spec's resolver priority. The service preserves this order
  // when it fans out, so a cheap exact match is issued before a broad scan.
  if (isIpExact) families.push('ip');
  if (mac) families.push('mac');
  families.push('host');    // hostname / DNS / agent name — always worth trying
  families.push('site');
  if (isAgentId) families.push('agentId');
  if (isPort || /^[a-z0-9+.-]{2,}$/i.test(q)) families.push('service');
  // Events, tickets and IPAM take free text (a title, a description) as well as
  // identifiers, so they are always worth asking. The external ones are thunks
  // that answer [] instantly when nothing is configured.
  families.push('event');
  families.push('ticket');
  families.push('ipam');
  families.push('user');    // stubbed — see resolveUser

  return {
    q, lower, mac, isMac: Boolean(mac), isIpExact, isIpPrefix, isAgentId, agentId, isPort,
    port: isPort ? agentId : null, isNumeric, isTicketRef, families,
  };
}

// Validates a query for the HTTP layer. Returns { value } or { error }.
function validateQuery(raw) {
  const q = normalizeQuery(raw);
  if (q === null) return { error: 'q is required' };
  if (q.length < MIN_QUERY_LENGTH) return { error: `q must be at least ${MIN_QUERY_LENGTH} characters` };
  if (q.length > MAX_QUERY_LENGTH) return { error: `q must be at most ${MAX_QUERY_LENGTH} characters` };
  return { value: q };
}

// Compares two hits for the result ordering: confidence first, then last_seen
// descending, then display name for a stable order between equals.
//
// A null last_seen sorts LAST within its confidence tier. A hit we cannot date
// is not necessarily worse than one we can — but the technician's question is
// "is this current?", and an undated answer cannot claim to be.
function compareHits(a, b) {
  const ca = CONFIDENCE_RANK[a.confidence] ?? 99;
  const cb = CONFIDENCE_RANK[b.confidence] ?? 99;
  if (ca !== cb) return ca - cb;

  const ta = a.last_seen ? Date.parse(a.last_seen) : NaN;
  const tb = b.last_seen ? Date.parse(b.last_seen) : NaN;
  const va = Number.isFinite(ta);
  const vb = Number.isFinite(tb);
  if (va && vb && ta !== tb) return tb - ta;
  if (va !== vb) return va ? -1 : 1;

  return String(a.display_name || '').localeCompare(String(b.display_name || ''));
}

// Builds one result hit in the shape the API promises. Centralised so every
// resolver produces the same keys — `source` and `last_seen` in particular are
// required, because the technician must be able to tell an answer from yesterday
// from one from three weeks ago.
//
// `url` is optional: a hit that lives in another system (a ServiceNow ticket, a
// Nautobot prefix) has no screen in this product, so it carries a deep link
// instead and the UI opens that. Only http(s) links are accepted — a connector
// must not be able to hand the browser a javascript: URL.
function makeHit({ type, display_name: displayName, target, confidence, source, last_seen: lastSeen = null, detail = null, url = null }) {
  const safeUrl = typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
  return {
    type,
    display_name: displayName,
    target,
    confidence,
    source,
    last_seen: lastSeen || null,
    ...(detail ? { detail } : {}),
    ...(safeUrl ? { url: safeUrl } : {}),
  };
}

// Deduplicates hits that point at the same thing, keeping the highest-confidence
// (and, at equal confidence, the freshest) one. Several resolvers legitimately
// find the same agent — via its hostname, its ARP entry and its flows — and the
// technician wants one row per thing, not three.
function dedupe(hits) {
  const best = new Map();
  for (const hit of hits) {
    const key = `${hit.type}|${hit.target}`;
    const prev = best.get(key);
    if (!prev || compareHits(hit, prev) < 0) best.set(key, hit);
  }
  return [...best.values()];
}

module.exports = {
  MIN_QUERY_LENGTH,
  MAX_QUERY_LENGTH,
  CONFIDENCE,
  CONFIDENCE_RANK,
  TYPES,
  normalizeQuery,
  classify,
  validateQuery,
  compareHits,
  makeHit,
  dedupe,
};
