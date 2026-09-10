'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SECTIONS, defaultsFor, allDefaults, validateSection, mergeSection,
} = require('../defaults');
const { createServiceTestSettings } = require('../index');

// A minimal stand-in for the settings repository: an in-memory key/JSON store.
function makeRepo(initial = {}) {
  const store = { ...initial };
  return {
    store,
    reads: 0,
    async get(key) { return store[key] ?? null; },
    async getAll() { this.reads += 1; return { ...store }; },
    async set(key, value) { store[key] = value; return value; },
  };
}

// ------------------------------------------------------------------ catalogue
test('every section has defaults and every default is inside its own bounds', () => {
  assert.ok(SECTIONS.length >= 5, `only ${SECTIONS.length} sections`);
  const all = allDefaults();
  for (const section of SECTIONS) {
    const defaults = all[section];
    assert.ok(Object.keys(defaults).length > 0, `${section} has no fields`);
    // Re-validating the defaults must succeed — a default outside its own bounds
    // would silently fall back to itself forever and never be settable.
    const { errors } = validateSection(section, defaults);
    assert.equal(errors, undefined, `${section}: ${JSON.stringify(errors)}`);
  }
});

test('validateSection rejects out-of-bounds, wrong-typed and unknown fields', () => {
  assert.ok(validateSection('discovery', { maxPages: 0 }).errors);
  assert.ok(validateSection('discovery', { maxPages: 100000 }).errors);
  assert.ok(validateSection('discovery', { maxPages: 12.5 }).errors);
  assert.ok(validateSection('discovery', { maxPages: 'many' }).errors);
  assert.ok(validateSection('discovery', { nope: 1 }).errors, 'unknown field must be rejected, not ignored');
  assert.ok(validateSection('nosuchsection', { a: 1 }).errors);
  assert.ok(validateSection('artifacts', { format: 'gif' }).errors);
  assert.ok(validateSection('artifacts', { screenshotOnFailure: 'yes' }).errors);
  assert.deepEqual(validateSection('discovery', { maxPages: 42 }).value, { maxPages: 42 });
});

test('validateSection never throws on garbage input', () => {
  for (const input of [undefined, null, 'str', 42, true, [], () => {}, { __proto__: null }]) {
    assert.doesNotThrow(() => validateSection('discovery', input));
    assert.doesNotThrow(() => validateSection(input, { maxPages: 1 }));
  }
});

test('the allowlist caps are settable but bounded — a range floor below /8 is refused', () => {
  // The address cap is the binding control on how much of a private network one
  // application may reach, so it must be storable but never unbounded.
  assert.ok(validateSection('allowlist', { minCidrPrefix: 4 }).errors, '/4 must be refused');
  assert.ok(validateSection('allowlist', { maxAddressesPerApplication: 0 }).errors);
  assert.ok(validateSection('allowlist', { maxAddressesPerApplication: 99999999 }).errors);
  assert.equal(validateSection('allowlist', { minCidrPrefix: 24 }).value.minCidrPrefix, 24);
  assert.equal(defaultsFor('allowlist').minCidrPrefix, 16);
  assert.equal(defaultsFor('allowlist').maxAddressesPerApplication, 65536);
});

test('mergeSection discards a stored value that is unknown or out of bounds', () => {
  const merged = mergeSection('discovery', { maxPages: 250, maxDepth: 9999, bogus: true });
  assert.equal(merged.maxPages, 250, 'a valid override applies');
  assert.equal(merged.maxDepth, defaultsFor('discovery').maxDepth, 'an out-of-bounds row falls back to the default');
  assert.equal(merged.bogus, undefined, 'an unknown key never reaches the effective settings');
});

test('mergeSection survives a corrupt row', () => {
  for (const stored of [null, undefined, 'garbage', 42, []]) {
    assert.deepEqual(mergeSection('runner', stored), defaultsFor('runner'));
  }
});

// ------------------------------------------------------------------ service
test('get() returns defaults when nothing is stored', async () => {
  const settings = createServiceTestSettings({ repo: makeRepo() });
  assert.deepEqual(await settings.get('discovery'), defaultsFor('discovery'));
  assert.equal(await settings.get('nosuchsection'), null);
});

test('set() persists a patch, merges it over the defaults and returns the effective section', async () => {
  const repo = makeRepo();
  const settings = createServiceTestSettings({ repo });
  const { value, errors } = await settings.set('discovery', { maxPages: 25 }, 7);
  assert.equal(errors, undefined);
  assert.equal(value.maxPages, 25);
  assert.equal(value.maxDepth, defaultsFor('discovery').maxDepth, 'untouched fields keep their default');
  assert.equal(repo.store.discovery.maxPages, 25, 'the override is written to the database');
  assert.deepEqual(await settings.get('discovery'), value);
});

test('set() rejects an invalid patch and writes nothing', async () => {
  const repo = makeRepo();
  const settings = createServiceTestSettings({ repo });
  const { value, errors } = await settings.set('artifacts', { retentionDays: 0 });
  assert.equal(value, undefined);
  assert.ok(errors.retentionDays);
  assert.deepEqual(repo.store, {}, 'a refused patch must not touch the store');
});

test('a write is visible immediately — the read cache is busted, not waited out', async () => {
  const repo = makeRepo();
  const settings = createServiceTestSettings({ repo, ttlMs: 60000 });
  await settings.get('runner');                 // populates the cache
  await settings.set('runner', { concurrency: 8 });
  assert.equal((await settings.get('runner')).concurrency, 8);
});

test('reads are cached inside the TTL and re-read after it', async () => {
  const repo = makeRepo();
  let clock = 1000;
  const settings = createServiceTestSettings({ repo, ttlMs: 500, now: () => clock });
  await settings.get('runner');
  await settings.get('discovery');
  assert.equal(repo.reads, 1, 'a second read inside the TTL must not hit the database');
  clock += 501;
  await settings.get('runner');
  assert.equal(repo.reads, 2);
});

test('a database read failure degrades to defaults instead of taking the module down', async () => {
  const repo = { async getAll() { throw new Error('db gone'); }, async set() {} };
  const settings = createServiceTestSettings({ repo });
  assert.deepEqual(await settings.get('queue'), defaultsFor('queue'));
});

test('reset() drops the override and returns to the shipped defaults', async () => {
  const repo = makeRepo();
  const settings = createServiceTestSettings({ repo });
  await settings.set('runner', { concurrency: 9 });
  const { value } = await settings.reset('runner');
  assert.deepEqual(value, defaultsFor('runner'));
  assert.deepEqual(await settings.get('runner'), defaultsFor('runner'));
  assert.ok(await settings.reset('nope').then((r) => r.errors));
});

test('getAll() reports every section', async () => {
  const settings = createServiceTestSettings({ repo: makeRepo() });
  const all = await settings.getAll();
  assert.deepEqual(Object.keys(all).sort(), [...SECTIONS].sort());
});
