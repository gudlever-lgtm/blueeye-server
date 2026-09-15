'use strict';

// The module's own surface — swept, not listed.
//
// Two things rot quietly in a module this size: an export nothing requires any
// more (dead code that still has to be read, reviewed and kept compiling), and a
// catalogue entry that declares something no code reads (a security field that
// looks enforced and is not — `hostFields` was exactly that until this suite
// caught it).
//
// So this file does not test a function. It reads the source tree and asserts
// that every export has a caller and every declaration has a reader.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const { typeMeta, TYPE_NAMES, catalogue, secretFields, defaultsFor } = require('../types');
const { createMonitorRunner } = require('../registry');
const { KIND, STATUS } = require('../result');
const { IMMEDIATE, OUTAGE, ADVISORY, EXPLANATION } = require('../policy');

// Every .js file in the repo, minus node_modules — the haystack.
function allSources() {
  const out = new Map();
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.set(full, fs.readFileSync(full, 'utf8'));
    }
  }(ROOT));
  return out;
}

const SOURCES = allSources();

// The files this sweep owns: the monitors module plus the two files that exist
// only for it.
const OWNED = [...SOURCES.keys()].filter((f) => {
  const rel = path.relative(ROOT, f);
  if (rel.includes('__tests__')) return false;
  return /^src[/\\]serviceTests[/\\](monitors[/\\]|validation[/\\]monitors\.js|storage[/\\]monitor)/.test(rel);
});

test('the sweep found the module — a path change must not quietly empty it', () => {
  assert.ok(OWNED.length >= 14, `only ${OWNED.length} files swept`);
});

test('every export has a caller — no dead code carried along', () => {
  const dead = [];
  for (const file of OWNED) {
    const source = SOURCES.get(file);
    const match = source.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
    assert.ok(match, `${path.relative(ROOT, file)} exports nothing the sweep can read`);
    const names = match[1]
      .split(',')
      .map((part) => part.split(':')[0].trim())
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));

    const base = path.basename(file, '.js');
    for (const name of names) {
      const used = [...SOURCES.entries()].some(([other, text]) => {
        if (other === file) return false;
        // Only a file that REQUIRES this module counts: an identifier with the
        // same name somewhere else in a 100k-line repo is not a use of this
        // export, and counting it would make the sweep say "fine" about
        // anything named `ok` or `check`.
        const requires = new RegExp(`require\\([^)]*${base}['"\\)]`).test(text);
        return requires && new RegExp(`\\b${name}\\b`).test(text);
      });
      if (!used) dead.push(`${path.relative(ROOT, file)} :: ${name}`);
    }
  }
  assert.deepEqual(dead, [], `exported but never required:\n  ${dead.join('\n  ')}`);
});

