'use strict';

const { numOrNull } = require('../storage/shape');

// What an AI provider is allowed to see (V3 Phase 4, docs/service-assurance-v3.md
// §"Security and privacy").
//
// This is the whole security argument for the AI layer, so it is worth stating
// plainly:
//
//   THIS IS AN ALLOWLIST, AND THAT IS NOT AN IMPLEMENTATION DETAIL.
//
// The obvious design is to take an incident, an evidence bundle, a stack trace,
// and strip the things that look like secrets before sending. That design loses.
// Not immediately — it loses the first time somebody's API gateway puts a bearer
// token in an error message in a format nobody wrote a pattern for, and it loses
// SILENTLY, because nothing downstream can tell that a token went out.
//
// You cannot prove an arbitrary blob contains no secrets. You can prove a blob
// contains only fields you put there by name. So every field that reaches a
// provider is chosen HERE, one at a time, from a typed source. There is no
// `{...incident}` anywhere in this file, and there must never be one: a spread
// means a column added by a future migration is forwarded to a third party by a
// file nobody re-read.
//
// The scrub pass below is DEFENCE IN DEPTH for the handful of free-text fields
// that genuinely have to be included — an error message is the most useful
// single thing in an incident and also the likeliest place for a token to be
// echoed. It is the second control, never the first.
//
// PURE: an incident and its evidence in, a context out. No provider, no network,
// no database.

