'use strict';

// The transaction-test failure diagnosis is written twice: the server alert
// text (PHASE_LABELS in src/analysis/transactionAlerts.js) and the dashboard's
// cell/tooltip text (tx.phase.* in public/i18n.js — it used to be a hardcoded
// English TX_PHASE_LABELS in app.js). The English must read identically, or an
// operator sees one sentence in the mail and another on the screen for the same
// failure. Danish is the dashboard's own translation of the same sentence.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const I18n = require('../public/i18n');
const { PHASE_LABELS } = require('../src/analysis/transactionAlerts');

test('every server failure phase has a catalogue entry whose English is the alert text', () => {
  for (const [phase, text] of Object.entries(PHASE_LABELS)) {
    const key = `tx.phase.${phase}`;
    assert.ok(I18n.has(key, 'en') && I18n.has(key, 'da'), `${key} missing from a catalogue`);
    assert.equal(I18n.t(key, {}, 'en'), text, `${key} drifted from the server alert text`);
  }
});

test('the dashboard no longer carries its own hardcoded copy', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/TX_PHASE_LABELS\s*=/.test(src), 'TX_PHASE_LABELS is back');
  assert.ok(!src.includes("'DNS lookup failed"), 'a phase sentence is hardcoded in app.js again');
});
