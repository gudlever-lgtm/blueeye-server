'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { explainPhases, totalPhases, focusStep } = require('../src/analysis/transactionPhases');
const { analyseCapture, measure } = require('../src/analysis/captureAnalysis');
const { validateResultIngest, validateCaptureIngest, validateTransactionInput } = require('../src/validation/transactionValidation');

// ---------------------------------------------------------------- phases

const step = (o = {}) => ({ dns: null, tcp: null, tls: null, ttfb: null, transfer: null, ...o });

test('phases: a slow server is named as the application, not the network', () => {
  const out = explainPhases({ step_phases: [step({ dns: 12, tcp: 31, tls: 78, ttfb: 4050, transfer: 29 })] });
  assert.equal(out.verdict, 'application');
  assert.match(out.explanation, /waiting for the server/);
  assert.match(out.explanation, /round-trip of 31 ms/);
  assert.equal(out.split.think, 4019, 'server think time is ttfb minus the one round trip it contains');
});

test('phases: a slow resolver is named as dns even when the rest is fine', () => {
  const out = explainPhases({ step_phases: [step({ dns: 850, tcp: 31, ttfb: 40, transfer: 5 })] });
  assert.equal(out.verdict, 'dns');
  assert.match(out.explanation, /resolving the name/);
});

test('phases: a costly handshake is named as the network', () => {
  const out = explainPhases({ step_phases: [step({ dns: 2, tcp: 420, ttfb: 500, transfer: 10 })] });
  assert.equal(out.verdict, 'network');
  assert.match(out.explanation, /TCP handshake alone/);
});

test('phases: a big body is named as transfer', () => {
  const out = explainPhases({ step_phases: [step({ dns: 2, tcp: 10, ttfb: 40, transfer: 3000 })] });
  assert.equal(out.verdict, 'transfer');
  assert.match(out.explanation, /receiving the body/);
});

test('phases: a TLS handshake far above two round trips points at the server, not the path', () => {
  const out = explainPhases({ step_phases: [step({ tcp: 10, tls: 900, ttfb: 30, transfer: 5 })] });
  assert.equal(out.verdict, 'tls');
  assert.match(out.explanation, /crypto/);
});

test('phases: when nothing dominates it says so, and lists what it saw', () => {
  const out = explainPhases({ step_phases: [step({ dns: 100, tcp: 100, tls: 100, ttfb: 180, transfer: 100 })] });
  assert.equal(out.verdict, 'mixed');
  assert.match(out.explanation, /no single phase dominating/);
  assert.match(out.explanation, /100 ms dns/);
});

test('phases: a fast step is not attributed at all', () => {
  const out = explainPhases({ step_phases: [step({ dns: 1, tcp: 2, ttfb: 4, transfer: 1 })] });
  assert.match(out.explanation, /worth attributing/);
});

test('phases: a failed step is explained by where it stopped, not by its largest phase', () => {
  // The timeout makes ttfb the biggest number by far, but the story is the SYN.
  const noConnect = explainPhases({ step_phases: [step({ dns: 12 })], step_failed: 0 });
  assert.equal(noConnect.verdict, 'dns');
  assert.match(noConnect.explanation, /no address to send it to/);

  // Not 'network': the handshake completed, so the path worked. The verdict
  // must not contradict the sentence printed next to it.
  const connected = explainPhases({ step_phases: [step({ tcp: 30 })], step_failed: 0 });
  assert.equal(connected.verdict, 'mixed');
  assert.match(connected.explanation, /carried packets both ways/);

  const stalled = explainPhases({ step_phases: [step({ tcp: 30, tls: 80 })], step_failed: 0 });
  assert.equal(stalled.verdict, 'application');
  assert.match(stalled.explanation, /never sent a first byte/);
});

test('phases: the failed step is the focus even when another step was slower', () => {
  const result = { step_phases: [step({ tcp: 10, ttfb: 9000, transfer: 10 }), step({ tcp: 20 })], step_failed: 1 };
  assert.equal(focusStep(result).index, 1);
  assert.match(explainPhases(result).explanation, /^Step 2/);
});

test('phases: a result with no breakdown says so rather than guessing', () => {
  const out = explainPhases({ status: 'ok', latency_ms: 4200 });
  assert.equal(out.verdict, 'unknown');
  assert.equal(out.split, null);
});

test('phases: a reused keep-alive socket does not read as an instant handshake', () => {
  const out = explainPhases({ step_phases: [{ ...step({ ttfb: 900, transfer: 20 }), reused: true }] });
  assert.equal(out.split.network, null);
  assert.equal(out.split.think, null, 'without a measured round trip, think time is null rather than a guess');
});

test('totalPhases: sums across steps, and a phase that never happened stays null', () => {
  const totals = totalPhases({ step_phases: [step({ dns: 10, tcp: 20 }), step({ tcp: 5, ttfb: 40 })] });
  assert.deepEqual(totals, { dns: 10, tcp: 25, tls: null, ttfb: 40, transfer: null });
  assert.equal(totalPhases({}), null);
});

