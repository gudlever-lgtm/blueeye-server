'use strict';

// Small address helpers the diagnose code needs to reason about WHERE an address
// sits: which family, how much of it two addresses share, and which subnet it
// is in. Pure, no dependencies beyond node's own `net`.

const net = require('net');
const { ipv4ToInt, isPrivate } = require('../geo/privateIp');

const familyOf = (ip) => (net.isIPv4(String(ip || '')) ? 4 : net.isIPv6(String(ip || '')) ? 6 : null);

// "2001:db8::1" → eight 16-bit numbers, or null. Handles one "::" and an
// embedded IPv4 tail; a zone suffix (%eth0) is dropped.
function v6Groups(ip) {
  let s = String(ip || '').trim().toLowerCase().replace(/%.*$/, '');
  if (!net.isIPv6(s)) return null;
  const v4tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4tail) {
    const n = ipv4ToInt(v4tail[1]);
    s = `${s.slice(0, -v4tail[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

// How many leading bits two addresses of the same family share (0 when the
// families differ or either is not an address).
function commonPrefixBits(a, b) {
  const fa = familyOf(a);
  if (fa === null || fa !== familyOf(b)) return 0;
  if (fa === 4) {
    const x = (ipv4ToInt(a) ^ ipv4ToInt(b)) >>> 0;
    return x === 0 ? 32 : Math.clz32(x);
  }
  const ga = v6Groups(a);
  const gb = v6Groups(b);
  if (!ga || !gb) return 0;
  let bits = 0;
  for (let i = 0; i < 8; i += 1) {
    const x = ga[i] ^ gb[i];
    if (x === 0) { bits += 16; continue; }
    return bits + (Math.clz32(x) - 16);
  }
  return bits;
}

// The /24 (IPv4) or /64 (IPv6) an address sits in, as a string key; null for a
// non-address. Why these two sizes: the two ends of a router-to-router link are
// numbered from one small subnet (/30, /31, /127, /64), so both interfaces of a
// link share it — which is what lets a forward and a reverse trace, that see
// DIFFERENT interfaces of the same routers, still be matched.
function subnetKey(ip) {
  const f = familyOf(ip);
  if (f === 4) return `v4:${String(ip).split('.').slice(0, 3).join('.')}`;
  if (f === 6) {
    const g = v6Groups(ip);
    return g ? `v6:${g.slice(0, 4).map((n) => n.toString(16)).join(':')}` : null;
  }
  return null;
}

module.exports = { familyOf, v6Groups, commonPrefixBits, subnetKey, isPrivate };
