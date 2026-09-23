'use strict';

// Where the REVERSE test of a two-ended diagnosis must point.
//
// The asymmetric-routing question is "does the way BACK follow the way out?".
// The way back runs from the far end to the agent that started the session, so
// the far-end (peer) agent has to probe the ORIGIN agent. It used to probe the
// session's own target instead — the same destination, from somewhere else —
// which measures a second forward path and never the return path at all.
//
// The origin's addresses are the ones it reports itself (capabilities.ips,
// blueeye-agent src/localIps.js: every non-loopback, non-link-local interface
// address). Which one the peer should aim at is a judgement, made by these
// rules in this order, and every one of them is said back in the test's `why`:
//
//   1. the same family as the forward target (an IPv6 path is compared with an
//      IPv6 path);
//   2. the same scope as the forward target: a private target means the two
//      ends talk over a private network, so a private origin address; a public
//      target, a public one when the origin has any;
//   3. not a container bridge (docker0's 172.17.0.0/16 and friends) — nothing
//      outside the host routes to it;
//   4. the longest prefix shared with the peer's own addresses — the address
//      the peer is most likely to have a route to;
//   5. the order the agent reported them in.
//
// No address at all ⇒ no reverse test, with the reason, rather than a test at
// the wrong target that would produce a confident-looking wrong answer.
//
// LIMIT, said in the `why` too: an origin behind NAT has no address the peer
// can reach from outside, and none of this can know that. The reverse result is
// then a failure that says "unreachable", not "asymmetric".

const { familyOf, commonPrefixBits, isPrivate } = require('./addr');

// Docker / podman / libvirt default bridges. Local to the host by construction.
const BRIDGE_PREFIXES = [/^172\.17\./, /^172\.18\./, /^192\.168\.122\./, /^10\.88\./];

function asObject(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return null;
}

function reportedIps(agent) {
  const caps = asObject(agent && agent.capabilities);
  const list = caps && Array.isArray(caps.ips) ? caps.ips : [];
  return list.map((ip) => String(ip || '').trim()).filter((ip) => familyOf(ip) !== null);
}

const nameOf = (a) => (a && (a.display_name || a.hostname)) || (a && a.id != null ? `agent ${a.id}` : 'the origin agent');

// Chooses the origin address the peer should probe.
//
//   pickReverseTarget({ origin, peer, forwardTarget })
//     → { address, why }                     a target, and the sentence saying why
//     → { address: null, reason }            no usable address; the reason
function pickReverseTarget({ origin, peer = null, forwardTarget = null } = {}) {
  const ips = reportedIps(origin);
  if (!ips.length) {
    return {
      address: null,
      reason: `${nameOf(origin)} has not reported its own addresses (capabilities.ips), so the far end has nothing to probe back to. Update or restart that agent and create the plan again.`,
    };
  }
  const wantFamily = familyOf(forwardTarget) || 4; // a hostname target is traced as IPv4
  const wantPrivate = familyOf(forwardTarget) ? isPrivate(forwardTarget) : null;
  const peerIps = reportedIps(peer);

  const scored = ips.map((ip, order) => ({
    ip,
    order,
    family: familyOf(ip) === wantFamily,
    scope: wantPrivate === null ? true : isPrivate(ip) === wantPrivate,
    notBridge: !BRIDGE_PREFIXES.some((re) => re.test(ip)),
    shared: peerIps.reduce((best, p) => Math.max(best, commonPrefixBits(ip, p)), 0),
  }));
  scored.sort((a, b) => (Number(b.family) - Number(a.family))
    || (Number(b.scope) - Number(a.scope))
    || (Number(b.notBridge) - Number(a.notBridge))
    || (b.shared - a.shared)
    || (a.order - b.order));
  const best = scored[0];

  const reasons = [];
  reasons.push(best.family ? `IPv${wantFamily} like the forward target` : `the only family ${nameOf(origin)} reports (the forward target is IPv${wantFamily})`);
  if (wantPrivate !== null) {
    reasons.push(best.scope ? (wantPrivate ? 'a private address, as the target is' : 'a public address, as the target is')
      : (wantPrivate ? 'no private address was reported' : 'no public address was reported'));
  }
  if (best.shared > 0 && peerIps.length) reasons.push(`it shares a /${best.shared} with the far-end agent`);
  const others = ips.length - 1;
  return {
    address: best.ip,
    why: `Probes back from the far end to ${nameOf(origin)} at ${best.ip} (reported by that agent; chosen as ${reasons.join(', ')}${others > 0 ? `, out of ${ips.length} it reports` : ''}), so this measures the RETURN path. If ${best.ip} sits behind NAT the far end cannot reach it and the result says "unreachable", not "asymmetric".`,
  };
}

module.exports = { pickReverseTarget, reportedIps };
