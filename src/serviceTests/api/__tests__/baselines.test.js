'use strict';

// Visual regression baselines over HTTP (V2 §8).
//
// Contract per the repo's rule: 400 / 401 / 403 / 404 on every route, never 500.
//
// The rule worth stating: accepting a baseline is an ACT. A picture captured
// automatically on first sight would be a baseline of whatever the page looked
// like that day — including broken — and every later comparison would be against
// that. Somebody says "this is what it should look like", and the row records
// who and when.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const zlib = require('zlib');

const { makeApp, authHeader } = require('../../../../test-support/fakes');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');

const BASE = '/api/service-tests/baselines';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}
const PNG = (() => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.from([0, 255, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255]);
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
})();

// An artifact store that lives in memory, so nothing here touches a disk.
function makeArtifacts({ missing = false } = {}) {
  const files = new Map();
  return {
    files,
    async saveScreenshot(runId, buffer, { index = 0 } = {}) {
      const path = `runs/${runId}/${index}.png`;
      files.set(path, buffer);
      return path;
    },
    async saveBaseline(testId, buffer, { stepIndex = 0, environmentId = null } = {}) {
      const path = `baselines/${testId}/step-${stepIndex}-env-${environmentId ?? 'any'}.png`;
      files.set(path, buffer);
      return path;
    },
    async readScreenshot(path) {
      if (missing || !files.has(path)) throw new Error('ENOENT');
      return files.get(path);
    },
  };
}

function fixture({ runOver = {}, artifacts = makeArtifacts() } = {}) {
  const serviceTests = makeServiceTests({
    artifacts,
    runs: [{
      test_id: 1, status: 'pass', environment_id: null,
      steps: [{ position: 0, label: 'Open /login' }, { position: 1, label: 'See the dashboard' }],
      visual: [{ step_index: 1, status: 'changed', image_path: 'runs/1/visual-1.png', size: { width: 2, height: 2 } }],
      ...runOver,
    }],
  });
  artifacts.files.set('runs/1/visual-1.png', PNG);
  return { serviceTests, app: makeApp({ serviceTests }), artifacts };
}

const post = (app, body, role = 'operator') =>
  request(app).post(BASE).set('Authorization', authHeader(role)).send(body);

// ------------------------------------------------------------- 401 / 403
test('baselines are anonymous-401 and viewer-read-only', async () => {
  const { app } = fixture();
  assert.equal((await request(app).get(`${BASE}?test_id=1`)).status, 401);
  assert.equal((await request(app).post(BASE).send({})).status, 401);

  assert.equal((await request(app).get(`${BASE}?test_id=1`).set('Authorization', authHeader('viewer'))).status, 200);
  // Deciding what a page SHOULD look like is a judgement about the service, not
  // a read.
  assert.equal((await post(app, { run_id: 1, step_index: 1 }, 'viewer')).status, 403);
});

// ------------------------------------------------------------- accepting
test('accepting stores the picture and records who decided it', async () => {
  const { app, artifacts } = fixture();
  const res = await post(app, { run_id: 1, step_index: 1 });

  assert.equal(res.status, 201);
  assert.equal(res.body.test_id, 1);
  assert.equal(res.body.step_index, 1);
  // A baseline nobody will admit to accepting is one nobody dares replace.
  assert.ok(res.body.accepted_by);
  assert.ok(res.body.accepted_at);
  assert.equal(res.body.source_run_id, 1);
  // The label travels with it, so a baseline whose step has moved is visible as
  // a mismatch rather than silently comparing the wrong step.
  assert.equal(res.body.step_label, 'See the dashboard');
  assert.ok([...artifacts.files.keys()].some((k) => k.startsWith('baselines/1/')));
});

test('accepting twice REPLACES rather than making a second baseline', async () => {
  // Two baselines for one step would mean the comparison picks one arbitrarily,
  // and which it picked would decide the answer.
  const { app, serviceTests } = fixture();
  assert.equal((await post(app, { run_id: 1, step_index: 1 })).status, 201);
  assert.equal((await post(app, { run_id: 1, step_index: 1 })).status, 201);
  assert.equal(serviceTests.tables.baselines.rows.length, 1);
});

test('a baseline cannot be accepted from a picture that does not exist', async () => {
  // It would leave a step "watched" while every comparison answers
  // "uncomparable" — worse than not watching it.
  const { app } = fixture({ runOver: { visual: [] } });
  const res = await post(app, { run_id: 1, step_index: 1 });
  assert.equal(res.status, 400);
  assert.match(res.body.details.step_index, /kept no picture/);
});

test('a picture that has aged off the disk is refused, not stored as a path to nothing', async () => {
  const { app } = fixture({ artifacts: makeArtifacts({ missing: true }) });
  const res = await post(app, { run_id: 1, step_index: 1 });
  assert.equal(res.status, 400);
  assert.match(res.body.details.run_id, /no longer on disk/);
});