// Free text that has to be forwarded is scrubbed for the shapes a credential
// takes when it turns up somewhere it should not. Every one of these has been
// seen in a real error message.
//
// Ordered longest-match-first where they overlap, and applied to a COPY: none of
// this ever writes back to the incident.
const SCRUBBERS = [
  // Authorization headers, in any of the spellings a log writes them.
  //
  // To the END OF THE LINE, not `\S+`. With `\S+` this ate the word "Bearer"
  // and left the token sitting after the mask — which looks redacted at a glance
  // and is not. A spec that asserted the mask was PRESENT passed on it; the one
  // that asserts the secret is ABSENT is what caught it.
  [/\b(authorization|proxy-authorization)\s*[:=][^\r\n]*/gi, '$1: [removed]'],
  [/\b(bearer|basic|digest)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [removed]'],
  // A JWT is three base64url segments. Recognisable on sight and worth its own
  // rule, because it is the one people paste into a URL.
  [/\beyJ[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{5,}/g, '[removed jwt]'],
  // Cookies, whole. A Set-Cookie line is never useful to an analysis.
  [/\b(set-cookie|cookie)\s*[:=]\s*[^\r\n]+/gi, '$1: [removed]'],
  // Anything named like a credential with a value after it.
  [/\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|pwd|passphrase|client[_-]?secret|private[_-]?key|session[_-]?id|sessionid|csrf[_-]?token|x-api-key)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=[removed]'],
  // The same thing in a query string, where it is easiest to miss.
  [/([?&])(api[_-]?key|apikey|access[_-]?token|token|secret|password|passwd|pwd|sig|signature|auth)=[^&\s"']*/gi, '$1$2=[removed]'],
  // Credentials in a URL's authority. `https://user:pass@host` is still common.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[removed]@'],
  // Private keys, whole block.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[removed private key]'],
  // AWS-shaped access key ids, which are distinctive enough to catch by shape.
  [/\bAKIA[0-9A-Z]{16}\b/g, '[removed]'],
];

// A hostname in free text is still a hostname.
//
// This file already refuses `subject_key` because it encodes a host, and then
// forwarded the same host inside every error message that happened to contain a
// URL — which is most of them. Internal host names are the customer's topology,
// and the analysis does not need them: there is exactly one service in the
// context, so "/api/search is failing" says everything "portal.kunde.dk/api/search"
// does.
//
// Applied LAST, after the credential rules, so `https://user:pass@host` is
// caught as a credential before it is reduced to a path.
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)]+/gi;

// How much free text may go out per field. A truncated error message is still
// the most useful thing in an incident; an untruncated one is an unbounded
// amount of somebody's system going to a third party.
const MAX_TEXT = 600;
const MAX_EVIDENCE_LINES = 20;
const MAX_TIMELINE = 30;
const MAX_OBSERVATIONS = 40;

const text = (value, max = MAX_TEXT) => {
  if (value === null || value === undefined) return null;
  let out = String(value);
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  // Every URL left in the prose reduced to its path shape.
  out = out.replace(URL_IN_TEXT, (match) => endpoint(match) || '');
  return out.length > max ? `${out.slice(0, max)}…` : out;
};

// An identifier that is safe to send: a number, or null. Never a string that
// could be anything. Ids are useful to the model for referring to things and
// carry nothing about the customer.
const id = (value) => numOrNull(value);

// One of a fixed set, or null. Used for every enum-shaped field, so a value the
// database grows later cannot be forwarded just because it was stored.
const oneOf = (value, allowed) => (allowed.includes(value) ? value : null);

const LAYERS = ['browser', 'page', 'api', 'application', 'server', 'network', 'infrastructure', 'assurance'];
const OUTCOMES = ['ok', 'bad', 'unknown'];
const SEVERITIES = ['INFO', 'WARN', 'CRIT'];
const STATUSES = ['open', 'investigating', 'identified', 'resolved', 'closed'];
const IMPACTS = ['low', 'medium', 'high', 'critical'];
const CRITICALITIES = ['low', 'normal', 'high', 'critical'];
const SOURCES = ['run', 'sweep', 'correlation', 'rule', 'person', 'notification'];
const BASES = ['observed', 'inferred', 'unobservable'];

// A URL reduced to what an analysis actually needs: the path SHAPE, and nothing
// else.
//
// The HOST goes, for the reason given at URL_IN_TEXT. The query string goes
// entirely — it is where identifiers and tokens live, and an endpoint is not a
// different endpoint because it was called with a different filter. Path
// segments that are identifiers are collapsed, for the same reason the service
// map collapses them: /api/customers/4711 and /api/customers/4712 are one
// endpoint, and the number is somebody's customer.
function endpoint(rawUrl) {
  const raw = String(rawUrl === null || rawUrl === undefined ? '' : rawUrl).trim();
  if (!raw) return null;
  let url;
  // Not a URL at all — a selector, a step label, a bare host. Scrubbed as text
  // rather than forwarded, and capped.
  try { url = new URL(raw); } catch { return plain(raw, 120); }
  const path = url.pathname.split('/').map((segment) => {
    if (!segment) return segment;
    if (/^\d+$/.test(segment)) return '{id}';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return '{uuid}';
    if (/^[0-9a-f]{16,}$/i.test(segment)) return '{hash}';
    return segment;
  }).join('/');
  return path || '/';
}

// Scrubbed text with no URL reduction — used by `endpoint` for things that are
// not URLs, so the two do not call each other in a loop.
function plain(value, max) {
  let out = String(value);
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

// ------------------------------------------------------------- the builders
//
// Each one lists, by name, everything it forwards. Adding a field is a decision
// somebody makes on purpose and a reviewer can see in a diff.

function observationContext(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  return {
    layer: oneOf(o.layer, LAYERS),
    kind: text(o.kind, 64),
    // The SUBJECT is usually a URL. Reduced to host + path shape.
    subject: endpoint(o.subject),
    outcome: oneOf(o.outcome, OUTCOMES),
    value: numOrNull(o.value),
    unit: text(o.unit, 32),
    summary: text(o.summary, 200),
    // `detail` is deliberately NOT forwarded. It is an open JSON column that
    // detectors write freely — exactly the shape that makes an allowlist
    // necessary. Two fields out of it are, by name.
    status: numOrNull(o.detail && o.detail.status),
  };
}

function incidentContext(raw) {
  const i = (raw && typeof raw === 'object') ? raw : {};
  return {
    id: id(i.id),
    reference: text(i.reference, 32),
    // The LABEL, which an operator wrote, not subject_key, which encodes a host
    // and port. A host name is customer infrastructure and the analysis does not
    // need it to be useful.
    subject: text(i.subject_label, 120),
    subject_type: text(i.subject_type, 32),
    kind: text(i.kind, 64),
    severity: oneOf(i.severity, SEVERITIES),
    status: oneOf(i.status, STATUSES),
    summary: text(i.summary),
    likely_cause: text(i.likely_cause, 200),
    explanation: text(i.explanation),
    correlated_layer: oneOf(i.correlated_layer, LAYERS),
    confidence: numOrNull(i.confidence),
    impact: oneOf(i.impact, IMPACTS),
    impact_reason: text(i.impact_reason, 300),
    occurrences: numOrNull(i.occurrences),
    opened_at: i.opened_at instanceof Date ? i.opened_at.toISOString() : text(i.opened_at, 40),
    // Evidence is free text written by detectors. Capped and scrubbed, and the
    // most likely place in the whole object for a token to be echoed.
    evidence: (Array.isArray(i.evidence) ? i.evidence : [])
      .slice(0, MAX_EVIDENCE_LINES)
      .map((line) => text(typeof line === 'string' ? line : (line && line.summary), 300))
      .filter(Boolean),
  };
}

function timelineContext(events) {
  return (Array.isArray(events) ? events : [])
    .slice(0, MAX_TIMELINE)
    .map((raw) => {
      const e = (raw && typeof raw === 'object') ? raw : {};
      return {
        kind: text(e.kind, 64),
        summary: text(e.summary, 200),
        source: oneOf(e.source, SOURCES),
        at: e.occurred_at instanceof Date ? e.occurred_at.toISOString() : text(e.occurred_at, 40),
        // `actor_id` is NOT forwarded. Which person picked an incident up is not
        // something a provider needs, and it is personal data.
      };
    });
}

function correlationContext(raw) {
  const c = (raw && typeof raw === 'object') ? raw : null;
  if (!c) return null;
  return {
    layer: oneOf(c.layer, LAYERS),
    conclusion: text(c.conclusion, 200),
    confidence: numOrNull(c.confidence),
    failed: (Array.isArray(c.failed) ? c.failed : []).filter((l) => LAYERS.includes(l)),
    ruled_out: (Array.isArray(c.ruled_out) ? c.ruled_out : []).filter((l) => LAYERS.includes(l)),
    not_checked: (Array.isArray(c.not_checked) ? c.not_checked : []).filter((l) => LAYERS.includes(l)),
    chain: (Array.isArray(c.chain) ? c.chain : []).slice(0, MAX_OBSERVATIONS).map((link) => ({
      step: text(link && link.step, 200),
      layer: oneOf(link && link.layer, LAYERS),
      outcome: oneOf(link && link.outcome, OUTCOMES),
    })),
  };
}

function rootCauseContext(raw) {
  const r = (raw && typeof raw === 'object') ? raw : null;
  if (!r) return null;
  return {
    summary: text(r.summary, 300),
    decisive: r.decisive === true,
    not_checked: (Array.isArray(r.not_checked) ? r.not_checked : []).filter((l) => LAYERS.includes(l)),
    candidates: (Array.isArray(r.candidates) ? r.candidates : []).slice(0, 10).map((c) => ({
      cause: text(c && c.cause, 40),
      label: text(c && c.label, 120),
      // The BASIS travels with it. A model told "the database, 25%" alongside
      // "TLS, 90%" without knowing one was watched and the other supposed will
      // write a summary that presents both as findings.
      basis: oneOf(c && c.basis, BASES),
      likelihood: numOrNull(c && c.likelihood),
      why: (Array.isArray(c && c.why) ? c.why : []).slice(0, 6).map((line) => text(line, 200)).filter(Boolean),
    })),
  };
}

function recurrenceContext(raw) {
  const r = (raw && typeof raw === 'object') ? raw : null;
  if (!r) return null;
  return {
    occurrences: numOrNull(r.occurrences),
    span_days: numOrNull(r.span_days),
    flapping: r.flapping === true,
    chronic: r.chronic === true,
    summary: text(r.summary, 300),
    rhythm: r.rhythm && r.rhythm.confident ? text(r.rhythm.detail, 120) : null,
  };
}

// ------------------------------------------------------------------- entry
//
// The context for "explain this incident". Everything the model sees, and
// nothing else.
function incidentAnalysisContext(rawInput = {}) {
  // A default parameter covers `undefined` and nothing else.
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  const incident = incidentContext(input.incident);
  if (incident.id === null && !incident.summary) return null;

  return {
    // What the model is being asked about, and the rules it answers under. The
    // task string is matched on by the caller, so it is fixed rather than free.
    task: 'explain_incident',
    incident,
    // The rule-based analysis, so the model can explain what BlueEyes already
    // concluded rather than forming an independent opinion nobody can check.
    correlation: correlationContext(input.correlation),
    root_cause: rootCauseContext(input.rootCause),
    recurrence: recurrenceContext(input.recurrence),
    timeline: timelineContext(input.timeline),
    observations: (Array.isArray(input.observations) ? input.observations : [])
      .slice(0, MAX_OBSERVATIONS)
      .map(observationContext),
    // Named so the model is not left to guess whether silence means healthy.
    service: {
      name: text(input.applicationName, 120),
      // NOT the base URL. The host is the customer's infrastructure and an
      // explanation does not need it.
      criticality: oneOf(input.criticality, CRITICALITIES),
    },
  };
}

// The context for "suggest a test worth having". Much smaller: a suggestion
// needs to know what a journey does, not what went wrong with it.
function testSuggestionContext(rawInput = {}) {
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  return {
    task: 'suggest_tests',
    service: { name: text(input.applicationName, 120) },
    // What is already covered, so it does not propose what exists.
    existing_journeys: (Array.isArray(input.journeys) ? input.journeys : []).slice(0, 40).map((j) => ({
      name: text(j && j.name, 120),
      criticality: oneOf(j && j.criticality, CRITICALITIES),
      health: text(j && j.health && j.health.status, 20),
    })),
    // What discovery saw. Pages and forms by SHAPE — never a field value, and
    // never a form's contents.
    discovered: (Array.isArray(input.pages) ? input.pages : []).slice(0, 60).map((p) => ({
      url: endpoint(p && p.url),
      title: text(p && p.title, 120),
      status: numOrNull(p && p.http_status),
    })),
    // Endpoints that have actually failed, so a suggestion can be about
    // something that demonstrably breaks.
    failing_endpoints: (Array.isArray(input.failingEndpoints) ? input.failingEndpoints : [])
      .slice(0, 20)
      .map((e) => ({ endpoint: endpoint(e && e.label), failures: numOrNull(e && e.failures) })),
  };
}

module.exports = {
  incidentAnalysisContext, testSuggestionContext,
  // Exported for the specs, and for anything else that has to forward free text.
  scrub: (value, max) => text(value, max),
  endpoint,
  SCRUBBERS, MAX_TEXT, MAX_EVIDENCE_LINES, MAX_TIMELINE, MAX_OBSERVATIONS,
};
