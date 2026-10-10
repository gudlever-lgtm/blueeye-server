'use strict';

const crypto = require('crypto');

const silentLogger = { info() {}, warn() {}, error() {} };

// How long a signed command stays valid. Short on purpose: a privileged command
// is pushed down a live socket within milliseconds of being built, so the only
// thing a long window buys is a replay opportunity. Still inside the agent's
// ±5 min clock-skew tolerance, so a host with a slightly wrong clock keeps
// working.
const DEFAULT_TTL_MS = 120000;

// Thrown instead of sending an UNSIGNED privileged command. The status/expose
// pair is what middleware/errorHandler turns into a 503 the operator can read:
// a privileged action that could not be authenticated has to fail visibly, not
// quietly become an action authenticated by nothing but the socket.
class CommandSigningError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CommandSigningError';
    this.code = code;
    this.statusCode = 503;
    this.expose = true;
  }
}

// Signs the PRIVILEGED server -> agent commands (upgrade / delete / install-tool
// / rekey) with the managed release key, so an agent can tell "the server asked
// for this" apart from "something holding a socket asked for this".
//
// Without it, those commands are authenticated only by the WebSocket session:
// anything that reaches an agent's live socket can reconfigure or wipe the host.
// The agent verifies against the release public key it already pins for signed
// updates (blueeye-agent src/commandAuth.js).
//
// Four fields are added before signing:
//   agentId    — binds the signature to one agent, so a captured command cannot
//                be replayed against the rest of the fleet;
//   commandId  — a per-command nonce, so a captured command cannot be replayed
//                against the SAME agent inside its validity window (the agent
//                remembers the ids it has accepted);
//   issuedAt   — when it was made;
//   expiresAt  — when it stops being valid, stated explicitly rather than left
//                to whatever skew window the agent happens to allow.
// The transport correlation `id` is stamped on later by sendCommandAndWait and is
// deliberately NOT part of the signed payload — the agent excludes it too.
//
// FAIL CLOSED. A signing failure used to degrade to an unsigned command, which
// handed an attacker a downgrade: break the signer (or catch a server whose key
// cannot be decrypted) and every agent that has not yet latched accepts
// unsigned commands again. It now throws. A server with no managed signing key
// at all still returns the command unchanged — that is a deployment that never
// had the signature, not one losing it — unless BLUEEYE_REQUIRE_COMMAND_SIGNING
// is set, which makes even that refuse.
function createCommandSigner({
  releaseKeyService = null,
  logger = silentLogger,
  now = () => new Date(),
  ttlMs = DEFAULT_TTL_MS,
  // Audit sink for a refused privileged command (wired to auditEventsRepo in
  // server.js). Best-effort: it must never swallow the refusal.
  onFailure = null,
  // Refuse privileged commands outright when this server cannot sign them.
  // Off by default so a deployment that has never had a signing key stays
  // manageable; on, nothing privileged leaves unsigned, ever.
  requireSigning = /^(1|true|yes|on)$/i.test(String(process.env.BLUEEYE_REQUIRE_COMMAND_SIGNING || '').trim()),
  newCommandId = () => crypto.randomUUID(),
} = {}) {
  function canSign() {
    return !!(releaseKeyService && typeof releaseKeyService.sign === 'function'
      && typeof releaseKeyService.canSign === 'function' && releaseKeyService.canSign());
  }

  function fail(message, code, command) {
    logger.error(`command signing: ${message}`);
    if (typeof onFailure === 'function') {
      try { onFailure({ code, message, command: (command && command.name) || null }); } catch { /* auditing a refusal must not replace it */ }
    }
    throw new CommandSigningError(message, code);
  }

  // Returns the command with agentId/commandId/issuedAt/expiresAt/commandSignature
  // set. Throws CommandSigningError rather than returning an unsigned command
  // when signing was possible but failed.
  function sign(agentId, command) {
    if (!canSign()) {
      if (requireSigning) {
        return fail(
          'this server has no managed signing key, and BLUEEYE_REQUIRE_COMMAND_SIGNING is set, '
          + 'so the privileged command was not sent',
          'COMMAND_SIGNING_UNAVAILABLE',
          command,
        );
      }
      return command;
    }
    const issuedAt = now();
    const payload = {
      ...command,
      agentId,
      commandId: newCommandId(),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
    };
    try {
      return { ...payload, commandSignature: releaseKeyService.sign(payload) };
    } catch (err) {
      return fail(
        `could not sign the privileged command (${err.message}); it was not sent. `
        + 'Sending it unsigned would downgrade the agent to socket-only authentication.',
        'COMMAND_SIGNING_FAILED',
        command,
      );
    }
  }

  return { sign, canSign };
}

module.exports = { createCommandSigner, CommandSigningError, DEFAULT_TTL_MS };
