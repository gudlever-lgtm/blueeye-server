'use strict';

// Two paragraphs that were added as hardcoded English after the translation
// layer existed: the SSO guide's "where the connection comes from" paragraph
// and Settings → Updates' "Runs on the server host:" line. Both now go
// through t() with keys in both catalogues.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const I18n = require('../public/i18n');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('the SSO connection paragraph and the update host line are no longer hardcoded', () => {
  assert.ok(!src.includes("'The connection itself (bind host"), 'SSO paragraph is hardcoded again');
  assert.ok(!src.includes("'Runs on the server host: '"), 'update host line is hardcoded again');
  assert.match(src, /t\('docs\.sso\.connA'\), el\('strong', \{\}, t\('docs\.sso\.connEnv'\)\), t\('docs\.sso\.connB'\)/);
  assert.match(src, /t\('set\.upd\.runsOnA'\), el\('code', \{\}, update\.command\),\s*t\('set\.upd\.runsOnB'\)/);
});

test('their keys exist in both catalogues', () => {
  for (const key of ['docs.sso.connA', 'docs.sso.connEnv', 'docs.sso.connB', 'set.upd.runsOnA', 'set.upd.runsOnB']) {
    assert.ok(I18n.has(key, 'en') && I18n.has(key, 'da'), `${key} missing from a catalogue`);
    assert.notEqual(I18n.t(key, {}, 'da'), I18n.t(key, {}, 'en'), `${key} is untranslated in da`);
  }
});
