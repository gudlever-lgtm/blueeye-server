'use strict';

const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// Derives a STABLE server identifier from the host, so a customer install needs
// to configure nothing but LICENSE_KEY. blueeye-licens binds a license to the
// first serverId that validates it (trust-on-first-use) and every later proof
// must match, so this value must be:
//   - deterministic  — the same host yields the same id across restarts, with
//     no stored file, so re-validation keeps matching the bound id; and
//   - host-specific  — one license key therefore sticks to one host.
//
// LICENSE_SERVER_ID always wins when set (explicit override / legacy installs);
// derivation only kicks in when it is left blank.

// Reads the host machine-id — the canonical stable identity of a Linux install
// (systemd / D-Bus). In a container, mount the host's file read-only
// (/etc/machine-id:/etc/machine-id:ro) so it stays stable across container
// recreation; otherwise the fallback below is used.
function readMachineId(fsImpl = fs) {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = fsImpl.readFileSync(p, 'utf8').trim();
      if (value) return value;
    } catch {
      /* try next / fall through to host attributes */
    }
  }
  return null;
}

// Fallback basis when no machine-id file exists: hostname + platform/arch + the
// sorted non-internal MAC addresses. Less stable than machine-id (a container
// without a mounted machine-id changes hostname/MACs on recreation), which is
// why machine-id is preferred and documented.
function hostAttributes(osImpl = os) {
  const macs = new Set();
  const ifaces = osImpl.networkInterfaces() || {};
  for (const name of Object.keys(ifaces).sort()) {
    for (const ni of ifaces[name] || []) {
      if (ni && !ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') macs.add(ni.mac);
    }
  }
  return [osImpl.hostname(), osImpl.platform(), osImpl.arch(), [...macs].sort().join(',')].join('|');
}

// Resolves the server identity and where it came from, for boot-time logging.
// source: 'configured' (LICENSE_SERVER_ID) | 'machine-id' | 'host-attributes'.
function resolveServerId({ env = process.env, os: osImpl = os, fs: fsImpl = fs } = {}) {
  const configured = (env.LICENSE_SERVER_ID || '').trim();
  if (configured) return { serverId: configured, source: 'configured' };

  const machineId = readMachineId(fsImpl);
  const basis = machineId || hostAttributes(osImpl);
  // Domain-separated so the id can never coincide with the raw machine-id.
  const hash = crypto.createHash('sha256').update(`blueeye-server-id\0${basis}`).digest('hex');
  return { serverId: `be-${hash.slice(0, 20)}`, source: machineId ? 'machine-id' : 'host-attributes' };
}

function deriveServerId(deps) {
  return resolveServerId(deps).serverId;
}

module.exports = { resolveServerId, deriveServerId, readMachineId, hostAttributes };
