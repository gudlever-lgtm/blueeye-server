'use strict';

const { isNewer } = require('../lib/version');

// Deciding WHAT to push to an agent, and getting it there.
//
// This logic used to live inside POST /agents/:id/update, which was fine while
// there was exactly one way to start an update: an admin clicking a button on a
// connected agent. There are now three — that click, a fleet rollout, and an
// agent that noticed on its own that it is behind — and all three have to make
// the same decision, or the fleet ends up on whatever the least careful path
// chose.
//
// The decision itself, in order:
//
//   1. Prefer a SIGNED release. If none is published, or the newest one is older
//      than the source now on disk, mint one — a stale signature must not pin the
//      fleet backwards (the host pulls the agent to v0.27.0, the store still
//      holds a signed v0.24.0, and every Update pushes v0.24.0 while the
//      dashboard reports the fleet up to date).
//   2. If it is still behind the source, push the newer UNSIGNED source rather
//      than a signature for code nobody asked for. An agent pinned to a release
//      key refuses that — visibly, which the silent downgrade was not.
//   3. With neither, there is nothing to push.
function createAgentUpdateService({
  releaseStore = null,
  agentSourceStore = null,
  publishRelease = null,
  releaseKeyService = null,
  commandQueue = null,
  logger = console,
} = {}) {
  const sourceVersion = () =>
    (agentSourceStore && typeof agentSourceStore.sourceVersion === 'function' ? agentSourceStore.sourceVersion() : null);
  const latestRelease = () =>
    (releaseStore && typeof releaseStore.latest === 'function' ? releaseStore.latest() : null);
  const haveSource = () =>
    !!(agentSourceStore && typeof agentSourceStore.available === 'function' && agentSourceStore.available());

  // The agent version this server offers: the newer of the signed release and the
  // packaged source. Same rule as GET /system/version, deliberately — the number
  // the dashboard shows and the number an agent is compared against must be one
  // number, or "up to date" and "behind" disagree on the same host.
  function offeredVersion() {
    const rel = latestRelease();
    const src = sourceVersion();
    if (!rel || !rel.version) return src;
    if (!src) return rel.version;
    return isNewer(src, rel.version) ? src : rel.version;
  }

  // Is this agent's reported version older than what we offer? Unknown on either
  // side means "don't know", which is never a reason to push code.
  function isBehind(agentVersion) {
    const offered = offeredVersion();
    if (!offered || !agentVersion) return false;
    return isNewer(offered, String(agentVersion));
  }

  // Builds the command to send. Resolves
  //   { ok: true, command, signed, signedReason, targetVersion }
  //   { ok: false, reason: 'no-source' }
  async function resolvePayload({ log = logger } = {}) {
    let release = latestRelease();
    const src = sourceVersion();

    const releaseIsStale = !release || (src && release.version && isNewer(src, release.version));
    if (releaseIsStale && typeof publishRelease === 'function') {
      try {
        const minted = await publishRelease();
        if (minted && minted.version) release = latestRelease();
      } catch (err) {
        log.warn(`agent-update: on-demand signed-release publish failed (${err.message}); falling back to source bundle`);
      }
    }
    if (release && src && isNewer(src, release.version) && haveSource()) {
      log.warn(
        `agent-update: signed release v${release.version} is older than the packaged source v${src} `
        + '— pushing the unsigned source bundle. Generate a release signing key so updates stay signed.'
      );
      release = null;
    }
    if (!release && !haveSource()) return { ok: false, reason: 'no-source' };

    // WHY the push is unsigned, when it is. The dashboard used to guess ("this
    // server has no release signing key") and send the operator to the wrong
    // screen; a key that exists but cannot sign — an env-only public key, or a
    // stored key whose private half no longer decrypts — looks identical from the
    // outside and needs different advice. Ask the key service instead.
    const signedReason = release
      ? null
      : (releaseKeyService && typeof releaseKeyService.signBlockedReason === 'function'
        ? (releaseKeyService.signBlockedReason() || 'sign-failed')
        : 'no-key');

    const command = release
      ? { name: 'update', version: release.version, sha256: release.sha256, signature: release.signature }
      : { name: 'update', sha256: agentSourceStore.sha256, version: sourceVersion() };

    return { ok: true, command, signed: !!release, signedReason, targetVersion: command.version };
  }

  // Leaves an update waiting for an agent that is not connected. The payload is
  // stored unsigned and signed at delivery — a signature carries `issuedAt` and
  // the agent refuses one more than five minutes off its clock, so a signature
  // made now would be dead by the time the host dials in.
  async function queue(agentId, command, { ttlSec, auditId = null } = {}) {
    if (!commandQueue || typeof commandQueue.enqueue !== 'function') return { queued: false, reason: 'no-queue' };
    try {
      const id = await commandQueue.enqueue(agentId, command, { ttlSec, auditId });
      return { queued: true, id: id || null };
    } catch (err) {
      logger.error(`agent-update: could not queue command for agent ${agentId}: ${err.message}`);
      return { queued: false, reason: 'queue-failed', error: err.message };
    }
  }

  return { offeredVersion, isBehind, resolvePayload, queue, sourceVersion, latestRelease, haveSource };
}

module.exports = { createAgentUpdateService };
