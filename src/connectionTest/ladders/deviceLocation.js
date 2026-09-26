'use strict';

// Ladder 4 — DEVICE LOCATION. Where is this thing plugged in, and is that port
// healthy?
//
// Different in kind from the other three: it answers WHERE, not WHY, and it
// dispatches nothing. Every rung reads something the server already collected —
// ARP tables from agents and routers, forwarding tables and interface counters
// from polled switches, LLDP from both. `src/topology/deviceLocator.js` already
// resolves all of that into one answer; this reads that answer as an ordered
// chain instead of a page of fields.
//
//   identity  → does an address map to a MAC
//   switch    → does a forwarding table know that MAC
//   port      → which port, and is it a real access port
//   state     → is the port up, administratively and operationally
//   counters  → is it erring or discarding
//   vlan      → which VLAN, and is it the one expected
//
// The chain is causal for the first four: without a MAC there is no forwarding
// table lookup, without a switch there is no port, without a port there is no
// state. Counters and VLAN are observations about a port that is already known.
//
// WHY A LADDER AND NOT A PAGE. "Where is it" fails in stages, and each stage
// has a different owner. No MAC means no ARP source covers that segment —
// nobody's fault but a coverage gap. A MAC with no forwarding-table hit means
// the switches in front of it are not polled. A port that is down is an
// operations job. Presented as a page of blanks, all three look like "the tool
// does not know". Presented as a chain, each one names itself.
//
// ctx: { located } — the object src/topology/deviceLocator.js `where()`
// returns, or null when the query matched nothing.

const { STATUS, rung } = require('./registry');

