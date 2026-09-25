'use strict';

// Is this agent where its site says it is?
//
// Every distance on the path map is measured from the agent's site. When the
// agent actually runs in a cloud data centre — a droplet, an EC2 instance, a
// VPN exit — the site pin is somewhere else entirely, and every hop is judged
// from the wrong place. The trace gives it away: the first public router
// belongs to the cloud provider and answers within a few milliseconds.
//
//   cloudOrigin(nodes) -> { hop, ip, asn, provider, rttMs } | null
//
// `nodes` are path-graph nodes in TTL order (source first). Only the FIRST
// public hop is looked at, and only when it answered within LOCAL_MS: a cloud
// network further down the path is just a destination or transit.
//
// Matching is by ASN first and by the AS name second (a GeoIP database that
// carries names but a different number for a subsidiary still matches). The
// list is the large public clouds and hosting companies; an office whose own
// uplink is one of these gets the same note, which is still the right one —
// its traffic leaves through that data centre.

const LOCAL_MS = 5;

const PROVIDERS = [
  { name: 'DigitalOcean', asns: [14061, 200130, 393406, 394362], re: /digitalocean/i },
  { name: 'Amazon Web Services', asns: [16509, 14618, 8987, 38895], re: /amazon|\baws\b/i },
  { name: 'Google Cloud', asns: [396982, 15169, 19527], re: /google/i },
  { name: 'Microsoft Azure', asns: [8075, 8068, 8069], re: /microsoft|azure/i },
  { name: 'Hetzner', asns: [24940, 213230, 212317], re: /hetzner/i },
  { name: 'OVHcloud', asns: [16276, 35540], re: /\bovh/i },
  { name: 'Linode / Akamai', asns: [63949], re: /linode/i },
  { name: 'Vultr', asns: [20473], re: /vultr|choopa/i },
  { name: 'Scaleway', asns: [12876], re: /scaleway|online s\.?a\.?s/i },
  { name: 'Oracle Cloud', asns: [31898], re: /oracle/i },
  { name: 'Alibaba Cloud', asns: [45102, 37963], re: /alibaba|aliyun/i },
  { name: 'UpCloud', asns: [202053], re: /upcloud/i },
  { name: 'Contabo', asns: [51167], re: /contabo/i },
  { name: 'IONOS', asns: [8560], re: /\bionos\b|1&1/i },
  { name: 'Leaseweb', asns: [60781, 16265, 28753], re: /leaseweb/i },
];

function providerOf(asn, asnName) {
  const n = Number(asn);
  for (const p of PROVIDERS) {
    if (Number.isInteger(n) && p.asns.includes(n)) return p.name;
  }
  if (typeof asnName === 'string' && asnName) {
    for (const p of PROVIDERS) if (p.re.test(asnName)) return p.name;
  }
  return null;
}

function cloudOrigin(nodes, { fastestOf = (n) => n.rttMs } = {}) {
  for (const n of nodes || []) {
    if (!n || n.kind === 'source' || !n.ip || n.private) continue;
    // The first public hop decides; a silent hop before it does not count.
    const provider = providerOf(n.asn, n.asnName);
    const rtt = fastestOf(n);
    if (!provider || !(typeof rtt === 'number' && Number.isFinite(rtt)) || rtt > LOCAL_MS) return null;
    return { hop: n.hop, ip: n.ip, asn: n.asn ?? null, provider, rttMs: Math.round(rtt * 10) / 10 };
  }
  return null;
}

module.exports = { cloudOrigin, providerOf, PROVIDERS, LOCAL_MS };
