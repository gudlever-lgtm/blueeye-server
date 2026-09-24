'use strict';

// The host NIC's duplex and error detail (blueeye-agent 0.40 proc source:
// /sys/class/net/<if>/duplex and the frame/fifo/colls/carrier columns of
// /proc/net/dev) through the interface health, the fleet reason line and the
// diagnose rules. The sample below is the snapshot the agent builds from two
// real /proc/net/dev reads two seconds apart (see the agent's
// test/trafficMonitor.test.js, which parses the same text).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeInterfaceHealth, interfaceHealthSummary, reasonsOf } = require('../src/health/interfaceHealth');
const { mergeHealth } = require('../src/health/probeHealth');
const { buildFacts } = require('../src/diagnose/facts');
const { evaluatePlaybook, VERDICTS } = require('../src/diagnose/evaluate');
const { loadCatalog } = require('../src/diagnose/catalog');

// eth1: 100 Mbit half duplex, 60 collisions / 8 frame errors / 1 carrier error
// / 2 fifo overruns over the 2 s window. eth0: gigabit full duplex, clean.
const SNAPSHOT = {
  intervalMs: 2000,
  elapsedSec: 2,
  interfaces: [
    { iface: 'eth0', rxBytes: 100000, txBytes: 10000, rxBytesPerSec: 50000, txBytesPerSec: 5000, rxErrors: 0, txErrors: 0, rxDrop: 0, txDrop: 0, operStatus: 'up', speedMbps: 1000, duplex: 'full', rxFrameErrors: 0, rxFifoErrors: 0, txCollisions: 0, txCarrierErrors: 0 },
    { iface: 'eth1', rxBytes: 100000, txBytes: 100000, rxBytesPerSec: 50000, txBytesPerSec: 50000, rxErrors: 10, txErrors: 3, rxDrop: 0, txDrop: 0, operStatus: 'up', speedMbps: 100, duplex: 'half', rxFrameErrors: 8, rxFifoErrors: 2, txCollisions: 60, txCarrierErrors: 1 },
  ],
};

test('half duplex with collisions and frame errors moving → "duplex mismatch suspected", bad', () => {
  const [eth0, eth1] = computeInterfaceHealth(SNAPSHOT);
  assert.equal(eth1.duplex, 'half');
  assert.equal(eth1.collPerSec, 30);
  assert.equal(eth1.frameErrPerSec, 4);
  assert.equal(eth1.fifoErrPerSec, 1);
  assert.equal(eth1.carrierErrPerSec, 0.5);
  assert.deepEqual(eth1.reasons, ['duplex_mismatch', 'carrier_errors', 'fifo_overrun']);
  assert.equal(eth1.status, 'bad');
  assert.deepEqual(eth0.reasons, []);
  assert.equal(eth0.status, 'ok');
  assert.equal(eth0.duplex, 'full');
});

test('the fleet reason line names the duplex mismatch instead of a bare error rate', () => {
  const summary = interfaceHealthSummary(SNAPSHOT);
  const merged = mergeHealth({ status: 'ok', reason: 'All probes healthy.', evidence: [], metrics: {} }, summary);
  assert.match(merged.reason, /^Duplex mismatch suspected \(eth1\): half duplex with collisions or frame errors increasing\.$/);
});

test('frame errors on a full-duplex link are a cabling/CRC reason, not a duplex one', () => {
  const [i] = computeInterfaceHealth({ elapsedSec: 1, interfaces: [{ iface: 'eth0', duplex: 'full', rxFrameErrors: 5, txCollisions: 0, operStatus: 'up' }] });
  assert.deepEqual(i.reasons, ['crc_errors']);
  assert.equal(i.status, 'bad', 'even when rxErrors was not sent');
  const merged = mergeHealth({ status: 'ok', reason: '', evidence: [], metrics: {} }, interfaceHealthSummary({ elapsedSec: 1, interfaces: [{ iface: 'eth0', duplex: 'full', rxFrameErrors: 5 }] }));
  assert.match(merged.reason, /Frame\/CRC errors 5\/s \(eth0\) — suspect cabling/);
});

test('half duplex with nothing moving is a warning, not a mismatch', () => {
  const [i] = computeInterfaceHealth({ elapsedSec: 1, interfaces: [{ iface: 'eth0', duplex: 'half', rxFrameErrors: 0, txCollisions: 0, operStatus: 'up' }] });
  assert.deepEqual(i.reasons, ['half_duplex']);
  assert.equal(i.status, 'warn');
});