test('accepting answers 400/404 and never 500', async () => {
  const { app } = fixture();
  for (const body of [{}, { run_id: 1 }, { step_index: 1 }, { run_id: 'x', step_index: 1 },
    { run_id: 1, step_index: -1 }, { run_id: 1, step_index: 'two' }]) {
    const res = await post(app, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await post(app, { run_id: 9999, step_index: 1 })).status, 404);
  // A step the run does not have.
  assert.equal((await post(app, { run_id: 1, step_index: 9 })).status, 400);
});

// ------------------------------------------------------------- editing
test('ignore regions, tuning and the switch are editable; the picture is not', async () => {
  const { app } = fixture();
  const id = (await post(app, { run_id: 1, step_index: 1 })).body.id;
  const h = authHeader('operator');

  const res = await request(app).put(`${BASE}/${id}`).set('Authorization', h).send({
    ignore_regions: [{ x: 0, y: 0, width: 1, height: 1, label: 'clock' }],
    tolerance: 20, threshold_pct: 2.5, enabled: false,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.tolerance, 20);
  assert.equal(res.body.threshold_pct, 2.5);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.ignore_regions.length, 1);

  // Replacing what the page should look like is accepting a new baseline, which
  // records who did it. An edit that could swap the picture would lose that.
  const sneaky = await request(app).put(`${BASE}/${id}`).set('Authorization', h)
    .send({ image_path: 'baselines/1/anything.png' });
  assert.equal(sneaky.status, 200);
  assert.notEqual(sneaky.body.image_path, 'baselines/1/anything.png');
});

test('editing validates its input and answers 400/404, never 500', async () => {
  const { app } = fixture();
  const id = (await post(app, { run_id: 1, step_index: 1 })).body.id;
  const h = authHeader('operator');

  for (const body of [{ tolerance: -1 }, { tolerance: 999 }, { tolerance: 'lots' },
    { threshold_pct: -5 }, { threshold_pct: 101 }, { enabled: 'yes' }, { ignore_regions: 'all of it' }]) {
    const res = await request(app).put(`${BASE}/${id}`).set('Authorization', h).send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }

  // A rectangle entirely off the page is refused rather than silently clamped
  // into a corner the operator never selected.
  const offPage = await request(app).put(`${BASE}/${id}`).set('Authorization', h)
    .send({ ignore_regions: [{ x: -500, y: -500, width: 10, height: 10 }] });
  assert.equal(offPage.status, 400);
  assert.match(offPage.body.details.ignore_regions, /none of those rectangles/);

  for (const bad of ['abc', '-1', '0']) {
    const res = await request(app).put(`${BASE}/${bad}`).set('Authorization', h).send({ enabled: true });
    assert.ok([400, 404].includes(res.status), `${bad} → ${res.status}`);
  }
  assert.equal((await request(app).put(`${BASE}/9999`).set('Authorization', h).send({ enabled: true })).status, 404);
});

// ------------------------------------------------------------- reading
test('the baseline image is served as PNG, and 404s when the file has gone', async () => {
  const { app, artifacts } = fixture();
  const id = (await post(app, { run_id: 1, step_index: 1 })).body.id;

  const ok = await request(app).get(`${BASE}/${id}/image`).set('Authorization', authHeader('viewer'));
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /image\/png/);

  artifacts.files.clear();
  const gone = await request(app).get(`${BASE}/${id}/image`).set('Authorization', authHeader('viewer'));
  assert.equal(gone.status, 404, 'a missing file must not 500');
});

test('listing needs a test and 404s for one that does not exist', async () => {
  const { app } = fixture();
  const h = authHeader('viewer');
  assert.equal((await request(app).get(BASE).set('Authorization', h)).status, 400);
  assert.equal((await request(app).get(`${BASE}?test_id=9999`).set('Authorization', h)).status, 404);
  assert.equal((await request(app).get(`${BASE}?test_id=abc`).set('Authorization', h)).status, 400);
});

// ------------------------------------------------------------- deleting
test('deleting stops the comparison and leaves the image where it is', async () => {
  const { app, artifacts, serviceTests } = fixture();
  const id = (await post(app, { run_id: 1, step_index: 1 })).body.id;
  const before = artifacts.files.size;

  assert.equal((await request(app).delete(`${BASE}/${id}`).set('Authorization', authHeader('operator'))).status, 204);
  assert.equal(serviceTests.tables.baselines.rows.length, 0);
  // An accidental delete should not be unrecoverable. The row is cheap; the
  // file is swept with the rest.
  assert.equal(artifacts.files.size, before);

  assert.equal((await request(app).delete(`${BASE}/${id}`).set('Authorization', authHeader('operator'))).status, 404);
  assert.equal((await request(app).delete(`${BASE}/${id}`).set('Authorization', authHeader('viewer'))).status, 403);
});
