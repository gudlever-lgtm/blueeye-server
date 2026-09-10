'use strict';

const { blockField } = require('./dsl');

// Repairs a saved definition that carries a step which cannot ever pass.
//
// Discovery's Login and Availability rules used to end a suggested test with:
//
//   { type: 'assert_text_contains', target: { text: <page title> }, value: <page title> }
//
// A page title lives in `<title>`, in `<head>`. A text target resolves through
// getByText, which only sees the body — so that step hunts the page for a string
// that is not on it, burns the full step timeout and fails with
// `teksten "..." blev ikke fundet` however healthy the service is.
//
// The rules were fixed (they emit `assert_title_contains` now), but a definition
// an operator ALREADY accepted still carries the broken step. This is what turns
// one into what it meant to say.
//
// Pure: definition in, { definition, changed } out. No I/O, no mutation of the
// input — scripts/repair-title-assertions.js does the reading and writing.

// The signature of a generated title assertion, and ONLY that.
//
// It cannot collide with a hand-built step. The designer creates every targeted
// step with `target: { text: '' }` and offers no way to edit a target
// afterwards — label, url and value are the only editable fields — while `value`
// is required and rejected when empty. So a hand-built assert_text_contains
// always has `target.text === ''` and a non-empty value: `target.text === value`
// with a non-empty value is reachable only from the generator.
function isGeneratedTitleAssertion(step) {
  if (!step || step.type !== 'assert_text_contains') return false;
  const target = step.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
  const keys = Object.keys(target);
  if (keys.length !== 1 || keys[0] !== 'text') return false;
  if (typeof target.text !== 'string' || target.text === '') return false;
  return target.text === step.value;
}

// The step it should have been. The label is dropped along with the target: a
// stale "Kontroller at teksten … indeholder …" would describe the old step.
function repairStep(step) {
  if (!isGeneratedTitleAssertion(step)) return step;
  const { target, label, ...rest } = step;
  return { ...rest, type: 'assert_title_contains' };
}

function repairDefinition(definition) {
  if (!definition || typeof definition !== 'object' || !Array.isArray(definition.steps)) {
    return { definition, changed: 0 };
  }
  let changed = 0;
  const steps = definition.steps.map((step) => {
    const repaired = repairStep(step);
    if (repaired !== step) changed += 1;

    // A condition's nested block holds steps too, and a suggestion accepted into
    // one would be missed by a top-level-only sweep.
    const block = step && blockField(step.type);
    if (block && Array.isArray(step[block])) {
      const inner = step[block].map((nested) => {
        const fixed = repairStep(nested);
        if (fixed !== nested) changed += 1;
        return fixed;
      });
      return { ...repaired, [block]: inner };
    }
    return repaired;
  });

  if (!changed) return { definition, changed: 0 };
  return { definition: { ...definition, steps }, changed };
}

module.exports = { repairDefinition, repairStep, isGeneratedTitleAssertion };
