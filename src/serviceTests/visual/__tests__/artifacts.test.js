'use strict';

// Where baselines live on disk (V2 §8).
//
// One assertion here matters more than the rest: retention must not delete a
// baseline. A baseline that vanished when the run it came from aged out would
// stop watching the page without anybody being told — the worst failure mode
// this feature has, because everything would keep reporting green.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createArtifactStore } = require('../../runner/artifacts');

// An in-memory filesystem, so the suite never touches a disk.
function makeFs() {
  const files = new Map();
  const dirs = new Set();
  return {
    files,
    dirs,
    async mkdir(dir) { dirs.add(dir); },
    async writeFile(full, buffer) { files.set(full, buffer); },
    async readFile(full) {
      if (!files.has(full)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(full);
    },
    async rm(dir) {
      for (const key of [...files.keys()]) if (key.startsWith(dir + path.sep) || key === dir) files.delete(key);
      dirs.delete(dir);
    },
  };
}

const ROOT = '/var/lib/blueeye/artifacts';
const IMAGE = Buffer.from([1, 2, 3, 4]);

test('a baseline is stored outside the run shards, under the test', async () => {
  const fsImpl = makeFs();
  const store = createArtifactStore({ root: ROOT, fsImpl });

  const stored = await store.saveBaseline(7, IMAGE, { stepIndex: 2, environmentId: 3 });
  assert.equal(stored, path.join('baselines', '7', 'step-2-env-3.png'));
  assert.deepEqual(await store.readScreenshot(stored), IMAGE);
});

test('an environment-less baseline gets its own name rather than colliding', async () => {
  const fsImpl = makeFs();
  const store = createArtifactStore({ root: ROOT, fsImpl });
  const any = await store.saveBaseline(7, IMAGE, { stepIndex: 2, environmentId: null });
  const specific = await store.saveBaseline(7, IMAGE, { stepIndex: 2, environmentId: 3 });
  // They are different baselines for the same step, and one must not overwrite
  // the other on disk.
  assert.notEqual(any, specific);
});

test('deleting a run NEVER touches a baseline', async () => {
  // The whole reason baselines are not stored in the run directory.
  const fsImpl = makeFs();
  const store = createArtifactStore({ root: ROOT, fsImpl });

  await store.saveScreenshot(42, IMAGE, { format: 'png', index: 0 });
  const baseline = await store.saveBaseline(42, IMAGE, { stepIndex: 0, environmentId: null });

  await store.removeRun(42);

  // The run's own artefacts are gone...
  assert.equal(fsImpl.files.size, 1);
  // ...and the baseline is still there and still readable.
  assert.deepEqual(await store.readScreenshot(baseline), IMAGE);
});

test('a baseline path cannot escape the artifact root', async () => {
  // Paths are built from integers we generated, never from user input, but a
  // traversal here would read anything the worker can.
  const fsImpl = makeFs();
  const store = createArtifactStore({ root: ROOT, fsImpl });
  await assert.rejects(() => store.readScreenshot('../../etc/passwd'), /outside the artifact root/);
  await assert.rejects(() => store.saveBaseline('../evil', IMAGE, {}), /unsafe test id/);
  await assert.rejects(() => store.saveBaseline(1, IMAGE, { environmentId: '../x' }), /unsafe environment id/);
});

test('removing a test\'s baselines removes only that test\'s', async () => {
  const fsImpl = makeFs();
  const store = createArtifactStore({ root: ROOT, fsImpl });
  const mine = await store.saveBaseline(1, IMAGE, { stepIndex: 0 });
  const theirs = await store.saveBaseline(2, IMAGE, { stepIndex: 0 });

  await store.removeBaselines(1);
  await assert.rejects(() => store.readScreenshot(mine));
  assert.deepEqual(await store.readScreenshot(theirs), IMAGE);
});

test('an empty buffer stores nothing rather than a zero-byte baseline', async () => {
  // A zero-byte baseline would make every later comparison "uncomparable",
  // which reads as a broken feature rather than a missing picture.
  const fsImpl = makeFs();
  const store = createArtifactStore({ root: ROOT, fsImpl });
  assert.equal(await store.saveBaseline(1, Buffer.alloc(0), {}), null);
  assert.equal(fsImpl.files.size, 0);
});
