'use strict';

// Wait until something has actually happened, instead of sleeping for a while
// and hoping.
//
// A fixed `await setTimeout(50)` before asserting the result of an async write
// or build encodes a guess about how fast the machine is. It holds on a laptop
// and fails on a loaded CI runner, where it shows up as one unexplained failure
// in a few thousand — the worst kind, because it looks like a real defect and
// re-running "fixes" it.
//
// Polling a predicate with a generous deadline asserts the SAME thing (it did
// eventually happen) and is fast on a fast machine, patient on a slow one.
//
//   await waitFor(() => store.available('linux-x64'), 'the build to finish');
//
// This is only for waiting until something BECOMES true. A test asserting that
// something did NOT happen still has to wait a fixed period — there is nothing
// to poll for — and that direction is safe: a slow machine gives the unwanted
// event MORE time to show up, so it cannot produce a false failure.
async function waitFor(predicate, what = 'a condition', { timeoutMs = 5000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`waitFor: timed out after ${timeoutMs}ms waiting for ${what}`);
    // NOT unref'd: an unref'd timer lets the process exit while we are waiting,
    // which ends the test silently instead of failing it.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, intervalMs); });
  }
}

module.exports = { waitFor };
