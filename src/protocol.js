'use strict';

// Agent ↔ server wire-contract version. Bumped only on a BREAKING change to the
// REST/WebSocket contract documented in blueeye-agent/PROTOCOL.md (additive,
// backward-compatible changes do NOT bump it). The agent declares its version in
// the `/ws/agent` upgrade header `X-BlueEye-Protocol`; the server echoes its own
// in the `connected` frame. A mismatch is logged (warn) on both sides but is
// NEVER fatal — agents update on their own schedule, so the server must stay
// backward-compatible. An absent header means a pre-versioning agent → treated
// as version 1.
//
// MUST equal blueeye-agent/src/protocol.js PROTOCOL_VERSION. (Rec 5 consolidates
// this + canonicalize + the Ed25519 verifier into one shared, drift-tested module.)
const PROTOCOL_VERSION = 1;

module.exports = { PROTOCOL_VERSION };
