'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateProbeFindings } = require('../src/analysis/probeFindings');

const T = '2026-06-01T12:00:00.000Z';
const at = () => new Date(T);

test('a fully-unreachable target yields a CRIT reachability finding', () => {
  const rows = [{ ts: T, type: 'ping', target: '1.1.1.1', ok: false, rttMs: null, lossPct: 100, jitterMs: null }];
  const fs = evaluateProbeFindings(7, rows, { now: at });
  assert.equal(fs.length, 1);
  assert.equal(fs[0].hostId, '7');
  assert.equal(fs[0].metric, 'probe.reachability');
  assert.equal(fs[0].severity, 'CRIT');
  assert.ok(fs[0].explanation.includes('1.1.1.1'));
  assert.equal(fs[0].evidence.length, 1); // findingStore.save requires >=1
});

test('moderate packet loss yields a WARN loss finding', () => {
  const rows = [{ ts: T, type: 'ping', target: '8.8.8.8', ok: true, rttMs: 10, lossPct: 5, jitterMs: 1 }];
  const loss = evaluateProbeFindings(7, rows, { now: at }).find((f) => f.metric === 'probe.loss');
  assert.ok(loss);
  assert.equal(loss.severity, 'WARN');
  assert.equal(loss.observed, 5);
});

test('a healthy target yields no findings', () => {
  const rows = [{ ts: T, type: 'ping', target: '8.8.8.8', ok: true, rttMs: 10, lossPct: 0, jitterMs: 1 }];
  assert.equal(evaluateProbeFindings(7, rows, { now: at }).length, 0);
});

test('a soon-to-expire TLS cert yields a cert finding independent of reachability', () => {
  const rows = [{ ts: T, type: 'http', target: 'https://ok.test/', ok: true, rttMs: 10, lossPct: 0, jitterMs: 1, status: 200, certExpiryDays: 2 }];
  const cert = evaluateProbeFindings(7, rows, { now: at }).find((f) => f.metric === 'probe.cert');
  assert.ok(cert);
  assert.equal(cert.severity, 'CRIT');
  assert.equal(cert.observed, 2);
  assert.ok(cert.explanation.includes('ok.test'));
});

test('a healthy cert (60 days) yields no cert finding', () => {
  const rows = [{ ts: T, type: 'http', target: 'https://ok.test/', ok: true, rttMs: 10, lossPct: 0, jitterMs: 1, status: 200, certExpiryDays: 60 }];
  const certs = evaluateProbeFindings(7, rows, { now: at }).filter((f) => f.metric === 'probe.cert');
  assert.equal(certs.length, 0);
});
