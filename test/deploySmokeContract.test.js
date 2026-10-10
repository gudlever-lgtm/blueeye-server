'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// scripts/deploy.sh makes a handful of unauthenticated HTTP requests after the
// stack comes up and FAILS THE DEPLOY on an unexpected status. That turns the
// codes below into a contract: change one and a deploy starts aborting on a
// healthy server (or, worse, stops aborting on a broken one).
//
// Each case is also a 500-guard. A boot that routes but has a broken error
// handler, a broken auth chain or a missing static root answers 500 here, and
// the deploy script is the thing that would notice — as long as these codes
// stay what it checks for.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp } = require('../test-support/fakes');

// name -> [path, expected status]. Mirrors the `smoke` calls in deploy.sh.
const SMOKE = {
  'dashboard loads': ['/', 200],
  'unknown path is 404': ['/no-such-endpoint-x', 404],
  'unknown api path is 404': ['/api/no-such-thing-x', 404],
  'protected route is 401': ['/system/version', 401],
  'agents list is 401': ['/agents', 401],
  // Not asserted by the deploy script (it needs no client), but the probe it
  // waits on, so it belongs in the same contract.
  health: ['/health', 200],
};

test('the deploy smoke checks assert the codes the app actually returns', async () => {
  const app = makeApp({});
  for (const [name, [route, want]] of Object.entries(SMOKE)) {
    const res = await request(app).get(route);
    assert.equal(res.status, want, `${name}: GET ${route} answered ${res.status}, deploy.sh expects ${want}`);
  }
});

test('no unauthenticated smoke route answers 5xx', async () => {
  const app = makeApp({});
  for (const [route] of Object.values(SMOKE)) {
    const res = await request(app).get(route);
    assert.ok(res.status < 500, `GET ${route} answered ${res.status} — a 5xx on a smoke route is a broken deploy`);
  }
});

test('deploy.sh still checks exactly these routes, and still aborts on them', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy.sh'), 'utf8');

  for (const [name, [route, want]] of Object.entries(SMOKE)) {
    if (name === 'health') continue;
    const line = script.split('\n').find((l) => l.includes(`smoke "${name}"`));
    assert.ok(line, `deploy.sh no longer runs the smoke check '${name}'`);
    assert.ok(line.includes(route.replace('-x', '-$$')) || line.includes(`$BASE${route}`) || line.includes(`"$BASE/"`),
      `the '${name}' smoke check no longer hits ${route}: ${line.trim()}`);
    assert.match(line, new RegExp(`\\s${want}\\s`), `the '${name}' smoke check no longer expects ${want}`);
  }

  // The whole point of the change: a failed health probe or smoke check ends
  // the deploy. `|| true` here is how a broken deploy used to exit 0.
  assert.match(script, /wait_health server[^\n]*\n\s*\|\| abort_deploy/, 'the health check is no longer fatal');
  assert.doesNotMatch(script, /wait_health[^\n]*\|\| true/, 'the health check is back to being non-fatal');
  assert.match(script, /\[ "\$SMOKE_FAILED" = "0" \] \|\| abort_deploy/, 'a failed smoke check no longer aborts');
  // And it must not pretend to roll the database back.
  assert.match(script, /The DATABASE is not rolled back/, 'the recovery note must stay honest about the schema');
});
