'use strict';

// Rule evaluation: confirming, ruling out, and — the one that matters most —
// declining to do either when the measurement is not there.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadCatalog } = require('../src/diagnose/catalog');
const { buildFacts, sustainedLossFromHop, ifaceFacts, comparePaths } = require('../src/diagnose/facts');
const { evaluatePlaybook, evaluateSession, fillFix, VERDICTS, REASONS } = require('../src/diagnose/evaluate');

const catalog = loadCatalog();
const pb = (id) => catalog.get(id);
const verdictOf = (id, facts) => evaluatePlaybook(pb(id), facts).verdict;

// --- a confirming, a ruling-out and an inconclusive pattern per playbook -----

const CASES = {
  mtu_blackhole: {
    confirm: { ping: { size_64: { loss_pct: 0 }, size_1472: { loss_pct: 100 } } },
    rule_out: { ping: { size_1472: { loss_pct: 0 } }, path_mtu: { path_mtu: 1500 } },
    open: { ping: { size_64: { loss_pct: 0 } } },
  },
  hop_packet_loss: {
    confirm: { ping: { loss_pct: 12 }, traceroute: { sustained_loss_from_hop: 4 } },
    rule_out: { ping: { loss_pct: 0 }, traceroute: { sustained_loss_from_hop: 0 } },
    open: { ping: { loss_pct: 0 } },
  },
  asymmetric_routing: {
    confirm: { ping: { loss_pct: 0 }, reverse: { ping: { loss_pct: 100 } } },
    rule_out: { ping: { loss_pct: 0 }, reverse: { ping: { loss_pct: 0 } } },
    open: { ping: { loss_pct: 0 } },
  },
  ecmp_member_link: {
    confirm: { ping: { loss_pct: 25 }, traceroute: { branch_count: 2 } },
    rule_out: { traceroute: { branch_count: 1 } },
    open: { ping: { loss_pct: 25 } },
  },
  physical_errors: {
    confirm: { iface: { err_per_sec: 3, util_pct: 4 } },
    rule_out: { iface: { err_per_sec: 0, drop_per_sec: 0 } },
    open: { ping: { loss_pct: 5 } },
  },
  congestion: {
    confirm: { iface: { drop_per_sec: 9, util_pct: 88 } },
    rule_out: { iface: { util_pct: 10, drop_per_sec: 0 } },
    open: { ping: { loss_pct: 5 } },
  },
  dns_resolution: {
    confirm: { dns: { ok: false } },
    rule_out: { dns: { ok: true, rtt_ms: 12 } },
    open: { ping: { loss_pct: 0 } },
  },
  l2_loop: {
    confirm: { ping: { jitter_ms: 240, loss_pct: 6 } },
    rule_out: { ping: { jitter_ms: 3 }, iface: { busy_port_count: 0 } },
    open: { ping: { loss_pct: 6 } },
  },
  duplex_mismatch: {
    confirm: { iface: { err_per_sec: 2, util_pct: 40 } },
    rule_out: { iface: { err_per_sec: 0, speed_mbps: 10000 } },
    open: { ping: { loss_pct: 4 } },
  },
};

test('every playbook in the starter catalogue has a pattern that confirms it', () => {
  assert.deepEqual(Object.keys(CASES).sort(), catalog.ids().sort(), 'a playbook shipped with no test case here');
  for (const [id, c] of Object.entries(CASES)) {
    assert.equal(verdictOf(id, c.confirm), VERDICTS.CONFIRMED, id);
  }
});

test('every playbook has a pattern that rules it out', () => {
  for (const [id, c] of Object.entries(CASES)) {
    assert.equal(verdictOf(id, c.rule_out), VERDICTS.RULED_OUT, id);
  }
});

test('a playbook whose tests have not run is inconclusive BECAUSE the data is missing', () => {
  for (const [id, c] of Object.entries(CASES)) {
    const r = evaluatePlaybook(pb(id), c.open);
    assert.equal(r.verdict, VERDICTS.INCONCLUSIVE, id);
    assert.equal(r.reason, REASONS.MISSING, id);
    assert.ok(r.missingFacts.length > 0, `${id} should name what it is waiting for`);
  }
});

test('no facts at all is inconclusive, never a verdict', () => {
  for (const id of catalog.ids()) {
    const r = evaluatePlaybook(pb(id), {});
    assert.equal(r.verdict, VERDICTS.INCONCLUSIVE, id);
    assert.equal(r.reason, REASONS.MISSING, id);
  }
});

