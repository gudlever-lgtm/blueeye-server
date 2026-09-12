'use strict';

const { numOrNull } = require('../storage/shape');

// Alert correlation and deduplication (V3 Phase 3, docs/service-assurance-v3.md
// §"Alerting").
//
//     One cause producing three symptoms is one incident, not three alerts.
//
// The reactor already dedups per SUBJECT: one open incident per thing, however
// many times it fails. This is the layer above that, and it is a different
// question — several DIFFERENT subjects failing for one reason.
//
//     /api/auth starts returning 500
//       → "Sign in" fails
//       → "Find customer" fails
//       → "Place order" fails
//
// That is four incidents and one problem. Sent as four alerts at 03:00 it is
// four pages to four phones about one thing, and the fourth teaches whoever is
// carrying the phone to stop reading them.
//
// PURE: open incidents and what is known about the service in, alert groups out.
// No database, no clock beyond the `now` handed in, no sending.
//
// Four rules:
//
//   1. GROUPING IS EVIDENCE, NOT GUESSWORK. Two incidents are the same problem
//      because something OBSERVED links them — a dependency they both failed on,
//      the same fault on the same host, the same correlated layer at the same
//      moment. Grouping on "they happened near each other" would eventually
//      swallow an unrelated outage, and nobody would ever find out that it had.
//   2. NOTHING IS EVER SUPPRESSED SILENTLY. A symptom folded into a group is
//      still NAMED in that group's alert. The point is one page instead of four,
//      never three problems nobody was told about.
//   3. A GROUP TAKES THE WORST SEVERITY IN IT, and the highest criticality. A
//      critical journey failing as a "symptom" of something is still a critical
//      journey failing.
//   4. When in doubt, it is its own group. An incident that cannot be linked to
//      anything alerts on its own — which is the behaviour without this module
//      at all, and the right thing to fall back to.

const SEVERITY_RANK = { INFO: 1, WARN: 2, CRIT: 3 };
const CRITICALITY_RANK = { low: 1, normal: 2, high: 3, critical: 4 };

// How two incidents can be linked, strongest first. The reason is carried into
// the alert, because "these are the same problem" is a claim and the operator
// has to be able to check it.
const LINK = {
  // Both failed on an endpoint that the dependency analysis says they share.
  // The strongest link there is: something observed connects them.
  DEPENDENCY: 'shared_dependency',
  // Same fault on the same host — a certificate, a name that stopped resolving.
  HOST: 'same_host',
  // The correlation engine put both at the same layer, within the window. The
  // weakest of the three, and the one that needs the window to mean anything.
  LAYER: 'same_layer',
};

// Faults that are about the HOST itself rather than about something running on
// it. A certificate, a name that stopped resolving, a connection that was
// refused: those are one fault however many journeys trip over them.
//
// An HTTP 500 is NOT on this list, and that is the important half. Two journeys
// getting a 500 from the same host may well be two different bugs in two
// different endpoints — and on a monitor watching one application, nearly every
// incident shares a host, so grouping on that alone would fold the whole estate
// into one alert. Over-grouping is the dangerous direction: it hides a real
// outage inside somebody else's and nobody ever finds out.
const HOST_LEVEL_KINDS = new Set([
  'certificate_expiring', 'certificate_expired', 'certificate_invalid',
  'dns_failure', 'tls_failure', 'connection_refused', 'blocked_by_policy',
]);

// How close in time two incidents have to be for the layer link to be worth
// anything. Half an hour is generous for a synthetic monitor — everything on one
// schedule lands within minutes — and the link is the weakest one here, so the
// window is what stops it grouping this morning's outage with last night's.
const LAYER_WINDOW_MS = 30 * 60000;

