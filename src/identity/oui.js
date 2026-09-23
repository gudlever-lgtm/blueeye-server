'use strict';

// MAC → manufacturer hint, from the first three octets (the IEEE OUI).
//
// A CURATED SUBSET, not the IEEE registry: the vendors a monitoring operator on
// an OT/industrial network most needs to recognise at a glance (PLC, I/O and
// industrial-switch makers) plus the handful of virtualisation/board prefixes
// that explain "why is there a new MAC" most often. Every prefix below is an
// IEEE assignment to that vendor. Anything not listed is `null` — unknown, never
// guessed — and the caller says so. The table is injectable so a deployment can
// pass a fuller list without a code change here.
//
// Metadata only: a MAC prefix is part of the address, not of any payload.
//
// A hint, not proof. A MAC can be changed in software, and a device built on a
// vendor's module carries the module maker's prefix.

const DEFAULT_OUI = Object.freeze({
  // Industrial automation.
  '00:1b:1b': 'Siemens',
  '00:0e:8c': 'Siemens',
  '28:63:36': 'Siemens',
  '00:00:bc': 'Rockwell Automation',
  '00:1d:9c': 'Rockwell Automation',
  '00:80:f4': 'Schneider Electric (Telemecanique)',
  '00:a0:45': 'Phoenix Contact',
  '00:30:de': 'WAGO',
  '00:01:05': 'Beckhoff',
  '00:90:e8': 'Moxa',
  '00:80:63': 'Hirschmann',
  // Network.
  '00:00:0c': 'Cisco',
  // Virtual machines and single-board computers.
  '00:50:56': 'VMware',
  '00:0c:29': 'VMware',
  '00:15:5d': 'Microsoft Hyper-V',
  '08:00:27': 'Oracle VirtualBox',
  'b8:27:eb': 'Raspberry Pi',
  'dc:a6:32': 'Raspberry Pi',
});

// True for a locally administered address (bit 1 of the first octet): a
// randomised phone/laptop MAC or a hypervisor's own scheme. No vendor can be
// derived from one, and saying so is more useful than saying "unknown".
function isLocallyAdministered(mac) {
  const first = parseInt(String(mac || '').slice(0, 2), 16);
  return Number.isFinite(first) && (first & 2) === 2;
}

// Vendor for a normalised (lowercase, colon) MAC, or null.
function vendorForMac(mac, table = DEFAULT_OUI) {
  const m = String(mac || '').toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m)) return null;
  return (table && table[m.slice(0, 8)]) || null;
}

module.exports = { DEFAULT_OUI, vendorForMac, isLocallyAdministered };
