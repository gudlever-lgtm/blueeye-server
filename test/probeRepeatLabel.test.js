'use strict';

// The Probes screen's "Repeat" button saves the probe on screen as a test
// package. Its label — the modal's "what" line and the package name — used to
// read `body.host || 'transaction'`, so a DHCP probe (which has no host; it
// broadcasts on an interface, the agent's default-route one when none is
// given) was saved as "dhcp — transaction" and described as "dhcp to ".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const I18n = require('../public/i18n');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const start = src.indexOf('// Repeat: the probe on screen, saved as a scheduled test package');
const block = src.slice(start, src.indexOf('async function refreshLatest', start));

test('the repeat label for a dhcp probe names the interface, never "transaction"', () => {
  assert.ok(start > 0, 'repeat block not found in public/app.js');
  assert.match(block, /body\.type === 'dhcp'\s*\?\s*\(body\.iface \|\| t\('repeat\.dhcp\.defaultIface'\)\)/);
  assert.match(block, /t\('repeat\.what\.dhcp', \{ iface: target \}\)/);
  assert.match(block, /name: `\$\{body\.type\} — \$\{target\}`/);
  assert.doesNotMatch(block, /'transaction'\}/, 'the package name no longer hardcodes the English fallback');
});

test('the dhcp repeat keys exist in both catalogues with matching placeholders', () => {
  for (const key of ['repeat.what.dhcp', 'repeat.dhcp.defaultIface', 'repeat.target.transaction']) {
    assert.ok(I18n.has(key, 'en') && I18n.has(key, 'da'), `${key} missing from a catalogue`);
  }
  assert.equal(I18n.t('repeat.what.dhcp', { iface: 'eth1' }, 'en'), 'DHCP on eth1');
  assert.equal(I18n.t('repeat.what.dhcp', { iface: 'eth1' }, 'da'), 'DHCP på eth1');
  assert.equal(I18n.t('repeat.dhcp.defaultIface', {}, 'en'), 'default interface');
});
