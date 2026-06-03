'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp } = require('../test-support/fakes');
const { PT } = require('../src/data');

const LOCALES = ['da', 'en', 'de', 'fr', 'nl', 'sv', 'fi', 'no', 'pl', 'es', 'it', 'pt'];

test('PT defines all 12 locales with a consistent, non-empty key set', () => {
  const keys = Object.keys(PT.da).sort();
  assert.ok(keys.length > 0, 'da locale has keys');
  for (const loc of LOCALES) {
    assert.ok(PT[loc], `missing locale ${loc}`);
    assert.deepEqual(Object.keys(PT[loc]).sort(), keys, `locale ${loc} has a different key set`);
    for (const k of keys) {
      assert.equal(typeof PT[loc][k], 'string', `${loc}.${k} is not a string`);
      assert.ok(PT[loc][k].length > 0, `${loc}.${k} is empty`);
    }
  }
});

test('GET /data.js serves the PT catalogue as a window.PT global', async () => {
  const res = await request(makeApp()).get('/data.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.text, /^window\.PT=/);
  assert.match(res.text, /Trafiktyper/); // da ttTitle
  assert.match(res.text, /Ingen trafikdata i den valgte periode/); // da ttEmpty (empty-state text)

  // The served payload round-trips to every locale we expect.
  const served = JSON.parse(res.text.replace(/^window\.PT=/, '').replace(/;\s*$/, ''));
  for (const loc of LOCALES) assert.ok(served[loc] && served[loc].ttTitle, `served payload missing ${loc}`);
});
