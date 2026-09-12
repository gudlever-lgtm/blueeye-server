'use strict';

// Every pure analysis module must survive junk.
//
// This exists because the SAME bug appeared three times in three modules in one
// afternoon: `function f({ a } = {})` looks like it defaults its input, and it
// does — for `undefined` only. `f(null)`, `f('x')` and `f(42)` all sail past the
// default and throw on the first property read.
//
// These modules are read by dashboards and by the alerting path. A throw there
// does not lose the analysis, it loses the PAGE — and an operator looking at an
// outage is the worst possible moment for the screen that explains it to go
// blank. They are also fed from a database and from each other, so "the caller
// will always pass a good object" is a promise nobody can keep.
//
// The rule: a pure module returns an honest empty answer, never an exception.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The pure V3 + V2 analysis surface. A module added here gets the guarantee for
// free; one left out is one where the bug can come back.
const MODULES = {
  'observe/observations': require('../src/serviceTests/observe/observations'),
  'health/serviceHealth': require('../src/serviceTests/health/serviceHealth'),
  'correlate/correlate': require('../src/serviceTests/correlate/correlate'),
  'incidents/lifecycle': require('../src/serviceTests/incidents/lifecycle'),
  'a11y/rules': require('../src/serviceTests/a11y/rules'),
  'visual/compare': require('../src/serviceTests/visual/compare'),
  'journeys/health': require('../src/serviceTests/journeys/health'),
  'rootcause/rootCause': require('../src/serviceTests/rootcause/rootCause'),
  'history/recurrence': require('../src/serviceTests/history/recurrence'),
  'dependencies/dependencies': require('../src/serviceTests/dependencies/dependencies'),
  'anomaly/anomalies': require('../src/serviceTests/anomaly/anomalies'),
  'alerts/grouping': require('../src/serviceTests/alerts/grouping'),
  'ai/context': require('../src/serviceTests/ai/context'),
  'analysis/baseline': require('../src/serviceTests/analysis/baseline'),
};

// The shapes that have actually caused this. `null` is the one that bites —
// it is what a database hands back for a missing row, and what every
// `= {}` default fails to catch.
const JUNK = [null, undefined, 'nope', 42, true, [], {}, { nested: { deep: null } }];

// Functions that are DOCUMENTED to throw are listed here with the reason. An
// empty list is the goal; an entry is a deliberate exception, not an oversight.
const ALLOWED_TO_THROW = {
  // decodePng refuses what it cannot read BY NAME rather than guessing — a
  // decoder that quietly mis-reads an image produces a difference that looks
  // real and is not. Its caller turns the throw into "uncomparable".
  'visual/compare': [],
};

test('no pure analysis module throws on junk input', () => {
  const failures = [];

  for (const [name, module] of Object.entries(MODULES)) {
    const allowed = ALLOWED_TO_THROW[name] || [];
    for (const [fnName, fn] of Object.entries(module)) {
      if (typeof fn !== 'function' || allowed.includes(fnName)) continue;
      for (const junk of JUNK) {
        try {
          fn(junk);
        } catch (err) {
          failures.push(`${name}.${fnName}(${JSON.stringify(junk)}) threw: ${err.message}`);
        }
        // And with a second argument, since several take (a, b).
        try {
          fn(junk, junk);
        } catch (err) {
          failures.push(`${name}.${fnName}(${JSON.stringify(junk)}, …) threw: ${err.message}`);
        }
      }
    }
  }

  assert.deepEqual(failures, [],
    'a pure module must return an honest empty answer rather than throw — '
    + 'these run on a dashboard, where an exception loses the page, not just the analysis');
});

test('the guard would actually catch the bug it was written for', () => {
  // A guard that does not fail on the real defect is worth nothing. This is the
  // exact shape that shipped three times.
  const buggy = ({ journeys = [] } = {}) => journeys.length;
  assert.throws(() => buggy(null), /Cannot read properties of null/,
    'the default-parameter trap still behaves the way this test assumes');

  // And the shape that fixes it.
  const fixed = (raw = {}) => {
    const input = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return (Array.isArray(input.journeys) ? input.journeys : []).length;
  };
  assert.equal(fixed(null), 0);
  assert.equal(fixed('nonsense'), 0);
});
