'use strict';

// What an alert needs to be acted on from a phone: WHICH machine, by name, and
// a link that opens the record in the dashboard. The channels used to send
// "link.errors on host 12" with no way back in — the reader had to open the
// dashboard, find Events, and search for agent 12.
//
//   const ctx = createAlertContext({ publicUrl, agentsRepo });
//   const extra = await ctx.enrich(subject); // { hostName, link }
//
// Pure apart from the injected agent lookup, which is cached briefly so a burst
// of alerts does not become a burst of queries. Best-effort by construction: a
// failed lookup costs the name, never the alert.

const silentLogger = { info() {}, warn() {}, error() {} };
const NAME_TTL_MS = 60 * 1000;
const MAX_CLUSTER_NAMES = 5;

// A base URL is only used when it is an absolute http(s) URL; anything else
// would produce a link that does not open, which is worse than none.
function normaliseBase(url) {
  if (!url || typeof url !== 'string') return null;
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The dashboard path for a subject: its situation, its event, or its agent —
// the most specific record that exists. Paths match public/routes.js.
function pathFor(subject) {
  if (!subject) return null;
  const cluster = positiveInt(subject.clusterId);
  if (cluster != null) return `/situations/${cluster}`;
  const event = positiveInt(subject.eventCaseId);
  if (event != null) return `/events/${event}`;
  const agent = positiveInt(subject.hostId);
  if (agent != null) return `/agents/${agent}`;
  return null;
}

function createAlertContext({ publicUrl = null, agentsRepo = null, logger = silentLogger, now = () => Date.now() } = {}) {
  const names = new Map(); // agentId -> { name, at }

  async function agentName(id) {
    const n = positiveInt(id);
    if (n == null || !agentsRepo || typeof agentsRepo.findById !== 'function') return null;
    const hit = names.get(n);
    if (hit && now() - hit.at < NAME_TTL_MS) return hit.name;
    let name = null;
    try {
      const a = await agentsRepo.findById(n);
      name = a ? (a.display_name || a.hostname || null) : null;
    } catch (err) {
      logger.warn(`alerting: could not resolve agent ${n} (${err && err.message})`);
    }
    names.set(n, { name, at: now() });
    return name;
  }

  async function enrich(subject) {
    const out = { hostName: null, link: null };
    if (!subject) return out;
    const base = normaliseBase(typeof publicUrl === 'function' ? publicUrl() : publicUrl);
    const path = pathFor(subject);
    if (base && path) out.link = base + path;

    if (positiveInt(subject.clusterId) != null) {
      // A situation spans agents: name them (a few), from the members.
      const ids = [...new Set((Array.isArray(subject.evidence) ? subject.evidence : [])
        .map((e) => positiveInt(e && e.host)).filter((x) => x != null))];
      const resolved = [];
      for (const id of ids.slice(0, MAX_CLUSTER_NAMES)) {
        // eslint-disable-next-line no-await-in-loop
        resolved.push((await agentName(id)) || `agent ${id}`);
      }
      if (resolved.length) {
        out.hostName = resolved.join(', ') + (ids.length > resolved.length ? ` +${ids.length - resolved.length}` : '');
      }
    } else {
      out.hostName = await agentName(subject.hostId);
    }
    return out;
  }

  return { enrich };
}

// "core-sw-1 (#12)" when the name is known, "host 12" when it is not — the
// one label every channel prints.
function hostLabel(subject) {
  const id = subject && subject.hostId != null ? String(subject.hostId) : '–';
  if (subject && subject.hostName) {
    return positiveInt(subject.hostId) != null ? `${subject.hostName} (#${id})` : subject.hostName;
  }
  return positiveInt(id) != null ? `host ${id}` : id;
}

module.exports = { createAlertContext, pathFor, normaliseBase, hostLabel };
