'use strict';

// Is something answering for the destination that is not the destination?
//
// A load balancer, a reverse proxy or a NAT in the path is the reason "the
// network is up but the application is down" is a sentence that makes sense. It
// answers ICMP from the VIP while the pool behind it is empty; it completes a
// TCP handshake while the backend is gone; it terminates TLS with its own
// certificate. Every layer below it reports green and the service is down.
//
// BlueEyes could only ever GUESS at one before this module: src/serviceTests/
// rootcause/rootCause.js infers "a load balancer or reverse proxy" from an HTTP
// 502, and marks that inference `basis: inferred` precisely because nothing was
// ever looked at. This looks.
//
// The two protocols take different paths on purpose. `traceroute` walks the
// path ICMP takes; `tcptraceroute` walks the path a SYN to the application port
// takes. On a plain routed path they end at the same address. They end at
// DIFFERENT addresses when something terminates the TCP session before the host
// the ICMP reached — which is what a load balancer, a proxy and a destination
// NAT all are.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It never compares hop COUNTS: ICMP and
// TCP are policed differently at nearly every hop, so two paths of different
// lengths to the same address are the normal case, and reading that as a
// finding would report a load balancer on most of the internet. Only the
// address a path ENDS at, and addresses seen at one hop within a single run,
// are evidence.

// The same three words the Service Assurance root-cause model uses (observed /
// inferred / unobservable), imported rather than redefined: a finding that says
// "observed" here has to mean what it means there, or the two screens teach an
// operator two different vocabularies for the same distinction.
const { BASIS } = require('../serviceTests/rootcause/rootCause');

// An HTTP status that says a gateway answered for an upstream that did not.
// Inference, not sighting: nothing was inspected, the status merely names the
// shape of what produced it.
const GATEWAY_STATUS = { 502: 'bad gateway', 503: 'service unavailable', 504: 'gateway timeout' };

// The last hop that actually answered, and its address. A trailing run of
// silent hops is the normal tail of a traceroute that never reached the target;
// it is not an address and it is not evidence.
function lastResponder(result) {
  const hops = result && Array.isArray(result.hops) ? result.hops : [];
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const h = hops[i];
    if (h && typeof h.ip === 'string' && h.ip) return { ip: h.ip, hop: typeof h.hop === 'number' ? h.hop : i + 1 };
  }
  return null;
}

// Every distinct address that answered at one hop of ONE run. Only meaningful
// when the agent sent the per-hop `ips` list (blueeye-agent 0.30+): an older
// agent reports one address per hop however many answered, so its single
// address is not a measurement of a single next hop and must not be read as
// one. Absent list in, undefined out.
function widestHop(result) {
  const hops = result && Array.isArray(result.hops) ? result.hops : [];
  if (!hops.some((h) => h && Array.isArray(h.ips))) return undefined;
  let best = null;
  for (const h of hops) {
    if (!h) continue;
    const set = new Set([...(h.ip ? [h.ip] : []), ...(Array.isArray(h.ips) ? h.ips : [])].filter(Boolean));
    if (!best || set.size > best.ips.length) best = { hop: typeof h.hop === 'number' ? h.hop : null, ips: [...set] };
  }
  return best && best.ips.length > 1 ? best : null;
}

// Does the certificate the host presented name the host we asked for? A shared
// front end that terminates TLS for many names, asked for one it does not carry,
// answers with the wrong name rather than refusing — the mismatch is the front
// end identifying itself.
function certMismatch(tlsResult, host) {
  const tls = tlsResult && tlsResult.tls && typeof tlsResult.tls === 'object' ? tlsResult.tls : null;
  if (!tls || tls.hostnameMatches !== false) return null;
  const want = tls.servername || host || null;
  return { want, subject: tls.subject || null };
}

// Look for a middlebox between the agent and the destination.
//
//   traceroute    the ICMP path       (result row, or null)
//   tcptraceroute the TCP path        (result row, or null)
//   tls           the certificate     (result row, or null)
//   http          the application     (result row, or null)
//   host          what was asked for
//
// Returns { present, basis, evidence[] }:
//   present true   something is answering for the destination
//   present false  both paths were walked and they agree — nothing in between
//   present null   not enough was measured to say. NEVER read as "nothing
//                  there": a question that was not asked has no answer, and a
//                  false here would rule out the one cause that explains a
//                  green network under a dead service.
function detectMiddlebox({ traceroute = null, tcptraceroute = null, tls = null, http = null, host = null } = {}) {
  const evidence = [];
  let present = null;
  let basis = null;

  const icmpEnd = lastResponder(traceroute);
  const tcpEnd = lastResponder(tcptraceroute);
  // Both paths walked: the comparison is answerable either way, so this is the
  // only branch that may conclude "nothing in between".
  if (icmpEnd && tcpEnd) {
    if (icmpEnd.ip !== tcpEnd.ip) {
      present = true;
      basis = BASIS.OBSERVED;
      evidence.push({
        kind: 'path_divergence',
        basis: BASIS.OBSERVED,
        icmp_endpoint: icmpEnd.ip,
        tcp_endpoint: tcpEnd.ip,
        text: `ICMP ends at ${icmpEnd.ip} (hop ${icmpEnd.hop}), the TCP session ends at ${tcpEnd.ip} (hop ${tcpEnd.hop}) — something terminates the connection before the host that answers ping`,
      });
    } else {
      present = false;
      evidence.push({
        kind: 'paths_agree',
        basis: BASIS.OBSERVED,
        endpoint: icmpEnd.ip,
        text: `both paths end at ${icmpEnd.ip} — nothing between the agent and the destination is terminating the session`,
      });
    }
  }

  // Several addresses at one hop of a single run. A balanced path, whether that
  // is ECMP in the network or a pool in front of the service; either way more
  // than one machine can answer and a test that hits one says nothing about the
  // others.
  for (const [label, result] of [['icmp', traceroute], ['tcp', tcptraceroute]]) {
    const wide = widestHop(result);
    if (!wide) continue;
    if (present !== true) { present = true; basis = BASIS.OBSERVED; }
    evidence.push({
      kind: 'multi_path_hop',
      basis: BASIS.OBSERVED,
      hop: wide.hop,
      ips: wide.ips,
      text: `${wide.ips.length} addresses answered at hop ${wide.hop ?? '?'} of the ${label} path (${wide.ips.join(', ')}) — the traffic is balanced across them, so one test speaks for one of them`,
    });
  }

  const mismatch = certMismatch(tls, host);
  if (mismatch) {
    if (present !== true) { present = true; basis = BASIS.OBSERVED; }
    evidence.push({
      kind: 'cert_name_mismatch',
      basis: BASIS.OBSERVED,
      text: `the certificate does not carry ${mismatch.want || 'the name asked for'}${mismatch.subject ? ` (it is for ${mismatch.subject})` : ''} — a shared front end answered for a name it does not serve`,
    });
  }

  const status = http && typeof http.status === 'number' ? http.status : null;
  if (status && GATEWAY_STATUS[status]) {
    if (present !== true) { present = true; basis = BASIS.INFERRED; }
    evidence.push({
      kind: 'gateway_status',
      basis: BASIS.INFERRED,
      status,
      text: `HTTP ${status} (${GATEWAY_STATUS[status]}) — a gateway answered for an upstream that did not. Nothing was inspected; the status names the shape of what produced it`,
    });
  }

  if (present === true && basis === null) basis = BASIS.INFERRED;
  return { present, basis, evidence };
}

module.exports = { detectMiddlebox, lastResponder, widestHop, certMismatch, GATEWAY_STATUS };