test('every catalogue entry is complete, and every declaration has a reader', () => {
  const runner = createMonitorRunner({});
  for (const type of TYPE_NAMES) {
    const meta = typeMeta(type);
    assert.ok(meta.label && meta.category, `${type} has no label/category`);
    assert.ok(typeof runner.checkers[type].check === 'function', `${type} has no checker`);
    assert.ok(meta.layer && meta.kind, `${type} produces no observation`);
    assert.ok(Number.isInteger(meta.defaultIntervalSec), `${type} has no default interval`);

    // The target field must exist and must be required — it is what the row,
    // the incident subject and the list screen are named after.
    const target = meta.fields[meta.target];
    assert.ok(target, `${type}: target "${meta.target}" is not a field`);
    assert.equal(target.required, true, `${type}: the target field must be required`);

    // A declared secret must be a field, and must be typed as one.
    for (const secret of secretFields(type)) {
      assert.ok(meta.fields[secret], `${type}: secret "${secret}" is not a field`);
      assert.equal(meta.fields[secret].type, 'secret', `${type}: "${secret}" is listed as a secret but typed ${meta.fields[secret].type}`);
    }

    // `hostFields` is a SECURITY declaration: the validator deny-lists every
    // field named here. A name that is not a field means a control that does
    // nothing, which is worse than no control at all because it reads as one.
    for (const field of (meta.hostFields || [])) {
      assert.ok(meta.fields[field], `${type}: hostField "${field}" is not a field`);
    }
    // And the other direction: a field typed as a host must be declared, so the
    // two checks can never disagree about what is a host.
    for (const [name, spec] of Object.entries(meta.fields)) {
      if (spec.type === 'host' || spec.type === 'domain') {
        assert.ok((meta.hostFields || []).includes(name), `${type}: "${name}" is a host field but is not in hostFields`);
      }
    }
    // `showWhen` is a DISPLAY rule the form obeys: it hides a field that does
    // not apply (a DKIM selector on an SPF check). A rule that points at a field
    // that does not exist, or at a value that field can never hold, hides
    // nothing — or hides it forever, which is worse because the field then
    // cannot be filled in at all.
    for (const [name, spec] of Object.entries(meta.fields)) {
      if (!spec.showWhen) continue;
      const controller = meta.fields[spec.showWhen.field];
      assert.ok(controller, `${type}.${name}: showWhen points at "${spec.showWhen.field}", which is not a field`);
      assert.ok(Array.isArray(spec.showWhen.in) && spec.showWhen.in.length, `${type}.${name}: showWhen has no values`);
      for (const value of spec.showWhen.in) {
        if (controller.type === 'enum') {
          assert.ok(controller.values.includes(value), `${type}.${name}: showWhen waits for ${spec.showWhen.field}=${value}, which it can never be`);
        } else if (controller.type === 'boolean') {
          assert.equal(typeof value, 'boolean', `${type}.${name}: showWhen compares a boolean field to ${JSON.stringify(value)}`);
        }
      }
      assert.ok(!spec.required, `${type}.${name}: a field that is sometimes hidden cannot be required`);
    }

    // Defaults must be inside the bounds they are declared with, or the form
    // opens on a value the validator refuses.
    for (const [name, spec] of Object.entries(meta.fields)) {
      if (spec.default === undefined) continue;
      if (spec.type === 'int') {
        assert.ok(Number.isInteger(spec.default), `${type}.${name}: default is not an integer`);
        if (spec.min !== undefined) assert.ok(spec.default >= spec.min, `${type}.${name}: default below min`);
        if (spec.max !== undefined) assert.ok(spec.default <= spec.max, `${type}.${name}: default above max`);
      }
      if (spec.type === 'enum') assert.ok(spec.values.includes(spec.default), `${type}.${name}: default is not one of its values`);
    }
    assert.deepEqual(
      Object.keys(defaultsFor(type)).filter((k) => !meta.fields[k]), [],
      `${type}: a default for a field that does not exist`
    );
  }
});

test('the catalogue the API serves says the same thing as the catalogue the code reads', () => {
  const served = catalogue();
  assert.equal(served.length, TYPE_NAMES.length);
  for (const entry of served) {
    const meta = typeMeta(entry.type);
    assert.equal(entry.label, meta.label);
    assert.equal(entry.target, meta.target);
    assert.deepEqual(entry.secrets, secretFields(entry.type));
    assert.deepEqual(entry.fields.map((f) => f.field), Object.keys(meta.fields));
    // The form cannot hide what it is not told about.
    for (const field of entry.fields) {
      const spec = meta.fields[field.field];
      if (spec.showWhen) assert.deepEqual(field.show_when, { field: spec.showWhen.field, in: spec.showWhen.in });
      else assert.equal(field.show_when, null);
    }
    // Nothing in the served catalogue may be a function or undefined: it is
    // JSON on the wire, and a function silently becomes nothing.
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(entry)));
    assert.ok(!JSON.stringify(entry).includes('undefined'), `${entry.type} serves an undefined`);
  }
});

test('every failure kind is classified and explained — a new one cannot arrive unnoticed', () => {
  const structural = new Set([KIND.SLOW, KIND.MAIL_SLOW, KIND.UNREACHABLE, KIND.MISCONFIGURED]);
  for (const kind of Object.values(KIND)) {
    assert.ok(EXPLANATION[kind], `${kind} has no explanation`);
    if (structural.has(kind)) continue;
    const classified = IMMEDIATE.has(kind) || OUTAGE.has(kind) || ADVISORY.has(kind);
    assert.ok(classified, `${kind} is in no severity bucket — it would default to WARN by accident`);
  }
  // A kind cannot be both an outage and advisory: the two decide opposite
  // severities, and whichever branch ran first would silently win.
  for (const kind of OUTAGE) assert.ok(!ADVISORY.has(kind), `${kind} is both an outage and advisory`);
});

test('the status vocabulary the checkers use is the one the database column accepts', () => {
  const migration = fs.readFileSync(path.join(ROOT, 'migrations', '094_create_service_monitors.sql'), 'utf8');
  const column = migration.match(/status\s+ENUM\(([^)]+)\)/i);
  assert.ok(column, 'the results table has no status enum');
  const allowed = column[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
  for (const status of Object.values(STATUS)) {
    assert.ok(allowed.includes(status), `the checkers can return "${status}" and the column cannot store it`);
  }
});