test('measurements that ran and simply do not match say so, distinctly from missing data', () => {
  // Everything mtu_blackhole reads is present; none of its patterns fit.
  const facts = {
    ping: { size_64: { loss_pct: 0 }, size_1472: { loss_pct: 10 } },
    path_mtu: { blackhole_detected: false, icmp_frag_needed_seen: true, path_mtu: 1400 },
  };
  const r = evaluatePlaybook(pb('mtu_blackhole'), facts);
  // 1400 < 1500 with a router that SAID so is a confirm on its own — a real
  // answer, and a different one from the blackhole.
  assert.equal(r.verdict, VERDICTS.CONFIRMED);
  // 1% end-to-end loss with a clean per-hop trace fits nothing: it is below the
  // threshold that confirms loss and above the zero that rules it out. That is
  // "the tests ran and this cause is not showing its signature", which is a
  // different message from "run the tests", and the reason says which.
  const r2 = evaluatePlaybook(pb('hop_packet_loss'), { ping: { loss_pct: 1 }, traceroute: { sustained_loss_from_hop: 0 } });
  assert.equal(r2.verdict, VERDICTS.INCONCLUSIVE);
  assert.equal(r2.reason, REASONS.NO_MATCH);
  assert.deepEqual(r2.missingFacts, [], 'nothing is missing — the data is simply ambiguous');
  // And the clean version really is ruled out.
  assert.equal(evaluatePlaybook(pb('hop_packet_loss'), { ping: { loss_pct: 0 }, traceroute: { sustained_loss_from_hop: 0 } }).verdict, VERDICTS.RULED_OUT);
});

test('evidence that both confirms and rules out is inconclusive, not a coin toss', () => {
  // A full 1500-byte packet arrives with DF set (which rules the cause out)
  // while the same run reports a blackhole (which confirms it). The two cannot
  // both be true — a stale result, a target that changed under us, a bug — and
  // silently preferring one would hide that the data disagrees with itself.
  const facts = {
    ping: { size_64: { loss_pct: 0 }, size_1472: { loss_pct: 0 } },
    path_mtu: { blackhole_detected: true, icmp_frag_needed_seen: false, path_mtu: 1500 },
  };
  const r = evaluatePlaybook(pb('mtu_blackhole'), facts);
  assert.equal(r.verdict, VERDICTS.INCONCLUSIVE);
  assert.equal(r.reason, REASONS.CONFLICT);
  assert.ok(r.decidedBy.length >= 2, 'both sides of the disagreement are named');
});

test('every verdict carries the rule and the sentence behind it', () => {
  const r = evaluatePlaybook(pb('mtu_blackhole'), CASES.mtu_blackhole.confirm, { locale: 'da' });
  assert.equal(r.verdict, VERDICTS.CONFIRMED);
  assert.ok(r.decidedBy.includes('loss_size_dependent'));
  const fired = r.evidence.find((e) => e.ruleId === 'loss_size_dependent');
  assert.equal(fired.result, true);
  assert.ok(fired.because.length > 10, 'the reason is a sentence, in the requested language');
  assert.ok(fired.when.includes('size_1472'), 'the rule itself is shown, not just its verdict');
});

// --- the reading rule the brief calls out by name ---------------------------

test('loss at one hop that does not continue is ICMP rate limiting, and is ignored', () => {
  // The single most common way a traceroute is misread.
  assert.equal(sustainedLossFromHop([{ hop: 1, lossPct: 0 }, { hop: 2, lossPct: 60 }, { hop: 3, lossPct: 0 }]), 0);
  assert.equal(sustainedLossFromHop([{ hop: 1, lossPct: 0 }, { hop: 2, lossPct: 0 }, { hop: 3, lossPct: 40 }]), 3);
  assert.equal(sustainedLossFromHop([{ hop: 1, lossPct: 30 }, { hop: 2, lossPct: 40 }, { hop: 3, lossPct: 55 }]), 1);
  assert.equal(sustainedLossFromHop([]), undefined);
});

test('a rate-limited middle hop does not confirm hop_packet_loss on its own', () => {
  const facts = buildFacts({
    results: [
      { type: 'ping', ok: true, lossPct: 0 },
      { type: 'traceroute', ok: true, hops: [{ hop: 1, ip: 'a', lossPct: 0 }, { hop: 2, ip: 'b', lossPct: 70 }, { hop: 3, ip: 'c', lossPct: 0 }] },
    ],
  });
  assert.equal(facts.traceroute.sustained_loss_from_hop, 0);
  assert.equal(verdictOf('hop_packet_loss', facts), VERDICTS.RULED_OUT);
});

