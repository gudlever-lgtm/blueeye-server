'use strict';

const { LOCALES, DEFAULT_LOCALE } = require('../diagnose/catalog');

// Input validation for the symptom-first diagnosis API. Pure: a body in,
// { value } or { errors } out — the shape every validator in src/validation uses
// and the one the validation gate sweeps for.

// The brief's bound, and a real one. A thousand characters is several paragraphs
// of description; past that somebody is pasting a log, and a log is not a
// symptom. It is also the limit on what can be sent to a third-party model,
// which is a second reason not to let it grow.
const MAX_DESCRIPTION = 1000;
const MAX_TARGET = 255;
// Same shape as the probe validator's host rule: must start alphanumeric so it
// can never be read as a CLI flag, and only host-safe characters. A target here
// ends up in an agent's argv.
const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/;

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined; // undefined = present but invalid
}

function validateDiagnoseRequest(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  const description = typeof b.description === 'string' ? b.description.trim() : '';
  if (description === '') return { errors: { description: 'describe the problem in your own words' } };
  if (description.length > MAX_DESCRIPTION) {
    return { errors: { description: `description must be at most ${MAX_DESCRIPTION} characters` } };
  }

  const value = { description };

  if (b.locale !== undefined && b.locale !== null && b.locale !== '') {
    if (!LOCALES.includes(b.locale)) return { errors: { locale: `locale must be one of ${LOCALES.join(', ')}` } };
    value.locale = b.locale;
  } else {
    value.locale = DEFAULT_LOCALE;
  }

  const agentId = intOrNull(b.agentId ?? b.agent_id);
  if (agentId === undefined) return { errors: { agentId: 'agentId must be a positive integer' } };
  if (agentId !== null) value.agentId = agentId;

  const peerAgentId = intOrNull(b.peerAgentId ?? b.peer_agent_id);
  if (peerAgentId === undefined) return { errors: { peerAgentId: 'peerAgentId must be a positive integer' } };
  if (peerAgentId !== null) {
    if (agentId !== null && peerAgentId === agentId) {
      return { errors: { peerAgentId: 'the far end must be a different agent' } };
    }
    value.peerAgentId = peerAgentId;
  }

  if (b.target !== undefined && b.target !== null && String(b.target).trim() !== '') {
    const target = String(b.target).trim();
    if (target.length > MAX_TARGET || !HOST_RE.test(target)) {
      return { errors: { target: 'target must be a valid hostname or IP address' } };
    }
    value.target = target;
  }

  // Opting OUT of the AI per request. Opting IN is not a request-level decision:
  // whether a description may leave the building is the administrator's call,
  // configured once, not something a caller can turn on for itself.
  if (b.useAi !== undefined) value.useAi = b.useAi !== false && b.useAi !== 'false';

  return { value };
}

module.exports = { validateDiagnoseRequest, MAX_DESCRIPTION, MAX_TARGET };