test('an older agent / another source: no fields → nulls and no reasons, status unchanged', () => {
  const [i] = computeInterfaceHealth({ elapsedSec: 1, interfaces: [{ iface: 'eth0', rxErrors: 0, operStatus: 'up' }] });
  assert.equal(i.duplex, null);
  assert.equal(i.collPerSec, null);
  assert.equal(i.frameErrPerSec, null);
  assert.equal(i.fifoErrPerSec, null);
  assert.equal(i.carrierErrPerSec, null);
  assert.deepEqual(i.reasons, []);
  assert.equal(i.status, 'ok');
  // Junk is not a zero, and not a duplex either.
  const [j] = computeInterfaceHealth({ elapsedSec: 1, interfaces: [{ iface: 'eth0', duplex: 'HALF-ish', txCollisions: [], rxFrameErrors: '5' }] });
  assert.equal(j.duplex, null);
  assert.equal(j.collPerSec, null);
  assert.equal(j.frameErrPerSec, null);
});

test('a link that is down is not judged on its duplex', () => {
  const [i] = computeInterfaceHealth({ elapsedSec: 1, interfaces: [{ iface: 'eth0', duplex: 'half', txCollisions: 5, operStatus: 'down' }] });
  assert.deepEqual(i.reasons, []);
  assert.equal(i.status, 'down');
});

test('reasonsOf: late collisions on a half-duplex port are a mismatch too', () => {
  assert.deepEqual(reasonsOf({ duplex: 'half', collPerSec: 0, frameErrPerSec: 0, carrierErrPerSec: null, fifoErrPerSec: null, lateCollPerSec: 0.2 }), ['duplex_mismatch']);
});

// ---------------------------------------------------------------- diagnose
const catalog = loadCatalog();
const pb = (id) => catalog.get(id);
const factsOf = (snapshot) => buildFacts({ interfaces: computeInterfaceHealth(snapshot) });

test('diagnose facts carry the duplex and the error detail of the worst interface', () => {
  const f = factsOf(SNAPSHOT);
  assert.equal(f.iface.duplex, 'half');
  assert.equal(f.iface.collisions_per_sec, 30);
  assert.equal(f.iface.frame_err_per_sec, 4);
  assert.equal(f.iface.carrier_err_per_sec, 0.5);
  const old = factsOf({ elapsedSec: 1, interfaces: [{ iface: 'eth0', operStatus: 'up' }] });
  assert.equal(old.iface.duplex, undefined, 'absent, so a rule over it reads unknown');
  assert.equal(old.iface.collisions_per_sec, undefined);
});

test('duplex_mismatch is CONFIRMED by half duplex + collisions on the host NIC', () => {
  const r = evaluatePlaybook(pb('duplex_mismatch'), factsOf(SNAPSHOT));
  assert.equal(r.verdict, VERDICTS.CONFIRMED);
  assert.ok(r.decidedBy.includes('half_duplex_collisions'));
  assert.ok(r.decidedBy.includes('half_duplex_frame_errors'));
});

test('duplex_mismatch is RULED OUT by a measured clean full-duplex link, and not by an unmeasured one', () => {
  const clean = { elapsedSec: 1, interfaces: [{ iface: 'eth0', operStatus: 'up', speedMbps: 100, duplex: 'full', rxFrameErrors: 0, txCollisions: 0, rxErrors: 0, txErrors: 0 }] };
  const r = evaluatePlaybook(pb('duplex_mismatch'), factsOf(clean));
  assert.ok(r.decidedBy.includes('full_duplex_clean'));
  assert.equal(r.verdict, VERDICTS.RULED_OUT);
  const unmeasured = evaluatePlaybook(pb('duplex_mismatch'), factsOf({ elapsedSec: 1, interfaces: [{ iface: 'eth0', operStatus: 'up', speedMbps: 100 }] }));
  assert.ok(!unmeasured.decidedBy.includes('full_duplex_clean'));
});

test('physical_errors is CONFIRMED by frame errors on a full-duplex link and by carrier errors', () => {
  // As the kernel counts them: rx_errors is the total that frame errors are a
  // part of, and tx_errors the total carrier errors are part of.
  const crc = evaluatePlaybook(pb('physical_errors'), factsOf({ elapsedSec: 1, interfaces: [{ iface: 'eth0', operStatus: 'up', speedMbps: 1000, duplex: 'full', rxErrors: 3, rxFrameErrors: 3, txCarrierErrors: 0 }] }));
  assert.equal(crc.verdict, VERDICTS.CONFIRMED);
  assert.ok(crc.decidedBy.includes('crc_on_full_duplex'));
  const carrier = evaluatePlaybook(pb('physical_errors'), factsOf({ elapsedSec: 1, interfaces: [{ iface: 'eth0', operStatus: 'up', txErrors: 2, txCarrierErrors: 2 }] }));
  assert.ok(carrier.decidedBy.includes('carrier_errors'));
});
