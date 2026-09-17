'use strict';

// scripts/ui-check.js — the contract, enforced (docs/ui-contract.md).
//
// Run for real as part of `npm test`: the point of the lint is that a
// contract violation fails the build, and a lint that only runs when somebody
// remembers is a lint that drifts. The rules themselves are then checked
// against fixtures, so a rule that stops firing is caught too.

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ui-check.js');

function run(args = [], root = ROOT) {
  const script = path.join(root, 'scripts', 'ui-check.js');
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

test('ui:check passes on the codebase as it stands', () => {
  const { code, out } = run();
  assert.equal(code, 0, out);
  assert.match(out, /ui:check — clean/);
});

test('ui:check reports what phase 3 still owes, so the number is visible and shrinking', () => {
  const { out } = run();
  const m = out.match(/phase 3 still owes (\d+) colour literal/);
  // Once phase 3 finishes there is nothing left to owe and the line is gone —
  // which is the phase 4 target, not a reason for this test to fail.
  if (m) assert.ok(Number(m[1]) > 0);
});

test('ui:check --all sweeps the unmigrated chrome too, and says so', () => {
  const { code, out } = run(['--all']);
  // This is the phase 4 target. Until then it is expected to find the colour
  // literals in styles.css and serviceAssurance.css.
  if (code === 0) {
    assert.match(out, /ui:check — clean/);
  } else {
    assert.match(out, /--all/);
    assert.match(out, /public\/(styles|serviceAssurance)\.css:\d+:colour/);
  }
});

// ---------------------------------------------------------------- the rules
// A rule that has quietly stopped matching is worse than no rule, so each one
// is fired at a fixture that violates it.
// The fixture stands in for a migrated view, so it has to satisfy the template
// rule before the rule under test is the only thing firing.
const OK_VIEW = `
  var view = ui.page(ui.pageHeader({ title: 'x', lead: 'y' }));
`;

// MIGRATED grows with every phase-3 commit, and a fixture that does not keep up
// fails on a missing file rather than on the rule under test. Read the list out
// of the script rather than restating it here.
const MIGRATED_FILES = (() => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const from = src.indexOf('const MIGRATED = [');
  return [...src.slice(from, src.indexOf('];', from)).matchAll(/'([^']+)'/g)].map((m) => m[1]);
})();

function withFixture(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uicheck-'));
  const write = (rel, body) => {
    fs.mkdirSync(path.join(dir, 'public', path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'public', rel), body);
  };
  try {
    fs.mkdirSync(path.join(dir, 'public', 'css'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'ui-check.js'));
    // The real token + contract sheets, so only the fixture under test differs.
    for (const f of ['css/tokens.css', 'css/base.css', 'css/components.css']) {
      fs.copyFileSync(path.join(ROOT, 'public', f), path.join(dir, 'public', f));
    }
    // Every file the script expects to find gets a clean stand-in unless the
    // fixture supplies its own.
    for (const rel of MIGRATED_FILES) {
      if (files[rel] === undefined) write(rel, rel === 'ui.js' ? '// components' : OK_VIEW);
    }
    for (const [rel, body] of Object.entries(files)) write(rel, body);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fixtureFindings(body, extra = {}) {
  return withFixture(Object.assign({ 'uiPreview.js': OK_VIEW + body }, extra), (dir) => run([], dir));
}

test('rule: inline style in a view is a finding', () => {
  const { code, out } = fixtureFindings("var n = el('div', { style: 'margin:8px' });");
  assert.equal(code, 1, out);
  assert.match(out, /uiPreview\.js:\d+:inline-style/);
});

test('rule: a <col> width is NOT a finding — it is table geometry, not styling', () => {
  const { code, out } = fixtureFindings("var c = el('col', { style: 'width:' + w });");
  assert.equal(code, 0, out);
});

test('rule: a colour literal in a view is a finding', () => {
  const { out } = fixtureFindings("var c = '#38bdf8';");
  assert.match(out, /uiPreview\.js:\d+:colour/);
  const rgb = fixtureFindings("var c = 'rgba(0,0,0,.4)';");
  assert.match(rgb.out, /uiPreview\.js:\d+:colour/);
});

test('rule: a colour inside a comment is not a finding — the rule may be explained', () => {
  const { code } = fixtureFindings("// the old value was #38bdf8, now a token\nvar c = 'var(--accent)';");
  assert.equal(code, 0);
});

test('rule: a legacy class in a migrated view is a finding, and names its replacement', () => {
  const { out } = fixtureFindings("var n = el('div', { class: 'hero' });");
  assert.match(out, /uiPreview\.js:\d+:legacy-class/);
  assert.match(out, /PageHeader/);
});

test('rule: a hand-rolled tab strip is a finding', () => {
  const { out } = fixtureFindings("var n = el('div', { class: 'subtabs' });");
  assert.match(out, /:tab-pattern/);
});

test('rule: a chip is a finding, whatever it carries', () => {
  const { out } = fixtureFindings("var n = el('span', { class: 'chip' }, '135x');");
  assert.match(out, /:chip-metadata/);
});

test('rule: two primary buttons in one PageHeader is a finding', () => {
  const { out } = fixtureFindings(`
    var h = ui.pageHeader({ title: 'x', lead: 'y', actions: [
      ui.button('primary', 'One'),
      ui.button('primary', 'Two'),
    ] });
  `);
  assert.match(out, /:primary-count/);
  assert.match(out, /2 primary buttons/);
});

test('rule: one primary plus a secondary is fine', () => {
  const { code, out } = fixtureFindings(`
    var h = ui.pageHeader({ title: 'x', lead: 'y', actions: [
      ui.button('secondary', 'Fleet grid'),
      ui.button('primary', 'Mark as seen'),
    ] });
  `);
  assert.equal(code, 0, out);
});

test('rule: a migrated view that uses none of the templates is a finding', () => {
  const { out } = withFixture({ 'uiPreview.js': "var n = el('div', {});" }, (dir) => run([], dir));
  assert.match(out, /uiPreview\.js:1:template/);
  assert.match(out, /ui\.page\(/);
});

test('rule: a raw px size in a contract stylesheet is a finding', () => {
  const { out } = withFixture({
    'css/components.css': '.ui .x { padding: 7px; font-size: 15px; }',
  }, (dir) => run([], dir));
  assert.match(out, /css\/components\.css:\d+:px-size/);
  assert.match(out, /--s-\* or --fs-\*/);
});

test('rule: a colour in tokens.css is fine — that is the one file it belongs in', () => {
  const { code, out } = withFixture({
    'css/tokens.css': ':root { --accent: #38bdf8; }',
  }, (dir) => run([], dir));
  assert.equal(code, 0, out);
});

test('the output is file:line:rule, so an editor can jump to it', () => {
  const { out } = fixtureFindings("var n = el('div', { style: 'margin:8px' });");
  const line = out.split('\n').find((l) => l.includes(':inline-style'));
  assert.match(line, /^public\/[\w./-]+:\d+:[a-z-]+ {2}\S/, line);
});
