'use strict';

// Guards migration 077 (incident_* → event_* / probe_*) against the two ways a
// big rename goes wrong: leaving a database object still called incident_*, or
// renaming one that has to keep the name (NIS2 / ITSM).
//
// These read the migration SQL and the source tree as text — there is no MySQL
// in the test environment, so this asserts the migration is COMPLETE and
// CONSISTENT rather than that it executes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const RENAME = '077_rename_incidents_to_events.sql';

const rename = fs.readFileSync(path.join(MIGRATIONS, RENAME), 'utf8');
const earlier = fs.readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql') && f < RENAME)
  .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
  .join('\n');

test('every incident_* table is renamed, and the NIS2 one is not', () => {
  const expected = [
    ['incident_cases', 'event_cases'],
    ['incident_notes', 'event_notes'],
    ['incident_clusters', 'event_clusters'],
    ['incident_playbook_runs', 'event_playbook_runs'],
    ['incidents', 'probe_outages'],
    ['incident_thresholds', 'probe_thresholds'],
  ];
  for (const [from, to] of expected) {
    assert.match(rename, new RegExp(`\\b${from}\\s+TO\\s+${to}\\b`), `${from} → ${to} is missing from ${RENAME}`);
  }
  // The directive's own word. Renaming it would change regulator-facing text.
  assert.ok(!/blueeye_nis2_incidents\s+TO\b/.test(rename), 'blueeye_nis2_incidents must NOT be renamed');
});

test('every incident-named index and constraint created earlier is handled', () => {
  // Real object names only — `_` is a word char, so this never matches inside
  // blueeye_nis2_incidents, and the trailing char class rejects prose fragments.
  const names = new Set();
  for (const m of earlier.matchAll(/\b((?:idx|fk|uq)_(?:incident|findings_incident)[a-z0-9_]*[a-z0-9])\b/g)) {
    names.add(m[1]);
  }
  // Sanity: the scan actually found the objects it is meant to guard.
  assert.ok(names.size >= 20, `expected to find the incident_* indexes/FKs, found ${names.size}`);

  const missing = [...names].filter((n) => !rename.includes(n)).sort();
  assert.deepEqual(missing, [], `migration ${RENAME} never mentions: ${missing.join(', ')}`);
});

test('the rename introduces no new incident-named object', () => {
  // Anything on the RIGHT of a rename must be free of the old vocabulary.
  const targets = [
    ...[...rename.matchAll(/RENAME INDEX\s+\S+\s+TO\s+(\S+)/gi)].map((m) => m[1]),
    ...[...rename.matchAll(/ADD CONSTRAINT\s+(\S+)/gi)].map((m) => m[1]),
    ...[...rename.matchAll(/\bTO\s+(event_[a-z_]+|probe_[a-z_]+)\b/g)].map((m) => m[1]),
  ];
  assert.ok(targets.length > 0, 'expected to find rename targets');
  const offenders = targets.filter((t) => /incident/i.test(t));
  assert.deepEqual(offenders, [], `these renames still target an incident_* name: ${offenders.join(', ')}`);
});

test('no source file queries a renamed table', () => {
  const OLD = ['incident_cases', 'incident_notes', 'incident_clusters', 'incident_playbook_runs', 'incident_thresholds', 'incident_case_id'];
  const dirs = ['src', 'public', 'test-support'];
  const offenders = [];

  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const name of OLD) {
        // The audit-category readers legitimately mention the old *category*
        // string, not a table — that history is hash-chained and unrewritable.
        if (new RegExp(`\\b${name}\\b`).test(src)) offenders.push(`${path.relative(ROOT, p)}: ${name}`);
      }
    }
  };
  for (const d of dirs) walk(path.join(ROOT, d));
  assert.deepEqual(offenders, [], `stale table/column references:\n${offenders.join('\n')}`);
});

// The rename renamed `/api/nis2/incidents` to `/api/nis2/events` in the
// dashboard while the router — correctly carved out — kept serving
// `/incidents`, so the whole NIS2 tab 404'd. Nothing caught it: the dashboard
// has no build step and no route-level test. This is that missing check.
test('every /api/nis2/* path the dashboard calls exists on the NIS2 router', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const router = fs.readFileSync(path.join(ROOT, 'src/routes/nis2.js'), 'utf8');

  // Mounted paths, e.g. router.get('/incidents/:id', …) → /incidents/:id
  const mounted = [...router.matchAll(/router\.(?:get|post|put|delete|patch)\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(mounted.length > 10, `expected NIS2 routes, found ${mounted.length}`);

  // Turn a mounted path into a matcher: `:param` matches one segment.
  const matchers = mounted.map((p) => new RegExp(`^${p.replace(/:[^/]+/g, '[^/]+')}$`));

  const called = new Set();
  for (const m of app.matchAll(/['"`]\/api\/nis2(\/[A-Za-z0-9._/-]*)/g)) {
    // A path built by interpolation (`/api/nis2/export/${kind}.html`) can't be
    // checked statically — the literal stops at the `${`.
    if (app.slice(m.index + m[0].length).startsWith('${')) continue;
    let p = m[1];
    if (p.length > 1) p = p.replace(/\/$/, '');
    called.add(p);
  }
  assert.ok(called.size > 5, `expected NIS2 calls in app.js, found ${called.size}`);

  const missing = [...called].filter((p) => !matchers.some((re) => re.test(p))).sort();
  assert.deepEqual(missing, [], `the dashboard calls /api/nis2 paths the router does not serve: ${missing.join(', ')}`);
});

test('the ITSM + NIS2 vocabulary survives untouched', () => {
  // The wire names of integration subscriptions live in customer configs —
  // renaming them would silently unsubscribe live integrations.
  const integrations = fs.readFileSync(path.join(ROOT, 'src/routes/integrations.js'), 'utf8');
  assert.match(integrations, /KNOWN_EVENTS = \['incident', 'anomaly'/);

  const serviceNow = fs.readFileSync(path.join(ROOT, 'src/integrations/connectors/serviceNow.js'), 'utf8');
  assert.match(serviceNow, /defaultEvents = \['incident', 'anomaly'\]/);

  const nis2Repo = fs.readFileSync(path.join(ROOT, 'src/repositories/nis2IncidentsRepository.js'), 'utf8');
  assert.match(nis2Repo, /createNis2IncidentsRepository/);
  assert.match(nis2Repo, /blueeye_nis2_incidents/);
});
