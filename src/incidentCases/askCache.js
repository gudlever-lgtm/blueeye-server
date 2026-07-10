'use strict';

const crypto = require('crypto');

// Short-lived in-memory cache for incident assistant answers, keyed by
// incident + question hash, so repeated identical questions don't re-hit Mistral.
// Best-effort and bounded; entries expire after ttlMs. Injected clock for tests.

function hashQuestion(question) {
  return crypto.createHash('sha256').update(String(question == null ? '' : question).trim()).digest('hex');
}

function createAskCache({ ttlMs = 5 * 60 * 1000, now = () => Date.now(), max = 500 } = {}) {
  const map = new Map(); // key -> { value, at }

  function keyFor(incidentId, question) {
    return `${incidentId}:${hashQuestion(question)}`;
  }

  function get(incidentId, question) {
    const k = keyFor(incidentId, question);
    const entry = map.get(k);
    if (!entry) return null;
    if (now() - entry.at > ttlMs) { map.delete(k); return null; }
    return entry.value;
  }

  function set(incidentId, question, value) {
    if (map.size >= max) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(keyFor(incidentId, question), { value, at: now() });
  }

  return { get, set, hashQuestion };
}

module.exports = { createAskCache, hashQuestion };