// --- facts: what gets in, and what deliberately does not ---------------------

test('a size the local stack refused is not reported as loss on the path', () => {
  const facts = buildFacts({
    results: [{ type: 'ping', ok: true, lossPct: 0, df: true, sizes: [
      { bytes: 64, lossPct: 0, measured: true },
      { bytes: 9000, lossPct: 100, measured: false, error: 'payload exceeds the local interface MTU' },
    ] }],
  });
  assert.equal(facts.ping.size_9000.measured, false);
  assert.equal(facts.ping.size_9000.loss_pct, undefined, 'an unmeasured size contributes no loss');
});

test('a path_mtu run that measured no MTU does not rule a blackhole in or out', () => {
  // `blackholeDetected` is false by default in storage, and the probe reports
  // ok:true even when it FINDS a blackhole — the finding is about the path, not
  // the agent — so `ok` cannot be the gate. The measured MTU is: no MTU means
  // it did not look, and reading the default as an all-clear is how a real
  // fault gets marked "ruled out".
  const facts = buildFacts({ results: [{ type: 'path_mtu', ok: true, mtu: { pathMtu: null, blackholeDetected: false, mssSupported: false } }] });
  assert.equal(facts.path_mtu.blackhole_detected, undefined);
  assert.equal(facts.path_mtu.icmp_frag_needed_seen, undefined);
  assert.equal(facts.path_mtu.mss_exceeds_path, undefined, 'the agent could not read the MSS — that is not "nothing to report"');
  assert.equal(facts.path_mtu.path_mtu, undefined);
  assert.equal(evaluatePlaybook(pb('mtu_blackhole'), facts).verdict, VERDICTS.INCONCLUSIVE);
});

test('the negotiated MSS is only compared with the path when BOTH numbers exist', () => {
  const at = (mtu) => buildFacts({ results: [{ type: 'path_mtu', ok: true, mtu }] }).path_mtu;
  assert.equal(at({ pathMtu: 1400, mssSupported: true, mssObserved: 1460 }).mss_exceeds_path, true, '1460 will not fit a 1400-byte path');
  assert.equal(at({ pathMtu: 1400, mssSupported: true, mssObserved: 1360 }).mss_exceeds_path, false, 'clamped to exactly what the path carries');
  // `mssSupported:false` means the agent could not look — a Linux-only read.
  // That is not "nothing to report", so the derived fact stays absent.
  assert.equal(at({ pathMtu: 1400, mssSupported: false }).mss_exceeds_path, undefined);
  assert.equal(at({ pathMtu: null, mssSupported: true, mssObserved: 1460 }).mss_exceeds_path, undefined);
});

test('the hop that swallows the packets is named, from the hops the probe measured', () => {
  const f = buildFacts({ results: [{
    type: 'path_mtu', ok: true, mtu: { pathMtu: 1400, blackholeDetected: true },
    hops: [
      { hop: 1, ip: 'a', maxMtu: 1500, status: 'ok' },
      { hop: 2, ip: 'b', maxMtu: null, status: 'no_response' },
      { hop: 3, ip: 'c', maxMtu: 1400, status: 'blackhole' },
    ],
  }] });
  assert.equal(f.path_mtu.mtu_drop_at_hop, 3);
  assert.equal(f.path_mtu.blackhole_hop_count, 1);
  // A hop that answers no ICMP at all is not a fault and is never counted as
  // one — it looks identical to a hop dropping oversized packets, and naming
  // the wrong one sends somebody to the wrong firewall.
  const quiet = buildFacts({ results: [{
    type: 'path_mtu', ok: true, mtu: { pathMtu: 1400 },
    hops: [{ hop: 1, ip: 'a', status: 'no_response' }, { hop: 2, ip: 'b', status: 'reduced', maxMtu: 1400 }],
  }] });
  assert.equal(quiet.path_mtu.blackhole_hop_count, 0);
  assert.equal(quiet.path_mtu.mtu_drop_at_hop, undefined);
});

test('the observed MSS above the path confirms the missing clamp on its own', () => {
  const facts = { path_mtu: { mss_exceeds_path: true } };
  const r = evaluatePlaybook(pb('mtu_blackhole'), facts);
  assert.equal(r.verdict, VERDICTS.CONFIRMED);
  assert.ok(r.decidedBy.includes('mss_above_path'));
});

