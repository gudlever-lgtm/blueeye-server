'use strict';

// Validation for a burst request.
//
// THE CAPS ARE HERE *AND* IN THE AGENT. This file refuses what a user can ask
// for; blueeye-agent/src/burst.js clamps what it will actually emit. Neither is
// redundant: a burst is a packet generator, and the thing that emits the
// packets must not depend on the thing that asked for them having validated
// correctly. A future server with a bug, or a replayed frame, must not be able
// to turn an agent into a flood.
//
// The server REFUSES out of range where the agent CLAMPS. That asymmetry is
// deliberate: a person filling in a form should be told 3600 is too long, while
// an agent handed a bad number mid-fault should still measure something.

const MAX_SECONDS = 120;
const MIN_SECONDS = 5;
const MAX_HZ = 2;
const MIN_HZ = 0.2;
const TARGET_MAX = 255;

// Only the probes that FIT in one tick. A traceroute or a page load takes
// longer than the interval, so every tick would overlap the last.
const PROBES = ['ping', 'tcp', 'dns'];

// A hostname or an IP literal. Not a URL and not a CIDR.
const TARGET_RE = /^[A-Za-z0-9._:-]{1,255}$/;

function validateBurstRequest(raw) {
  const errors = {};
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const value = {};

  const target = typeof body.target === 'string' ? body.target.trim().slice(0, TARGET_MAX) : '';
  if (!target || !TARGET_RE.test(target)) {
    errors.target = 'target is required (a hostname or an IP address)';
  } else {
    value.target = target;
  }

  const agentId = Number(body.agentId);
  if (!Number.isInteger(agentId) || agentId < 1) {
    errors.agentId = 'agentId must be a positive integer';
  } else {
    value.agentId = agentId;
  }

  if (body.seconds === undefined || body.seconds === null) {
    value.seconds = 60;
  } else {
    const n = Number(body.seconds);
    if (!Number.isInteger(n) || n < MIN_SECONDS || n > MAX_SECONDS) {
      errors.seconds = `seconds must be an integer between ${MIN_SECONDS} and ${MAX_SECONDS}`;
    } else {
      value.seconds = n;
    }
  }

  if (body.hz === undefined || body.hz === null) {
    value.hz = 1;
  } else {
    const n = Number(body.hz);
    if (!Number.isFinite(n) || n < MIN_HZ || n > MAX_HZ) {
      errors.hz = `hz must be between ${MIN_HZ} and ${MAX_HZ}`;
    } else {
      value.hz = n;
    }
  }

  if (body.probe !== undefined && body.probe !== null) {
    if (!PROBES.includes(body.probe)) {
      errors.probe = `probe must be one of: ${PROBES.join(', ')}`;
    } else {
      value.probe = body.probe;
    }
  } else {
    value.probe = 'ping';
  }

  // A tcp burst needs somewhere to connect. Defaulting it would measure a port
  // nobody asked about and report the answer as if they had.
  if (value.probe === 'tcp') {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.port = 'port is required for a tcp burst (1-65535)';
    } else {
      value.port = port;
    }
  } else if (body.port !== undefined && body.port !== null) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'port must be between 1 and 65535';
    else value.port = port;
  }

  if (body.size !== undefined && body.size !== null) {
    const n = Number(body.size);
    if (!Number.isInteger(n) || n < 1 || n > 9000) errors.size = 'size must be between 1 and 9000 bytes';
    else value.size = n;
  }

  if (body.df !== undefined && body.df !== null) {
    if (typeof body.df !== 'boolean') errors.df = 'df must be a boolean';
    else value.df = body.df;
  }

  if (Object.keys(errors).length) return { errors };
  return { value };
}

function validateBurstQuery(query, errors) {
  const q0 = query && typeof query === 'object' ? query : {};
  const errs = errors && typeof errors === 'object' ? errors : {};
  const out = { limit: 25, offset: 0 };

  if (q0.agentId !== undefined && q0.agentId !== '') {
    const n = Number(q0.agentId);
    if (!Number.isInteger(n) || n < 1) errs.agentId = 'agentId must be a positive integer';
    else out.agentId = n;
  }
  if (q0.limit !== undefined && q0.limit !== '') {
    const n = Number(q0.limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) errs.limit = 'limit must be an integer between 1 and 100';
    else out.limit = n;
  }
  if (q0.offset !== undefined && q0.offset !== '') {
    const n = Number(q0.offset);
    if (!Number.isInteger(n) || n < 0 || n > 100000) errs.offset = 'offset must be an integer between 0 and 100000';
    else out.offset = n;
  }
  return Object.keys(errs).length ? undefined : out;
}

module.exports = {
  validateBurstRequest,
  validateBurstQuery,
  PROBES,
  MAX_SECONDS,
  MIN_SECONDS,
  MAX_HZ,
  MIN_HZ,
};
