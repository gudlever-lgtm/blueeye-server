'use strict';

const {
  SECTIONS, isSection, defaultsFor, allDefaults, validateSection, mergeSection, label,
} = require('./defaults');

// Effective Service Tests settings: the shipped defaults with the database
// override merged on top. Every limit the module enforces — discovery budgets,
// the allowlist address cap, runner timeouts, artefact retention — is read
// through here, so there is exactly one place that decides what a limit is and
// it is backed by a table rather than an env var.
//
// Reads are cached for `ttlMs` because the runner asks for a limit on every step;
// a write busts the cache immediately, so an operator's change is visible on the
// next read rather than up to a TTL later.
function createServiceTestSettings({ repo, ttlMs = 30000, now = () => Date.now() }) {
  let cache = null;
  let cachedAt = 0;

  function invalidate() { cache = null; cachedAt = 0; }

  async function loadOverrides() {
    if (cache && now() - cachedAt < ttlMs) return cache;
    let stored = {};
    try {
      stored = (await repo.getAll()) || {};
    } catch {
      // A read failure must not take the module down — fall back to defaults.
      stored = {};
    }
    cache = stored;
    cachedAt = now();
    return cache;
  }

  // Effective values for one section.
  async function get(section) {
    if (!isSection(section)) return null;
    const stored = await loadOverrides();
    return mergeSection(section, stored[section]);
  }

  // Effective values for every section.
  async function getAll() {
    const stored = await loadOverrides();
    const out = {};
    for (const s of SECTIONS) out[s] = mergeSection(s, stored[s]);
    return out;
  }

  // Applies a partial patch to one section. Returns { value } (the new effective
  // section) or { errors } — the validator contract, so a route can hand the
  // errors straight to the 400 response.
  async function set(section, patch, updatedBy = null) {
    const { value, errors } = validateSection(section, patch);
    if (errors) return { errors };
    const stored = await loadOverrides();
    const merged = { ...mergeSection(section, stored[section]), ...value };
    await repo.set(section, merged, updatedBy);
    invalidate();
    return { value: merged };
  }

  // Drops the override for a section, returning it to the shipped defaults.
  async function reset(section, updatedBy = null) {
    if (!isSection(section)) return { errors: { section: `unknown settings section "${label(section)}"` } };
    await repo.set(section, {}, updatedBy);
    invalidate();
    return { value: defaultsFor(section) };
  }

  return { get, getAll, set, reset, invalidate, sections: SECTIONS, defaults: allDefaults };
}

module.exports = { createServiceTestSettings };