test('virtual interfaces are kept out of the interface facts', () => {
  // A docker bridge with no carrier is not the operator's problem, and letting
  // it in would confirm physical_errors on every container host in the fleet.
  const f = ifaceFacts([
    { iface: 'docker0', virtual: true, linkDown: true, status: 'ok', errPerSec: 99, utilPct: 0 },
    { iface: 'eth0', virtual: false, linkDown: false, status: 'ok', errPerSec: 0, dropPerSec: 0, utilPct: 12, speedMbps: 1000 },
  ]);
  assert.equal(f.err_per_sec, 0);
  assert.equal(f.link_down, false);
});

test('busy_port_count counts ports that are busy AT ONCE — no single interface shows that', () => {
  const f = ifaceFacts([
    { iface: 'eth0', virtual: false, utilPct: 90, errPerSec: 0, dropPerSec: 1, status: 'warn' },
    { iface: 'eth1', virtual: false, utilPct: 80, errPerSec: 0, dropPerSec: 1, status: 'warn' },
    { iface: 'eth2', virtual: false, utilPct: 77, errPerSec: 0, dropPerSec: 0, status: 'warn' },
    { iface: 'eth3', virtual: false, utilPct: 2, errPerSec: 0, dropPerSec: 0, status: 'ok' },
  ]);
  assert.equal(f.busy_port_count, 3);
  assert.equal(verdictOf('l2_loop', { iface: f }), VERDICTS.CONFIRMED);
});

test('comparing two paths says whether the question was asked at all', () => {
  assert.deepEqual(comparePaths({ hops: [{ ip: 'a' }] }, null), { compared: false });
  assert.deepEqual(comparePaths({ hops: [{ ip: 'a' }, { ip: 'b' }] }, { hops: [{ ip: 'b' }, { ip: 'a' }] }), { compared: true, same_hops: true });
  assert.deepEqual(comparePaths({ hops: [{ ip: 'a' }, { ip: 'b' }] }, { hops: [{ ip: 'x' }, { ip: 'y' }] }), { compared: true, same_hops: false });
});

// --- fixes -------------------------------------------------------------------

test('a fix fills its placeholders from the measurements', () => {
  const facts = { path_mtu: { recommended_mss: 1360, mtu_drop_at_hop: 3, path_mtu: 1400, mss_observed: 1460 } };
  const r = evaluatePlaybook(pb('mtu_blackhole'), { ...facts, path_mtu: { ...facts.path_mtu, blackhole_detected: true } }, { locale: 'da' });
  const mss = r.fixes.find((f) => f.text.includes('1360'));
  assert.ok(mss, `no fix carried the MSS: ${r.fixes.map((f) => f.text).join(' | ')}`);
  assert.equal(mss.complete, true);
});

test('a placeholder nothing measured says so, rather than leaving braces on the screen', () => {
  const r = fillFix('Clamp MSS to {path_mtu.recommended_mss}.', {}, 'en');
  assert.equal(r.complete, false);
  assert.ok(!r.text.includes('{'), r.text);
  assert.match(r.text, /not measured yet/);
  assert.deepEqual(r.missing, ['path_mtu.recommended_mss']);
  assert.match(fillFix('MSS {path_mtu.recommended_mss}.', {}, 'da').text, /ikke målt endnu/);
});

test('a cause that has been ruled out is not handed a repair plan', () => {
  const r = evaluatePlaybook(pb('mtu_blackhole'), CASES.mtu_blackhole.rule_out);
  assert.equal(r.verdict, VERDICTS.RULED_OUT);
  assert.deepEqual(r.fixes, [], 'showing fixes for an eliminated cause invites somebody to do them');
});

// --- ordering ----------------------------------------------------------------

test('the session lists what is confirmed, then what is open, then what is eliminated', () => {
  const facts = buildFacts({
    results: [
      { type: 'ping', ok: true, lossPct: 0, df: true, sizes: [{ bytes: 64, lossPct: 0, measured: true }, { bytes: 1472, lossPct: 100, measured: true }] },
      { type: 'traceroute', ok: true, hops: [{ hop: 1, ip: 'a', lossPct: 0 }] },
    ],
  });
  const r = evaluateSession([pb('hop_packet_loss'), pb('mtu_blackhole'), pb('dns_resolution')], facts);
  assert.equal(r.causes[0].playbookId, 'mtu_blackhole');
  assert.equal(r.causes[0].verdict, VERDICTS.CONFIRMED);
  assert.equal(r.causes[r.causes.length - 1].verdict, VERDICTS.RULED_OUT);
  assert.equal(r.counts.confirmed, 1);
  assert.ok(r.missingFacts.length > 0, 'the session says what would settle the rest');
});
