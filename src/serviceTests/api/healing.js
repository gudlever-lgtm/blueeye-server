'use strict';

const express = require('express');
const { asyncHandler, invalid, notFound, makeLoader, auditor, userId, parseId } = require('./helpers');
const { normalizeTarget, describeTarget } = require('../engine/targeting');
const { validateDefinition, stepAt, replaceStepAt } = require('../engine/validate');

// Self-healing selectors — the decision surface (V2 §5, P2 #7).
//
// The spec's rule in one line: *testen må ikke ændres automatisk uden brugerens
// accept*. This router is where the accept happens, and it is the ONLY place in
// the module that rewrites a step's target from a proposal.
//
// Accepting goes through the ordinary test save, so a healed test gets a version
// bump and a definition snapshot like any other edit — "why does this point at a
// different button than it did in March" is answerable from the version history
// as well as from the healing log.
function createHealingRouter({ repositories, settings, audit, requireRole, roles }) {
  const router = express.Router();
  const { healing, tests } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const write = requireRole(roles.OPERATOR, roles.ADMIN);
  const load = makeLoader(healing, 'Healing proposal');
  const record = auditor(audit);

  // A proposal is shown with both sides in the operator's words, because that is
  // what they are being asked to judge.
  const withDescriptions = (proposal) => ({
    ...proposal,
    original_label: describeTarget(proposal.original_target, { lang: 'en' }),
    proposed_label: describeTarget(proposal.proposed_target, { lang: 'en' }),
  });

  router.get('/', read, asyncHandler(async (req, res) => {
    const testId = req.query.test_id !== undefined ? parseId(req.query.test_id) : null;
    if (req.query.test_id !== undefined && testId === null) {
      return res.status(400).json({ error: 'Invalid test_id' });
    }
    if (req.query.status !== undefined
      && !['proposed', 'accepted', 'rejected', 'stale'].includes(String(req.query.status))) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const list = await healing.list({ testId, status: req.query.status || null });
    return res.json(list.map(withDescriptions));
  }));

  router.get('/:id', read, asyncHandler(async (req, res) => {
    const proposal = await load(req, res);
    if (!proposal) return undefined;
    return res.json(withDescriptions(proposal));
  }));

  // Accepting repoints the step. This is the one write that changes a test from
  // a heuristic's proposal, so it checks more than usual before doing it.
  router.post('/:id/accept', write, asyncHandler(async (req, res) => {
    const proposal = await load(req, res);
    if (!proposal) return undefined;
    if (proposal.status !== 'proposed') {
      return res.status(409).json({ error: 'That proposal has already been handled', status: proposal.status });
    }

    const test = await tests.findById(proposal.test_id);
    if (!test) return notFound(res, 'Test not found');

    const step = stepAt(test.definition, proposal.step_path);
    if (!step) {
      // The definition changed underneath the proposal — a step was deleted or
      // reordered. Applying it by index now would repoint a DIFFERENT step, which
      // is the worst thing this route could do, so it is refused and the proposal
      // is marked stale rather than left to be accepted again tomorrow.
      await healing.decide(proposal.id, 'stale', userId(req));
      return res.status(409).json({ error: 'That step no longer exists — the test has changed since this was proposed' });
    }

    // And the step must still SAY what the proposal was made against. A step
    // someone has already re-targeted by hand is not the step this proposal
    // described, even if it sits at the same index.
    const current = JSON.stringify(normalizeTarget(step.target) || null);
    const expected = JSON.stringify(normalizeTarget(proposal.original_target) || null);
    if (current !== expected) {
      await healing.decide(proposal.id, 'stale', userId(req));
      return res.status(409).json({ error: 'That step has been changed since this was proposed' });
    }

    // The operator may edit the proposal before accepting it — "Accept / Reject
    // / Edit" is what the spec asks for, and an edited target is still their
    // decision rather than the heuristic's.
    const chosen = req.body && req.body.target ? normalizeTarget(req.body.target) : proposal.proposed_target;
    if (!chosen) return invalid(res, { target: 'that target has nothing to point at' });

    const next = replaceStepAt(test.definition, proposal.step_path, { ...step, target: chosen });
    if (!next) return notFound(res, 'Step not found');
    const runner = await settings.get('runner');
    // Through the SAME validator a hand-built test uses: a heuristic does not
    // get to write something the designer could not.
    const { value, errors } = validateDefinition(next, { maxSteps: runner.maxStepsPerTest });
    if (errors) return invalid(res, errors);

    const saved = await tests.save(test.id, { definition: value, updated_by: userId(req) });
    if (!saved) return notFound(res, 'Test not found');
    const decided = await healing.decide(proposal.id, 'accepted', userId(req));
    // The alternatives were answers to a question that now has one.
    await healing.markOthersStale(proposal.test_id, proposal.step_path, proposal.id);

    record(req, 'healing_accept', proposal.id,
      `test=${test.id} step=${proposal.step_path} ${describeTarget(proposal.original_target)} -> ${describeTarget(chosen)}`);
    return res.json({ proposal: withDescriptions(decided || proposal), test: saved });
  }));

  router.post('/:id/reject', write, asyncHandler(async (req, res) => {
    const proposal = await load(req, res);
    if (!proposal) return undefined;
    const decided = await healing.decide(proposal.id, 'rejected', userId(req));
    if (!decided) {
      return res.status(409).json({ error: 'That proposal has already been handled', status: proposal.status });
    }
    record(req, 'healing_reject', proposal.id, `test=${proposal.test_id} step=${proposal.step_path}`);
    return res.json(withDescriptions(decided));
  }));

  return router;
}

module.exports = { createHealingRouter };
