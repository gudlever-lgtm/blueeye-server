'use strict';

const { localize, DEFAULT_LOCALE } = require('./catalog');

// Turning a set of matched playbooks into the plan the operator is shown and the
// list of tests the server will actually dispatch.
//
// Pure: playbooks, a target and an agent in, a plan object out. No I/O.
//
// Two jobs that have to agree, which is why they are one function:
//
//   the PLAN is what the UI renders — likely causes, the tests with their
//   parameters already filled in, the views to open and what to look for in
//   each, and the possible fixes.
//
//   the TESTS are rows the run step reads. Deduplicated across playbooks,
//   because three causes all wanting a traceroute to the same target is one
//   traceroute, and running it three times would be three times the load for the
//   same measurement. Each row remembers which playbooks asked for it, so the
//   UI can still say why it is in the list.

// A plan with more than this many tests is not a plan, it is a load test. Three
// causes with three tests each is already at the edge of what somebody will sit
// and wait for.
const MAX_TESTS = 12;

// Tests that need the question asked from the FAR end too. Direction is the
// whole measurement for these: "A reaches B" and "B reaches A" are different
// facts, and a playbook that reads `reverse.*` is asking for the second one.
function needsReverse(pb) {
  return pb.rules.some((r) => r.paths.some((p) => p.startsWith('reverse.') || p.startsWith('path_compare.')));
}

// The key two tests are "the same" under. Params are part of it: a ping with
// sizes and a plain ping measure different things even against one target.
const testKey = (t) => `${t.direction}|${t.probeType}|${t.target}|${JSON.stringify(t.params || {})}`;

// Builds the plan.
//
//   matches  — [{ id, confidence, reason?, matchedOn? }] from the matcher or the
//              validated AI selection, best first
//   catalog  — the loaded catalogue
//   target   — what the tests point at
//   agentId  — the agent they run from
//   peerAgentId — the agent at the far end, when there is one
//   reverseTarget — where the far end probes BACK to (src/diagnose/reverseTarget.js):
//              { address, why } or { address: null, reason }. The reverse
//              direction measures the RETURN path, so it points at the origin
//              agent, never at `target` — the same target from the far end is
//              a second forward path, and comparing two forward paths says
//              nothing about asymmetry. Without an address the reverse tests
//              are listed in `skipped` with the reason instead of being run
//              at the wrong place.
function buildPlan({
  matches = [], catalog, target, agentId = null, peerAgentId = null,
  reverseTarget = null,
  locale = DEFAULT_LOCALE, matchedBy = 'keywords',
} = {}) {
  const causes = [];
  const tests = [];
  const skipped = [];
  const byKey = new Map();
  const reverseAddress = reverseTarget && reverseTarget.address ? reverseTarget.address : null;
  const reverseSkipReason = reverseAddress ? null
    : ((reverseTarget && reverseTarget.reason) || 'The origin agent\'s own address is unknown, so the far end has nothing to probe back to.');

  for (const m of matches) {
    const pb = catalog.get(m.id);
    if (!pb) continue; // already filtered upstream; belt and braces
    const view = localize(pb, locale);

    const testRefs = [];
    const wantReverse = needsReverse(pb) && peerAgentId != null;
    for (const t of pb.tests) {
      for (const direction of wantReverse ? ['forward', 'reverse'] : ['forward']) {
        const baseWhy = view.tests.find((x) => x.type === t.type)?.why ?? null;
        if (direction === 'reverse' && !reverseAddress) {
          if (!skipped.some((x) => x.probeType === t.type)) {
            skipped.push({ playbookId: pb.id, direction, agentId: peerAgentId, probeType: t.type, reason: reverseSkipReason });
          }
          continue;
        }
        const row = {
          playbookId: pb.id,
          direction,
          agentId: direction === 'reverse' ? peerAgentId : agentId,
          probeType: t.type,
          target: direction === 'reverse' ? reverseAddress : target,
          params: t.params,
          // The playbook's own `why` describes the forward test ("the outbound
          // path"); the reverse row gets the sentence that says where it points
          // and why that address.
          why: direction === 'reverse' ? reverseTarget.why : baseWhy,
        };
        const key = testKey(row);
        const existing = byKey.get(key);
        if (existing) {
          if (!existing.askedBy.includes(pb.id)) existing.askedBy.push(pb.id);
          testRefs.push(existing.index);
          continue;
        }
        if (tests.length >= MAX_TESTS) continue;
        const index = tests.length;
        const entry = { ...row, index, askedBy: [pb.id] };
        tests.push(entry);
        byKey.set(key, entry);
        testRefs.push(index);
      }
    }

    causes.push({
      id: pb.id,
      title: view.title,
      summary: view.summary,
      explanation: view.explanation,
      confidence: m.confidence ?? null,
      // Why THIS cause is on the list. From the matcher it is the words that
      // matched; from the AI it is the sentence it gave. Either way the reader
      // can see the reasoning rather than being handed a ranking.
      reason: m.reason ?? null,
      matchedOn: m.matchedOn ?? null,
      tests: testRefs,
      views: view.views,
      fixes: view.fixes,
      rules: view.rules.map((r) => ({ id: r.id, effect: r.effect, because: r.because })),
    });
  }

  return {
    matchedBy,
    // Said plainly, once, in the plan itself: an operator reading a plan should
    // not have to work out whether the AI was involved.
    usedAi: matchedBy === 'llm',
    target,
    agentId,
    peerAgentId,
    causes,
    tests: tests.map(({ index, ...t }) => ({ index, ...t })),
    // Tests the plan wanted and deliberately did not schedule, each with why.
    skipped,
  };
}

module.exports = { buildPlan, needsReverse, testKey, MAX_TESTS };