const LAYERS = ['identity', 'switch', 'port', 'state', 'counters', 'vlan'];
const LOCKED = ['identity', 'switch', 'port', 'state'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function identityRung(p) {
  const d = p.located;
  if (!d) return rung('identity', STATUS.FAILED, 'identity.unknown', { q: p.query });
  const macs = Array.isArray(d.macs) ? d.macs : [];
  if (!macs.length) {
    // Not "the device is missing": no ARP table this server reads covers that
    // segment. A coverage gap, and the sentence says which kind of gap.
    return rung('identity', STATUS.FAILED, 'identity.nomac', { q: d.label || p.query }, { ips: d.ips || [] });
  }
  const m = macs[0];
  return rung('identity', STATUS.OK, m.vendor ? 'identity.ok.vendor' : 'identity.ok',
    { q: d.label || p.query, mac: m.mac, vendor: m.vendor }, { mac: m.mac, vendor: m.vendor || null });
}

function switchRung(p) {
  const d = p.located;
  if (!d || !Array.isArray(d.macs) || !d.macs.length) return rung('switch', STATUS.UNKNOWN, 'switch.nomac');
  const loc = d.location;
  if (!loc) {
    return rung('switch', STATUS.FAILED, 'switch.notfound', { mac: d.macs[0].mac });
  }
  if (loc.self) {
    // The endpoint IS the switch. It is its own location, and there is no
    // access port to look at.
    return rung('switch', STATUS.OK, 'switch.self', { name: loc.deviceName || '?' }, { deviceId: loc.deviceId });
  }
  return rung('switch', STATUS.OK, 'switch.ok', { name: loc.deviceName || '?' }, { deviceId: loc.deviceId });
}

// A port with many MACs behind it is an uplink or a trunk, not where this
// device is plugged in — it is the direction the device lies in. Reporting it
// as "the port" sends somebody to unplug a switch.
function portRung(p, cfg) {
  const loc = p.located && p.located.location;
  if (!loc) return rung('port', STATUS.UNKNOWN, 'port.nolocation');
  if (loc.self) return rung('port', STATUS.NA, 'port.self');
  if (!loc.ifName) return rung('port', STATUS.FAILED, 'port.noport', { name: loc.deviceName || '?' });
  const count = num(loc.portMacCount);
  if (loc.sharedPort || (count !== null && count > cfg.accessPortMaxMacs)) {
    return rung('port', STATUS.SUSPECT, 'port.shared',
      { port: loc.ifName, name: loc.deviceName || '?', count: count ?? '?' },
      { ifName: loc.ifName, portMacCount: count });
  }
  return rung('port', STATUS.OK, 'port.ok', { port: loc.ifName, name: loc.deviceName || '?' }, { ifName: loc.ifName });
}

function stateRung(p) {
  const port = p.located && p.located.port;
  const loc = p.located && p.located.location;
  if (loc && loc.self) return rung('state', STATUS.NA, 'state.self');
  if (!port) return rung('state', STATUS.UNKNOWN, 'state.untested');
  if (port.known === false) return rung('state', STATUS.UNKNOWN, 'state.notpolled', { port: port.ifName });
  const admin = port.adminStatus ? String(port.adminStatus).toLowerCase() : null;
  const oper = port.operStatus ? String(port.operStatus).toLowerCase() : null;
  if (admin === 'down') {
    // Somebody shut it. That is a different job from a port that fell over.
    return rung('state', STATUS.FAILED, 'state.admindown', { port: port.ifName });
  }
  if (oper === 'down') return rung('state', STATUS.FAILED, 'state.operdown', { port: port.ifName });
  if (oper === 'up') {
    const speed = num(port.speedMbps);
    return rung('state', STATUS.OK, speed !== null ? 'state.up.speed' : 'state.up', { port: port.ifName, speed });
  }
  return rung('state', STATUS.UNKNOWN, 'state.unreported', { port: port.ifName });
}

function countersRung(p, cfg) {
  const port = p.located && p.located.port;
  const loc = p.located && p.located.location;
  if (loc && loc.self) return rung('counters', STATUS.NA, 'counters.self');
  if (!port || !port.counters) return rung('counters', STATUS.UNKNOWN, 'counters.untested');
  const c = port.counters;
  const err = Math.max(num(c.inErrPps) ?? 0, num(c.outErrPps) ?? 0);
  const disc = Math.max(num(c.inDiscPps) ?? 0, num(c.outDiscPps) ?? 0);
  const util = Math.max(num(c.inUtilPct) ?? 0, num(c.outUtilPct) ?? 0);
  if (num(c.inErrPps) === null && num(c.outErrPps) === null && num(c.inDiscPps) === null && num(c.outDiscPps) === null) {
    return rung('counters', STATUS.UNKNOWN, 'counters.unreported', { port: port.ifName });
  }
  if (err >= cfg.errPps) {
    return rung('counters', STATUS.FAILED, 'counters.errors', { port: port.ifName, rate: Math.round(err * 100) / 100, util: Math.round(util) });
  }
  if (disc >= cfg.discPps) {
    return rung('counters', STATUS.SUSPECT, 'counters.discards', { port: port.ifName, rate: Math.round(disc * 100) / 100, util: Math.round(util) });
  }
  return rung('counters', STATUS.OK, 'counters.clean', { port: port.ifName });
}

function vlanRung(p) {
  const d = p.located;
  const loc = d && d.location;
  if (loc && loc.self) return rung('vlan', STATUS.NA, 'vlan.self');
  if (!loc) return rung('vlan', STATUS.UNKNOWN, 'vlan.nolocation');
  if (loc.vlan === null || loc.vlan === undefined) return rung('vlan', STATUS.UNKNOWN, 'vlan.unreported', { port: loc.ifName || '?' });
  if (p.expectVlan !== null && p.expectVlan !== undefined && Number(p.expectVlan) !== Number(loc.vlan)) {
    // The one case where a VLAN is a FAULT rather than a fact: the caller said
    // which one it should be on, and it is on a different one.
    return rung('vlan', STATUS.FAILED, 'vlan.wrong',
      { vlan: loc.vlan, name: d.vlanName || null, expected: p.expectVlan }, { vlan: loc.vlan, expected: p.expectVlan });
  }
  return rung('vlan', STATUS.OK, d.vlanName ? 'vlan.ok.name' : 'vlan.ok',
    { vlan: loc.vlan, name: d.vlanName }, { vlan: loc.vlan });
}

const DEF = {
  id: 'device_location',
  layers: LAYERS,
  locked: LOCKED,
  // No agent and no probe: this reads what the fleet already reported. `target`
  // is an address, a MAC or a hostname — whatever the locator accepts.
  needs: { agents: 0, target: 'device' },
  extras: {
    // Above this many MACs, a port is an uplink or a trunk rather than where
    // this device is plugged in.
    accessPortMaxMacs: 4,
    errPps: 1,
    discPps: 1,
  },
  clamp(c) {
    const out = {};
    const n = (k, min, max) => { if (Number.isInteger(c[k]) && c[k] >= min && c[k] <= max) out[k] = c[k]; };
    n('accessPortMaxMacs', 1, 1000);
    n('errPps', 0, 100000);
    n('discPps', 0, 100000);
    return out;
  },
  dispatch: null,
  prepare: (ctx) => ({
    located: ctx.located || null,
    query: ctx.query || (ctx.located && ctx.located.query) || '?',
    expectVlan: ctx.expectVlan === undefined ? null : ctx.expectVlan,
  }),
  rungs: {
    identity: identityRung,
    switch: switchRung,
    port: portRung,
    state: stateRung,
    counters: countersRung,
    vlan: vlanRung,
  },
};

module.exports = { DEF, LAYERS, LOCKED };
