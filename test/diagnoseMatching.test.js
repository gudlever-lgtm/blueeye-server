'use strict';

// The matcher and the catalogue — the half of this module that must work with
// the AI switched off entirely.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadCatalog, localize, LOCALES } = require('../src/diagnose/catalog');
const { matchPlaybooks, stem, wordsMatch } = require('../src/diagnose/match');

const catalog = loadCatalog();
const ids = (desc, opts) => matchPlaybooks(desc, catalog, opts).map((m) => m.id);

// --- the two fixtures the feature is judged on ------------------------------

test('“Mail kan forbinde, men når der sendes data, mistes pakker” is an MTU blackhole', () => {
  const top = ids('Mail kan forbinde, men når der sendes data, mistes pakker eller forbindelsen afbrydes');
  assert.equal(top[0], 'mtu_blackhole');
});

test('“Trafik mellem A og B mister pakker, men vi ved ikke hvor” is hop loss, with MTU still on the list', () => {
  const top = ids('Trafik mellem A og B mister pakker, men vi ved ikke hvor');
  assert.equal(top[0], 'hop_packet_loss');
  // Size-dependent loss looks exactly like this until somebody sends a big
  // packet, so it stays a candidate rather than being ranked away.
  assert.ok(top.includes('mtu_blackhole'), `top 3 was ${top.join(', ')}`);
});

test('the same two faults in English reach the same two playbooks', () => {
  assert.equal(ids('Mail connects but when data is sent packets are lost or the connection drops')[0], 'mtu_blackhole');
  assert.equal(ids('Traffic between A and B loses packets but we do not know where')[0], 'hop_packet_loss');
});

// --- the rest of the catalogue ----------------------------------------------

test('each remaining playbook is reachable from a sentence somebody would actually write', () => {
  const cases = [
    ['Vi ser crc-fejl på porten uden nogen trafik', 'physical_errors'],
    ['Vi mister pakker ved spidsbelastning om morgenen', 'congestion'],
    ['Siden virker ikke, men IP-adressen virker fint', 'dns_resolution'],
    ['Periodisk bliver alt langsomt, ligner en broadcast-storm', 'l2_loop'],
    ['Linjen er langsom og fejl stiger med trafikken', 'duplex_mismatch'],
    ['Cirka halvdelen af vores forbindelser fejler, resten virker', 'ecmp_member_link'],
    ['A kan nå B men B kan ikke nå A', 'asymmetric_routing'],
  ];
  for (const [desc, expected] of cases) {
    assert.equal(ids(desc)[0], expected, `“${desc}” → ${ids(desc).join(', ')}`);
  }
});

test('a description with nothing technical in it matches nothing, rather than guessing', () => {
  assert.deepEqual(ids('Hej med dig, hvordan går det?'), []);
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids('   '), []);
});

test('at most three candidates come back, best first, and the order is stable', () => {
  const desc = 'Vi mister pakker og har fejl på interfacet og det er langsomt';
  const a = matchPlaybooks(desc, catalog);
  const b = matchPlaybooks(desc, catalog);
  assert.ok(a.length <= 3);
  assert.deepEqual(a, b, 'the same description must always produce the same list');
  for (let i = 1; i < a.length; i += 1) assert.ok(a[i - 1].score >= a[i].score);
  assert.equal(a[0].confidence, 1, 'confidence is relative to the leader');
});

test('every candidate says WHY it is on the list', () => {
  const [top] = matchPlaybooks('Vi ser crc-fejl på porten', catalog);
  assert.ok(top.matchedOn.keywords.length + top.matchedOn.symptoms.length > 0);
  assert.ok(top.matchedOn.keywords.includes('crc'));
});

// --- Danish inflection, which is where a naive matcher falls over ------------

test('Danish inflection matches both ways, not just when the playbook guessed the form', () => {
  // "mister" and "mistes" share no prefix; a prefix-only matcher misses this,
  // and it is most of Danish.
  assert.ok(wordsMatch('mister', 'mistes'));
  assert.ok(wordsMatch('pakker', 'pakkerne'));
  // Stacked suffixes: "morgenen" → "morgen" → "morg". Comparing one stem to
  // one stem puts these two in different places; comparing the chains does not.
  assert.ok(wordsMatch('morgenen', 'morgen'));
  assert.ok(wordsMatch('forbindelsen', 'forbindelse'));
});