// ---------------------------------------------------------------- capture

const pkt = (o = {}) => ({
  proto: 6, src: '10.0.0.1', dst: '10.0.0.2', sport: 51234, dport: 443,
  t: 0, len: 60, payload: 0, win: 64240, seq: 0, ack: 0, flags: 'A', mss: null, ...o,
});
const back = (o = {}) => pkt({ src: '10.0.0.2', dst: '10.0.0.1', sport: 443, dport: 51234, ...o });

test('capture: SYNs with no answer is a silent drop, not a refusal', () => {
  const a = analyseCapture({ packets: [pkt({ flags: 'S', t: 0 }), pkt({ flags: 'S', t: 1000 }), pkt({ flags: 'S', t: 3000 })] });
  assert.equal(a.pattern, 'blackhole');
  assert.match(a.explanation, /a refusal returns a reset/);
  assert.equal(a.syn_unanswered, 3);
});

test('capture: a reset answering a SYN is a refusal, which a timeout looks exactly like', () => {
  const a = analyseCapture({ packets: [pkt({ flags: 'S', t: 0 }), back({ flags: 'R', t: 2 })] });
  assert.equal(a.pattern, 'refused');
  assert.match(a.explanation, /port is closed/);
});

test('capture: a reset mid-conversation is a different fault from a refusal', () => {
  const a = analyseCapture({
    packets: [pkt({ flags: 'S', t: 0 }), back({ flags: 'SA', t: 30 }), pkt({ flags: 'PA', seq: 1, payload: 100, t: 31 }), back({ flags: 'R', t: 900 })],
  });
  assert.equal(a.pattern, 'reset');
  assert.match(a.explanation, /mid-conversation/);
});

test('capture: retransmissions are named as loss, with the rate', () => {
  const a = analyseCapture({
    packets: [
      pkt({ flags: 'S', t: 0, mss: 1460 }), back({ flags: 'SA', t: 31, mss: 1460 }),
      pkt({ flags: 'PA', seq: 1, payload: 100, t: 40 }),
      pkt({ flags: 'PA', seq: 1, payload: 100, t: 340 }),
    ],
  });
  assert.equal(a.pattern, 'loss');
  assert.equal(a.retransmits, 1);
  assert.equal(a.handshake_rtt_ms, 31, 'and the handshake time is in milliseconds');
  assert.match(a.explanation, /duplex mismatch/);
});

test('capture: a zero window is the application, not the network', () => {
  const a = analyseCapture({
    packets: [pkt({ flags: 'S', t: 0 }), back({ flags: 'SA', t: 30 }), back({ flags: 'A', win: 0, t: 500 })],
  });
  assert.equal(a.pattern, 'window_limited');
  assert.equal(a.zero_windows, 1);
  assert.match(a.explanation, /nobody collected them/);
});

test('capture: duplicate ACKs with nothing lost is reordering, not loss', () => {
  const a = analyseCapture({
    packets: [
      pkt({ flags: 'S', t: 0 }), back({ flags: 'SA', t: 30 }),
      back({ flags: 'A', ack: 500, t: 40 }), back({ flags: 'A', ack: 500, t: 41 }), back({ flags: 'A', ack: 500, t: 42 }),
    ],
  });
  assert.equal(a.pattern, 'reordering');
  assert.equal(a.dup_acks, 2);
});

test('capture: a clean but slow handshake is the path, with nothing to fix on the host', () => {
  const a = analyseCapture({ packets: [pkt({ flags: 'S', t: 0 }), back({ flags: 'SA', t: 310 })] });
  assert.equal(a.pattern, 'slow_path');
  assert.match(a.explanation, /round-trip time of this path/);
});

test('capture: a shrunken MSS is reported even when nothing else is wrong', () => {
  const a = analyseCapture({ packets: [pkt({ flags: 'S', t: 0, mss: 1380 }), back({ flags: 'SA', t: 20, mss: 1380 })] });
  assert.equal(a.pattern, 'reduced_mss');
  assert.equal(a.mss, 1380);
  assert.match(a.explanation, /tunnel or a VPN/);
});

test('capture: a clean exchange says the network is not the story', () => {
  const a = analyseCapture({
    packets: [pkt({ flags: 'S', t: 0, mss: 1460 }), back({ flags: 'SA', t: 12, mss: 1460 }), pkt({ flags: 'PA', seq: 1, payload: 50, t: 13 }), back({ flags: 'A', ack: 51, t: 25 })],
  });
  assert.equal(a.pattern, 'clean');
  assert.match(a.explanation, /did not go wrong in the network/);
});