const text = (v) => (v === null || v === undefined ? '' : String(v));
const asDate = (v) => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const worstSeverity = (list) => list.reduce((worst, s) => ((SEVERITY_RANK[s] || 0) > (SEVERITY_RANK[worst] || 0) ? s : worst), 'INFO');
const topCriticality = (list) => list.reduce((top, c) => ((CRITICALITY_RANK[c] || 0) > (CRITICALITY_RANK[top] || 0) ? c : top), 'low');

// Which endpoints an incident is known to have failed on.
//
// Read from what the incident RECORDED, never re-derived: the incident carries
// the evidence it was opened with, and re-deriving from today's data would group
// on facts that were not true at the time.
function endpointsOf(rawIncident) {
  // Exported, so it is called by things this file does not control.
  const incident = (rawIncident && typeof rawIncident === 'object') ? rawIncident : {};
  const out = new Set();
  const evidence = Array.isArray(incident.evidence) ? incident.evidence : [];
  for (const line of evidence) {
    const found = text(typeof line === 'string' ? line : (line && line.summary)).match(/https?:\/\/[^\s"')]+/g);
    for (const url of found || []) out.add(url);
  }
  for (const journey of (Array.isArray(incident.affected_journeys) ? incident.affected_journeys : [])) {
    if (journey && journey.endpoint) out.add(String(journey.endpoint));
  }
  return out;
}

// The host an incident is about, when it is about one.
function hostOf(rawIncident) {
  const incident = (rawIncident && typeof rawIncident === 'object') ? rawIncident : {};
  const key = text(incident.subject_key);
  // The reactor writes `certificate:<application_id>:<host>:<port>`.
  //
  // This read the SECOND segment and got the application id. Two certificates on
  // different hosts of the same application both came back as "1", and with the
  // same kind they grouped into one alert reading "the same certificate_expiring
  // on 1" — over-grouping, which is the dangerous direction, plus a message that
  // means nothing.
  //
  // The spec that was supposed to catch it used `certificate:portal.kunde.dk:443`
  // as its fixture — a shape nothing produces — so it confirmed the wrong parser
  // against invented data. The fixture now comes from the reactor.
  //
  // Segments are searched for one that looks like a host rather than counted,
  // because a positional read is what broke here and would break again the next
  // time the key gains a part.
  if (/^certificate:/.test(key)) {
    const host = key.split(':').slice(1).find((part) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(part));
    return host ? host.toLowerCase() : null;
  }
  for (const line of (Array.isArray(incident.evidence) ? incident.evidence : [])) {
    const url = text(typeof line === 'string' ? line : (line && line.summary)).match(/https?:\/\/([^/\s"')]+)/);
    if (url) return url[1].toLowerCase();
  }
  return null;
}

// Is there OBSERVED evidence that these two are the same problem?
//
// Returns the link and why, or null. Null is the common answer and the right
// default: an incident that cannot be linked alerts on its own.
function linkBetween(a, b, rawOptions = {}) {
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return null;
  const { sharedEndpoints = new Map() } =
    (rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)) ? rawOptions : {};

  // 1. A dependency the dependency analysis says they share, and that is failing.
  const aEndpoints = endpointsOf(a);
  const bEndpoints = endpointsOf(b);
  for (const [endpoint, dep] of sharedEndpoints) {
    const inA = [...aEndpoints].some((u) => u.includes(endpoint));
    const inB = [...bEndpoints].some((u) => u.includes(endpoint));
    if (inA && inB) {
      return { link: LINK.DEPENDENCY, why: `both failed on ${dep.label || endpoint}, which ${dep.journey_count || 2} journeys depend on` };
    }
  }

  // 2. The same HOST-LEVEL fault on the same host. Restricted to the faults
  //    that are about the host itself — see HOST_LEVEL_KINDS.
  const aHost = hostOf(a);
  const bHost = hostOf(b);
  if (aHost && aHost === bHost && text(a.kind) && text(a.kind) === text(b.kind)
    && HOST_LEVEL_KINDS.has(text(a.kind))) {
    return { link: LINK.HOST, why: `the same ${a.kind} on ${aHost}` };
  }

  // 3. The same layer, close in time. The weakest link, and the only one that
  //    needs a window: without it this would group an outage with last night's.
  const aLayer = text(a.correlated_layer);
  const bLayer = text(b.correlated_layer);
  if (aLayer && aLayer === bLayer) {
    const aAt = asDate(a.opened_at);
    const bAt = asDate(b.opened_at);
    if (aAt && bAt && Math.abs(aAt - bAt) <= LAYER_WINDOW_MS) {
      return { link: LINK.LAYER, why: `both were traced to the ${aLayer} layer within half an hour of each other` };
    }
  }
  return null;
}

// Group what is open into the alerts that should actually be sent.
//
//   groupAlerts({ incidents, dependencies, now })
//     -> { groups: [...], alerts: <count>, suppressed: <count>, ... }
function groupAlerts(rawInput = {}) {
  // A default parameter covers `undefined` and nothing else.
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  const incidents = (Array.isArray(input.incidents) ? input.incidents : [])
    .filter((i) => i && typeof i === 'object');
  const now = asDate(input.now) || new Date();

  // The failing shared dependencies, keyed by the endpoint text that appears in
  // an incident's evidence. Only FAILING ones: an endpoint three journeys share
  // and that has never failed does not explain anything.
  const sharedEndpoints = new Map();
  const dependencies = (input.dependencies && typeof input.dependencies === 'object') ? input.dependencies : {};
  for (const dep of (Array.isArray(dependencies.failing) ? dependencies.failing : [])) {
    if (!dep || !dep.label) continue;
    sharedEndpoints.set(String(dep.label), dep);
  }

  // Union-find over the incidents, one link at a time. Transitive on purpose: if
  // A links to B and B links to C, all three are one problem — which is what
  // "three symptoms of one cause" means.
  const parent = incidents.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { const a = find(i); const b = find(j); if (a !== b) parent[b] = a; };
  const reasons = new Map();

  for (let i = 0; i < incidents.length; i += 1) {
    for (let j = i + 1; j < incidents.length; j += 1) {
      const linked = linkBetween(incidents[i], incidents[j], { sharedEndpoints });
      if (!linked) continue;
      union(i, j);
      const key = find(i);
      if (!reasons.has(key)) reasons.set(key, linked);
    }
  }

  const buckets = new Map();
  for (let i = 0; i < incidents.length; i += 1) {
    const root = find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(incidents[i]);
  }

  const groups = [];
  for (const [root, members] of buckets) {
    // The one the alert is ABOUT. The worst, then the oldest — the first thing
    // that broke is usually the cause, and the ones after it the symptoms.
    const ordered = [...members].sort((a, b) => {
      const bySeverity = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
      if (bySeverity) return bySeverity;
      const aAt = asDate(a.opened_at);
      const bAt = asDate(b.opened_at);
      if (aAt && bAt) return aAt - bAt;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
    const primary = ordered[0];
    const symptoms = ordered.slice(1);
    const reason = members.length > 1 ? (reasons.get(root) || null) : null;

    groups.push({
      // Stable across calls, so a cooldown can be kept against it: the same set
      // of incidents produces the same key however they arrive.
      key: `group:${members.map((m) => m.id).sort((a, b) => Number(a) - Number(b)).join(',')}`,
      primary,
      // Rule 2. Named, always — the point is one page instead of four, never
      // three problems nobody was told about.
      symptoms,
      incidents: ordered,
      // Rule 3. A critical journey failing as a "symptom" is still a critical
      // journey failing.
      severity: worstSeverity(members.map((m) => m.severity)),
      criticality: topCriticality(members.flatMap((m) => (Array.isArray(m.affected_journeys) ? m.affected_journeys : [])
        .map((j) => j && j.criticality).filter(Boolean))),
      // Rule 1, published: WHY these are one problem, so the claim can be
      // checked rather than trusted.
      linked_by: reason ? reason.link : null,
      link_reason: reason ? reason.why : null,
      summary: summarise(primary, symptoms, reason),
      opened_at: ordered.map((m) => asDate(m.opened_at)).filter(Boolean).sort((a, b) => a - b)[0] || null,
    });
  }

  // Worst first, then most symptoms: the biggest thing on fire goes at the top.
  groups.sort((a, b) => ((SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0))
    || (b.symptoms.length - a.symptoms.length)
    || String(a.key).localeCompare(String(b.key)));

  const suppressed = groups.reduce((n, g) => n + g.symptoms.length, 0);
  return {
    groups,
    // What would actually be sent, against what would have been without this.
    alerts: groups.length,
    would_have_been: incidents.length,
    // Folded INTO an alert, never dropped. The word matters: nothing here is
    // hidden, and the count is on the response so a screen can say so.
    folded: suppressed,
    now,
    source: 'rules',
  };
}

function summarise(primary, symptoms, reason) {
  const what = text(primary && primary.subject_label) || text(primary && primary.subject_key) || 'Something';
  if (!symptoms.length) return `${what}: ${text(primary && primary.summary) || 'is failing'}`;
  const names = symptoms.map((s) => text(s.subject_label) || text(s.subject_key)).filter(Boolean);
  const list = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  const because = reason ? ` — ${reason.why}` : '';
  return `${what} is failing, and so ${names.length === 1 ? 'is' : 'are'} ${list}${because}. `
    + `${symptoms.length + 1} incidents, one problem.`;
}

// Should this group be sent NOW?
//
// Separate from the grouping on purpose: grouping is about what is true,
// cooldown is about what was already said. Mixing them makes a group's identity
// depend on when it was last mentioned.
//
// `lastSent` is what was sent for this group's key before, and null when nothing
// was. Returns a decision with a reason, because "why did I not get paged" has
// to have an answer.
function shouldSend(group, rawOptions = {}) {
  // A default parameter covers `undefined` and nothing else — `shouldSend(g,
  // null)` sails past it and throws on the first property read.
  const { lastSent = null, cooldownMs = 15 * 60000, now = new Date() } =
    (rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)) ? rawOptions : {};
  if (!group || typeof group !== 'object') return { send: false, reason: 'no group' };
  const members = Array.isArray(group.incidents) ? group.incidents : [];
  const at = asDate(now) || new Date();
  if (!lastSent || typeof lastSent !== 'object') {
    return { send: true, reason: 'nothing has been sent about this yet' };
  }
  // Escalation always goes through. A WARN that has become a CRIT is new
  // information, and holding it for a cooldown is the one case where silence
  // costs something.
  const before = SEVERITY_RANK[lastSent.severity] || 0;
  const now_ = SEVERITY_RANK[group.severity] || 0;
  if (now_ > before) {
    return { send: true, reason: `it has escalated from ${lastSent.severity} to ${group.severity}` };
  }
  // So does a group that has GROWN. Two more journeys falling over is not the
  // same alert as the one already sent.
  const wasCount = numOrNull(lastSent.incident_count) ?? 0;
  if (members.length > wasCount) {
    return { send: true, reason: `it now affects ${members.length} things, up from ${wasCount}` };
  }
  const since = at - (asDate(lastSent.at) || 0);
  const window = Math.max(0, numOrNull(cooldownMs) ?? 15 * 60000);
  if (since >= window) {
    return { send: true, reason: `nothing has been sent about this for ${Math.round(since / 60000)} minutes` };
  }
  return {
    send: false,
    reason: `the same alert went out ${Math.round(since / 60000)} minutes ago and nothing has changed`,
  };
}

module.exports = {
  groupAlerts, shouldSend, linkBetween, endpointsOf, hostOf,
  LINK, LAYER_WINDOW_MS, HOST_LEVEL_KINDS, SEVERITY_RANK, CRITICALITY_RANK,
};