test('stemming stops before it starts inventing matches', () => {
  assert.equal(stem('hvor'), 'hvor');
  assert.equal(stem('det'), 'det');
  assert.equal(stem('port'), 'port');
  assert.ok(!wordsMatch('port', 'portal'));
  assert.ok(!wordsMatch('mtu', 'mss'));
  assert.ok(!wordsMatch('dns', 'ntp'));
});

test('a description in one language still finds a term quoted in the other', () => {
  // A Danish technician pasting an English error message is roughly every other
  // outage.
  assert.equal(ids('Vi får "fragmentation needed" men intet kommer igennem')[0], 'mtu_blackhole');
});

// --- the catalogue itself ----------------------------------------------------

test('every playbook is complete in BOTH locales', () => {
  for (const pb of catalog.list()) {
    for (const loc of LOCALES) {
      const v = localize(pb, loc);
      assert.ok(v.title && v.title.length, `${pb.id}.title.${loc}`);
      assert.ok(v.explanation && v.explanation.length, `${pb.id}.explanation.${loc}`);
      assert.ok(v.symptoms.length, `${pb.id}.symptoms.${loc}`);
      assert.ok(v.fixes.length && v.fixes.every((f) => f && f.length), `${pb.id}.fixes.${loc}`);
      for (const t of v.tests) assert.ok(t.why && t.why.length, `${pb.id}.tests.why.${loc}`);
      for (const w of v.views) assert.ok(w.look_for && w.look_for.length, `${pb.id}.views.look_for.${loc}`);
      for (const r of v.rules) assert.ok(r.because && r.because.length, `${pb.id}.rules.because.${loc}`);
    }
  }
});

test('the two locales are genuinely different text, not English copied across', () => {
  // A catalogue that satisfies a parity check by duplicating the English is a
  // catalogue that fails every Danish description silently, so this looks at the
  // prose rather than at whether both keys exist.
  //
  // Titles are exempt, and deliberately: "Duplex mismatch" is what a Danish
  // network engineer says, and forcing a translation onto a loanword would make
  // the UI worse and the matcher no better.
  for (const pb of catalog.list()) {
    assert.notEqual(pb.explanation.da, pb.explanation.en, `${pb.id} explanation is identical in both locales`);
    assert.notDeepEqual(pb.symptoms.da, pb.symptoms.en, `${pb.id} symptoms are identical in both locales`);
    assert.notDeepEqual(pb.keywords.da, pb.keywords.en, `${pb.id} keywords are identical in both locales`);
  }
});

test('a new playbook needs no code change — it is a file', () => {
  const { parsePlaybook } = require('../src/diagnose/catalog');
  const doc = {
    id: 'invented_fault',
    title: { en: 'Invented', da: 'Opfundet' },
    explanation: { en: 'Something', da: 'Noget' },
    symptoms: { en: ['the widget is spinning'], da: ['hjulet snurrer'] },
    keywords: { en: ['widget'], da: ['hjul'] },
    tests: [{ type: 'ping', params: { count: 4 }, why: { en: 'because', da: 'fordi' } }],
    views: [{ view: 'probes', look_for: { en: 'a thing', da: 'en ting' } }],
    rules: [{ id: 'spins', when: 'ping.loss_pct > 0', effect: 'confirm', because: { en: 'it spins', da: 'den snurrer' } }],
    fixes: [{ en: 'stop it', da: 'stop den' }],
  };
  const pb = parsePlaybook('invented_fault.json', JSON.stringify(doc));
  assert.equal(pb.id, 'invented_fault');
  // And it is matchable the moment it exists, in both languages.
  const fake = { list: () => [pb], get: () => pb, has: () => true, ids: () => [pb.id], size: 1, summaries: () => [] };
  assert.deepEqual(matchPlaybooks('hjulet snurrer', fake).map((m) => m.id), ['invented_fault']);
  assert.deepEqual(matchPlaybooks('the widget is spinning', fake).map((m) => m.id), ['invented_fault']);
});
