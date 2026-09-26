'use strict';

// Input validation for the Connection Test (POST /api/connection-test/run and
// /schedule). A connection test is an address plus a selection from the
// catalogue in src/connectionTest/checks.js — so this module owns the bounds on
// the selection, and delegates the target itself to validateProbeSpec, which is
// the rule that already protects every agent's argv from a hostile host string.

const { validateProbeSpec } = require('./probeValidation');
const { CHECK_IDS } = require('../connectionTest/checks');
const { validateRecurrence } = require('../schedule/recurrence');
const { MAX_ITEMS } = require('./testPackageValidation');

// One click may not turn into an unbounded number of commands: each round is
// every selected check, pushed to the agent at once.
const MAX_ROUNDS = 20;
const NAME_MAX = 255;

// The target, checked by the same rule a hand-typed probe target is. Reusing
// validateProbeSpec rather than re-implementing the host pattern means the two
// can never drift — a host this accepts is a host an agent will be asked to
// probe, and nothing else.
function validateHost(raw, errors) {
  const host = typeof raw === 'string' ? raw.trim() : '';
  if (!host) { errors.host = 'host is required — an IP address or a DNS name'; return undefined; }
  const { errors: pe } = validateProbeSpec({ type: 'ping', host });
  if (pe) { errors.host = 'host must be a valid IP address or DNS name'; return undefined; }
  return host;
}

function validateChecks(raw, errors) {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.checks = 'checks must be a non-empty array of check ids';
    return undefined;
  }
  if (raw.length > CHECK_IDS.length) { errors.checks = 'too many checks'; return undefined; }
  const out = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !CHECK_IDS.includes(id)) {
      errors.checks = `unknown check id — must be one of: ${CHECK_IDS.join(', ')}`;
      return undefined;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function validateAgentId(raw, errors) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) { errors.agentId = 'agentId must be a positive integer'; return undefined; }
  return n;
}

function validateRounds(raw, errors, field) {
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ROUNDS) {
    errors[field] = `${field} must be an integer between 1 and ${MAX_ROUNDS}`;
    return undefined;
  }
  return n;
}

// POST /run — dispatch the selected checks against one agent, now.
function validateConnectionTestRun(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  const agentId = validateAgentId(input.agentId, errors);
  if (agentId !== undefined) value.agentId = agentId;
  const host = validateHost(input.host, errors);
  if (host !== undefined) value.host = host;
  const checks = validateChecks(input.checks, errors);
  if (checks !== undefined) value.checks = checks;

  return Object.keys(errors).length ? { errors } : { value };
}

// POST /schedule — the same test, saved as a recurring test package.
function validateConnectionTestSchedule(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  const agentId = validateAgentId(input.agentId, errors);
  if (agentId !== undefined) value.agentId = agentId;
  const host = validateHost(input.host, errors);
  if (host !== undefined) value.host = host;
  const checks = validateChecks(input.checks, errors);
  if (checks !== undefined) value.checks = checks;

  const runs = validateRounds(input.runs, errors, 'runs');
  if (runs !== undefined) value.runs = runs;

  // A scheduled run becomes one test package, and a package carries at most
  // MAX_ITEMS items — so "every check, three times per run" has a ceiling, and
  // the operator is told which knob to turn down rather than getting a package
  // that silently runs fewer checks than it shows.
  if (checks !== undefined && runs !== undefined && checks.length * runs > MAX_ITEMS) {
    errors.runs = `a scheduled run may carry at most ${MAX_ITEMS} tests (${checks.length} checks × ${runs} runs)`;
  }

  const { value: recurrence, errors: re } = validateRecurrence(input.recurrence);
  if (re) errors.recurrence = Object.values(re).join('; ');
  else value.recurrence = recurrence;

  if (input.name !== undefined && input.name !== null && input.name !== '') {
    const name = String(input.name).trim();
    if (!name || name.length > NAME_MAX) errors.name = `name must be 1-${NAME_MAX} characters`;
    else value.name = name;
  }

  return Object.keys(errors).length ? { errors } : { value };
}

// POST /walk — one destination, the whole ladder, plus what the operator says
// is wrong. The symptom is free text and is treated as DATA everywhere it goes:
// it is bounded here, echoed back beside the verdict, and written to the audit
// detail. Nothing reads it to decide what to run — the ladder is fixed, so a
// sentence typed into this field can never change which commands an agent is
// asked to execute.
const SYMPTOM_MAX = 500;

function validateSymptom(raw, errors) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') { errors.symptom = 'symptom must be text'; return undefined; }
  const s = raw.trim();
  if (!s) return null;
  if (s.length > SYMPTOM_MAX) { errors.symptom = `symptom must be at most ${SYMPTOM_MAX} characters`; return undefined; }
  return s;
}

function validateConnectionTestWalk(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  const agentId = validateAgentId(input.agentId, errors);
  if (agentId !== undefined) value.agentId = agentId;
  const host = validateHost(input.host, errors);
  if (host !== undefined) value.host = host;
  const symptom = validateSymptom(input.symptom, errors);
  if (symptom !== undefined) value.symptom = symptom;

  return Object.keys(errors).length ? { errors } : { value };
}

// GET /ladder — read the verdict for a destination from results already stored.
// Same host rule as a run: a query that could name a host a run could not would
// be a second, quietly different idea of what a destination is.
function validateLadderQuery(query) {
  const input = query && typeof query === 'object' ? query : {};
  const errors = {};
  const value = {};

  const agentId = validateAgentId(input.agentId, errors);
  if (agentId !== undefined) value.agentId = agentId;
  const host = validateHost(input.host, errors);
  if (host !== undefined) value.host = host;
  const symptom = validateSymptom(input.symptom, errors);
  if (symptom !== undefined) value.symptom = symptom;

  return Object.keys(errors).length ? { errors } : { value };
}

module.exports = {
  validateConnectionTestRun,
  validateConnectionTestSchedule,
  validateConnectionTestWalk,
  validateLadderQuery,
  MAX_ROUNDS,
  SYMPTOM_MAX,
};