test('capture: a truncated capture says its verdict only covers what it saw', () => {
  const a = analyseCapture({ packets: [pkt({ flags: 'S', t: 0, mss: 1460 }), back({ flags: 'SA', t: 5, mss: 1460 })], truncated: true });
  assert.match(a.explanation, /packet ceiling/);
});

test('capture: an empty capture is its own answer, not a clean one', () => {
  const a = analyseCapture({ packets: [] });
  assert.equal(a.pattern, 'empty');
  assert.match(a.explanation, /interface this capture was not watching/);
});

test('capture: the local side is taken from the first SYN, so direction is right', () => {
  const m = measure([pkt({ flags: 'S' }), back({ flags: 'SA' })]);
  assert.equal(m.local.ip, '10.0.0.1');
  assert.equal(m.local.port, 51234);
});

// ---------------------------------------------------------------- validation

test('validation: phases survive ingest, and null stays null', () => {
  const { value } = validateResultIngest({
    results: [{ test_id: 1, status: 'ok', step_phases: [{ dns: 12, tcp: 31, tls: null, ttfb: 4050, transfer: 29, address: '10.0.0.2', localPort: 51234 }] }],
  });
  const p = value.results[0].step_phases[0];
  assert.equal(p.tls, null, 'a phase that never happened must not become 0');
  assert.equal(p.address, '10.0.0.2');
  assert.equal(p.localPort, 51234);
});

test('validation: a phase record made of junk becomes nulls, never garbage in the column', () => {
  const { value } = validateResultIngest({
    results: [{ test_id: 1, status: 'ok', step_phases: [{ dns: 'slow', tcp: -5, address: 'evil; DROP', localPort: 99999, remotePort: 0 }] }],
  });
  const p = value.results[0].step_phases[0];
  assert.deepEqual(p, { dns: null, tcp: null, tls: null, ttfb: null, transfer: null });
});

test('validation: step_phases is bounded', () => {
  const { errors } = validateResultIngest({ results: [{ test_id: 1, status: 'ok', step_phases: new Array(65).fill({}) }] });
  assert.ok(errors['results[0].step_phases']);
});

test('validation: a capture ingest keeps only the header fields, whatever else was sent', () => {
  const { value } = validateCaptureIngest({
    test_id: 1,
    time: '2026-01-01T00:00:00.000Z',
    capture: {
      reason: 'status:fail', filter: '(host 10.0.0.2 and tcp port 443)', snaplen: 96, truncated: false,
      packets: [{ t: 1.5, src: '10.0.0.1', dst: '10.0.0.2', proto: 6, sport: 51234, dport: 443, flags: 'S', win: 64240, payload: 0, body: 'SECRET', url: '/login?token=abc' }],
    },
  });
  const p = value.packets[0];
  assert.equal(p.body, undefined, 'a field that is not a header does not reach the column');
  assert.equal(p.url, undefined);
  assert.ok(!JSON.stringify(value).includes('SECRET'));
  assert.equal(p.flags, 'S');
});

test('validation: a capture needs a time — it is the key that matches it to its result', () => {
  assert.ok(validateCaptureIngest({ test_id: 1, capture: { packets: [] } }).errors.time);
  assert.ok(validateCaptureIngest({ test_id: 1, time: 'not a date', capture: { packets: [] } }).errors.time);
});

test('validation: a capture for a nonsense test or with no packet array is refused', () => {
  assert.ok(validateCaptureIngest({ test_id: 0, time: '2026-01-01T00:00:00Z', capture: { packets: [] } }).errors.test_id);
  assert.ok(validateCaptureIngest({ test_id: 1, time: '2026-01-01T00:00:00Z', capture: {} }).errors['capture.packets']);
  assert.ok(validateCaptureIngest({ test_id: 1, time: '2026-01-01T00:00:00Z' }).errors.capture);
});

test('validation: packet counts are bounded at what the agent is capped to', () => {
  const { errors } = validateCaptureIngest({
    test_id: 1, time: '2026-01-01T00:00:00Z', capture: { packets: new Array(2001).fill({}) },
  });
  assert.match(errors['capture.packets'], /max 2000/);
});

test('validation: a flags field that is not flag letters is dropped', () => {
  const { value } = validateCaptureIngest({
    test_id: 1, time: '2026-01-01T00:00:00Z',
    capture: { packets: [{ t: 0, flags: 'SYN ACK <script>' }, { t: 1, flags: 'SA' }] },
  });
  assert.equal(value.packets[0].flags, null);
  assert.equal(value.packets[1].flags, 'SA');
});

test('validation: capture mode on a test defaults to off and refuses a typo', () => {
  const base = { name: 'Login', type: 'tcp', target: 'db01', config: { port: 5432 } };
  assert.equal(validateTransactionInput(base).value.capture, 'off');
  assert.equal(validateTransactionInput({ ...base, capture: 'always' }).value.capture, 'always');
  assert.ok(validateTransactionInput({ ...base, capture: 'on-fault' }).errors.capture, 'a typo must not silently mean off');
});
