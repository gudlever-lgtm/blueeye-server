'use strict';

const silentLogger = { info() {}, warn() {}, error() {} };

// Signs the PRIVILEGED server -> agent commands (upgrade / delete / install-tool)
// with the managed release key, so an agent can tell "the server asked for this"
// apart from "something holding a socket asked for this".
//
// Without it, those three commands are authenticated only by the WebSocket
// session: anything that reaches an agent's live socket can reconfigure or wipe
// the host. The agent verifies against the release public key it already pins for
// signed updates (blueeye-agent src/commandAuth.js) and can be configured to
// REQUIRE a signature (BLUEEYE_REQUIRE_SIGNED_COMMANDS).
//
// Two fields are added before signing:
//   agentId  — binds the signature to one agent, so a captured command cannot be
//              replayed against the rest of the fleet;
//   issuedAt — binds it to a moment, so it cannot be replayed later. The agent
//              accepts a ±5 min window.
// The transport correlation `id` is stamped on later by sendCommandAndWait and is
// deliberately NOT part of the signed payload — the agent excludes it too.
//
// A server with no managed signing key returns the command unchanged, so existing
// deployments keep working exactly as before (the agent stays lenient by default).
function createCommandSigner({ releaseKeyService = null, logger = silentLogger, now = () => new Date() } = {}) {
  function canSign() {
    return !!(releaseKeyService && typeof releaseKeyService.sign === 'function'
      && typeof releaseKeyService.canSign === 'function' && releaseKeyService.canSign());
  }

  // Returns the command with agentId/issuedAt/commandSignature set, or unchanged
  // when this server cannot sign. Never throws — a signing failure must not stop
  // an operator's action; it degrades to the pre-signing behaviour.
  function sign(agentId, command) {
    if (!canSign()) return command;
    const payload = { ...command, agentId, issuedAt: now().toISOString() };
    try {
      return { ...payload, commandSignature: releaseKeyService.sign(payload) };
    } catch (err) {
      logger.warn(`command signing failed (${err.message}); sending unsigned`);
      return command;
    }
  }

  return { sign, canSign };
}

module.exports = { createCommandSigner };
