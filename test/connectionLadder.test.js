'use strict';

// The ladder — src/connectionTest/ladder.js, src/connectionTest/lb.js and
// src/connectionTest/arpContext.js.
//
// These are the three pieces that turn nine independent check rows into one
// sentence, so the cases that matter are the ones where a naive reading gets it
// backwards: ping works and the port does not (a filter), the port answers with
// a reset (NOT a filter), ICMP is dead and TCP is fine (not an outage), and a
// handshake that succeeds to a load balancer while the service behind it is
// gone.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { walk, STATUS, LAYERS, targetHost, targetPort } = require('../src/connectionTest/ladder');
const { detectMiddlebox } = require('../src/connectionTest/lb');
const { arpContext } = require('../src/connectionTest/arpContext');

const HOST = 'example.com';
const IP = '93.184.216.34';

const dns = (ok = true, extra = {}) => ({ type: 'dns', target: HOST, ok, rttMs: 8, ...extra });
const ping = (ok = true, extra = {}) => ({ type: 'ping', target: HOST, ok, lossPct: ok ? 0 : 100, rttMs: ok ? 12 : null, ...extra });
const tcp = (port, ok, failure = null, extra = {}) => ({ type: 'tcp', target: `${HOST}:${port}`, ok, rttMs: ok ? 11 : null, failure, ...extra });
const trace = (hops, type = 'traceroute', target = HOST) => ({ type, target, ok: true, hops });
const tlsRow = (ok, extra = {}) => ({ type: 'tls', target: `${HOST}:443`, ok, certExpiryDays: 200, ...extra });
const http = (ok, status, extra = {}) => ({ type: 'http', target: `https://${HOST}/`, ok, status, rttMs: 40, ...extra });

const goodPath = trace([{ hop: 1, ip: '10.0.0.1', lossPct: 0 }, { hop: 2, ip: IP, lossPct: 0 }]);
const goodTcpPath = trace([{ hop: 1, ip: '10.0.0.1' }, { hop: 2, ip: IP }], 'tcptraceroute', `${HOST}:443`);

const rungOf = (r, layer) => r.layers.find((l) => l.layer === layer);

// --------------------------------------------------------------- the ladder

test('the rungs come back in the order a packet meets them', () => {
  const r = walk({ host: HOST, results: [] });
  assert.deepEqual(r.layers.map((l) => l.layer), LAYERS);
  assert.deepEqual(LAYERS, ['dns', 'arp', 'routing', 'firewall', 'tcp', 'nat_lb', 'tls', 'application']);
});

test('nothing measured is "untested", never "clear"', () => {
  const r = walk({ host: HOST, results: [] });
  assert.equal(r.stopsAt, null);
  assert.equal(r.verdict.outcome, 'untested');
  assert.equal(rungOf(r, 'dns').status, STATUS.UNKNOWN);
  assert.equal(rungOf(r, 'tcp').status, STATUS.UNKNOWN);
});

test('ping works and TCP/443 times out — the communication stops at the firewall', () => {
  const r = walk({ host: HOST, results: [dns(), ping(true), goodPath, tcp(443, false, 'timeout'), tcp(80, true)] });
  assert.equal(r.stopsAt, 'firewall');
  assert.equal(r.verdict.outcome, 'stops');
  const fw = rungOf(r, 'firewall');
  assert.equal(fw.status, STATUS.FAILED);
  assert.deepEqual(fw.filtered_ports, [443]);
  assert.match(fw.because, /ICMP is answered and TCP\/443 is dropped/);
  // A host that answers ping is up — the sentence has to say so, because "the
  // server is down" is the wrong conclusion this rung exists to prevent.
  assert.match(fw.because, /could not answer the ping/);
});

test('a reset is NOT a filter — it stops at tcp, and the firewall rung says why', () => {
  const r = walk({ host: HOST, results: [dns(), ping(true), goodPath, tcp(443, false, 'refused')] });
  assert.equal(r.stopsAt, 'tcp');
  const fw = rungOf(r, 'firewall');
  assert.equal(fw.status, STATUS.OK);
  assert.match(fw.because, /reset is the host answering/);
  assert.match(rungOf(r, 'tcp').because, /refused/);
});

test('ICMP filtered and TCP open is not an outage', () => {
  const r = walk({ host: HOST, results: [dns(), ping(false), tcp(443, true)] });
  assert.equal(r.stopsAt, null);
  const fw = rungOf(r, 'firewall');
  assert.equal(fw.status, STATUS.SUSPECT);
  assert.match(fw.because, /ICMP-only monitor calls this an outage; it is not one/);
});

test('both directions dead is the path, not a rule', () => {
  const r = walk({ host: HOST, results: [dns(), ping(false), tcp(443, false, 'timeout')] });
  assert.equal(rungOf(r, 'firewall').status, STATUS.UNKNOWN);
  assert.equal(r.stopsAt, 'tcp');
});

test('a TCP failure the agent did not classify cannot become a firewall finding', () => {
  const r = walk({ host: HOST, results: [ping(true), tcp(443, false, null)] });
  const fw = rungOf(r, 'firewall');
  assert.equal(fw.status, STATUS.UNKNOWN);
  assert.match(fw.because, /did not report how/);
});

test('DNS failure stops everything and the rungs above it are "unreached"', () => {
  const r = walk({ host: HOST, results: [dns(false, { errorCode: 'NXDOMAIN' }), ping(true), tcp(443, true), tlsRow(true)] });
  assert.equal(r.stopsAt, 'dns');
  assert.equal(rungOf(r, 'dns').error_code, 'NXDOMAIN');
  // TLS "succeeded", and saying so would be a lie: the name never resolved, so
  // whatever answered was not reached through the name that is broken.
  assert.equal(rungOf(r, 'tls').status, STATUS.UNREACHED);
  assert.equal(rungOf(r, 'tls').would_have_said, STATUS.OK);
});

test('an address target has no DNS rung to fail', () => {
  const r = walk({ host: IP, results: [{ type: 'ping', target: IP, ok: true, lossPct: 0 }] });
  assert.equal(rungOf(r, 'dns').status, STATUS.NA);
});

test('the application rung reports the HTTP status without overwriting its own', () => {
  // Regression: the rung's `status` field and the HTTP status are both called
  // status, and an extra that shadowed the verdict made the ladder report 502
  // where it meant to report "failed".
  const r = walk({ host: HOST, results: [dns(), ping(true), goodPath, tcp(443, true), tlsRow(true), http(false, 502)] });
  const app = rungOf(r, 'application');
  assert.equal(app.status, STATUS.FAILED);
  assert.equal(app.http_status, 502);
  assert.equal(r.stopsAt, 'application');
});

test('a 404 stops at the application and says the service is running', () => {
  const r = walk({ host: HOST, results: [dns(), ping(true), goodPath, tcp(443, true), tlsRow(true), http(false, 404)] });
  assert.equal(r.stopsAt, 'application');
  assert.match(rungOf(r, 'application').because, /it is running and it refused the request/);
});

test('a 500 stops at the application and says the code failed', () => {
  const r = walk({ host: HOST, results: [dns(), ping(true), goodPath, tcp(443, true), tlsRow(true), http(false, 500)] });
  assert.equal(r.stopsAt, 'application');
  assert.match(rungOf(r, 'application').because, /reached the code and the code failed/);
  assert.equal(rungOf(r, 'application').http_status, 500);
});

test('the port opens, the service does not answer, and a load balancer is in the path', () => {
  const r = walk({
    host: HOST,
    results: [
      dns(), ping(true), goodPath, tcp(443, true), tlsRow(true),
      trace([{ hop: 1, ip: '10.0.0.1' }, { hop: 2, ip: '203.0.113.9' }], 'tcptraceroute', `${HOST}:443`),
      http(false, 502),
    ],
  });
  assert.equal(r.stopsAt, 'application');
  assert.equal(rungOf(r, 'nat_lb').status, STATUS.SUSPECT);
  // The middlebox is below the stop, so it belongs in the answer.
  assert.match(r.verdict.text, /Also worth knowing/);
  assert.match(r.verdict.text, /203\.0\.113\.9/);
});

test('everything green with both paths walked is "clear"', () => {
  const r = walk({
    host: HOST,
    results: [dns(), ping(true), goodPath, goodTcpPath, tcp(443, true), tlsRow(true), http(true, 200)],
  });
  assert.equal(r.stopsAt, null);
  assert.equal(r.verdict.outcome, 'clear');
  assert.equal(rungOf(r, 'nat_lb').status, STATUS.OK);
});

test('a partly-run ladder says it is not complete rather than clear', () => {
  const r = walk({ host: HOST, results: [dns(), ping(true), goodPath, tcp(443, true)] });
  assert.equal(r.verdict.outcome, 'partial');
  assert.ok(r.untested.includes('tls'));
  assert.ok(r.untested.includes('application'));
});

test('sustained loss that never reaches the target stops at routing', () => {
  const r = walk({
    host: HOST,
    results: [dns(), trace([{ hop: 1, ip: '10.0.0.1', lossPct: 0 }, { hop: 2, ip: null, lossPct: 100 }, { hop: 3, ip: null, lossPct: 100 }])],
  });
  assert.equal(r.stopsAt, 'routing');
  assert.equal(rungOf(r, 'routing').hop, 2);
});

test('loss at one middle hop that does not continue is not a fault', () => {
  const r = walk({
    host: HOST,
    results: [dns(), trace([{ hop: 1, ip: '10.0.0.1', lossPct: 0 }, { hop: 2, ip: '10.0.0.2', lossPct: 60 }, { hop: 3, ip: IP, lossPct: 0 }])],
  });
  assert.equal(rungOf(r, 'routing').status, STATUS.OK);
});

test('a certificate close to expiry is worth knowing without being a break', () => {
  const r = walk({ host: HOST, results: [dns(), ping(true), goodPath, tcp(443, true), tlsRow(true, { certExpiryDays: 5 })] });
  assert.equal(rungOf(r, 'tls').status, STATUS.SUSPECT);
  assert.equal(r.stopsAt, null);
});

test('a failed handshake stops at TLS and quotes the agent\'s own words', () => {
  const r = walk({ host: HOST, results: [dns(), ping(true), goodPath, tcp(443, true), tlsRow(false, { detail: 'certificate expired 3 days ago' })] });
  assert.equal(r.stopsAt, 'tls');
  // The frame is ours and translated; the agent's clause is quoted inside it
  // rather than rewritten, so it still matches what a log would say.
  assert.match(rungOf(r, 'tls').because, /certificate expired 3 days ago/);
});

test('results for another destination never decide this one', () => {
  const r = walk({
    host: HOST,
    results: [
      { type: 'ping', target: 'other.example', ok: false, lossPct: 100 },
      { type: 'tcp', target: 'other.example:443', ok: false, failure: 'timeout' },
      ping(true), tcp(443, true),
    ],
  });
  assert.equal(rungOf(r, 'firewall').status, STATUS.OK);
  assert.equal(r.stopsAt, null);
});

test('the symptom is echoed back, bounded, and never interpreted', () => {
  const r = walk({ host: HOST, results: [], symptom: 'x'.repeat(900) });
  assert.equal(r.symptom.length, 500);
  // It changes nothing about the verdict — the ladder is fixed.
  assert.equal(r.verdict.outcome, 'untested');
});

// --------------------------------------------------------------- targets

test('a probe target is attributed to the right destination whatever shape it has', () => {
  assert.equal(targetHost({ type: 'ping', target: 'example.com' }), 'example.com');
  assert.equal(targetHost({ type: 'tcp', target: 'example.com:443' }), 'example.com');
  assert.equal(targetHost({ type: 'http', target: 'https://example.com/a/b' }), 'example.com');
  assert.equal(targetHost({ type: 'tcp', target: '[2001:db8::1]:443' }), '2001:db8::1');
  assert.equal(targetHost({ type: 'ping', target: '2001:db8::1' }), '2001:db8::1');
  assert.equal(targetPort({ target: 'example.com:80' }), 80);
  assert.equal(targetPort({ target: 'example.com' }), null);
});

test('an IPv6 destination reaches its own rows', () => {
  const r = walk({
    host: '2001:db8::1',
    results: [
      { type: 'ping', target: '2001:db8::1', ok: true, lossPct: 0 },
      { type: 'tcp', target: '[2001:db8::1]:443', ok: false, failure: 'timeout' },
    ],
  });
  assert.equal(r.stopsAt, 'firewall');
});

// --------------------------------------------------------------- middlebox

test('two paths that end at the same address rule a middlebox OUT', () => {
  const m = detectMiddlebox({ traceroute: goodPath, tcptraceroute: goodTcpPath });
  assert.equal(m.present, false);
  assert.equal(m.evidence[0].kind, 'paths_agree');
});

test('two paths that end at different addresses are an observed middlebox', () => {
  const m = detectMiddlebox({
    traceroute: goodPath,
    tcptraceroute: trace([{ hop: 1, ip: '10.0.0.1' }, { hop: 2, ip: '203.0.113.9' }], 'tcptraceroute'),
  });
  assert.equal(m.present, true);
  assert.equal(m.basis, 'observed');
  assert.equal(m.evidence[0].kind, 'path_divergence');
});

test('one path walked is not enough to say either way', () => {
  const m = detectMiddlebox({ traceroute: goodPath });
  assert.equal(m.present, null, 'a question that was not asked has no answer');
});

test('several addresses at one hop are observed, and only when the agent sent the list', () => {
  const withList = detectMiddlebox({
    traceroute: trace([{ hop: 1, ip: '10.0.0.1' }, { hop: 2, ip: IP, ips: [IP, '93.184.216.35'] }]),
  });
  assert.equal(withList.present, true);
  assert.equal(withList.evidence[0].kind, 'multi_path_hop');
  // An older agent reports one address per hop however many answered.
  const withoutList = detectMiddlebox({ traceroute: goodPath });
  assert.equal(withoutList.present, null);
});

test('a 502 is a middlebox only by inference, and says so', () => {
  const m = detectMiddlebox({ http: { status: 502 } });
  assert.equal(m.present, true);
  assert.equal(m.basis, 'inferred');
  assert.equal(m.evidence[0].key, 'lb.gateway');
  assert.equal(m.evidence[0].params.status, 502);
});

test('a certificate for another name is a front end identifying itself', () => {
  const m = detectMiddlebox({ tls: { tls: { hostnameMatches: false, servername: HOST, subject: 'cdn.example.net' } }, host: HOST });
  assert.equal(m.present, true);
  assert.equal(m.basis, 'observed');
  assert.equal(m.evidence[0].key, 'lb.cert.subject');
  assert.equal(m.evidence[0].params.subject, 'cdn.example.net');
});

// --------------------------------------------------------------- ARP context

const arpRepo = (own, hits = []) => ({
  listForAgent: async () => own,
  findByIp: async () => hits,
});

test('ARP is not on the path to a routed destination, and that is not a fault', async () => {
  const ctx = await arpContext({ arpRepo: arpRepo([{ ip: '192.168.1.5', agentId: 1 }]), agentId: 1, ip: IP });
  assert.equal(ctx.onLocalSegment, false);
  const r = walk({ host: IP, arp: ctx, results: [{ type: 'ping', target: IP, ok: true, lossPct: 0 }] });
  assert.equal(rungOf(r, 'arp').status, STATUS.NA);
  assert.equal(r.stopsAt, null);
});

test('an address on the agent\'s own segment with no MAC ever reported is a break', async () => {
  const ctx = await arpContext({ arpRepo: arpRepo([{ ip: '192.168.1.5', agentId: 1 }], []), agentId: 1, ip: '192.168.1.9' });
  assert.equal(ctx.onLocalSegment, true);
  assert.equal(ctx.mac, null);
  const r = walk({ host: '192.168.1.9', arp: ctx, results: [] });
  assert.equal(r.stopsAt, 'arp');
  assert.match(rungOf(r, 'arp').because, /no MAC has ever been reported/);
});

test('a neighbour reported by this agent answers the rung', async () => {
  const ctx = await arpContext({
    arpRepo: arpRepo(
      [{ ip: '192.168.1.5', agentId: 1 }],
      [{ ip: '192.168.1.9', agentId: 2, mac: 'aa:bb:cc:00:00:02', source: 'snmp', lastSeen: '2026-01-01T00:00:00.000Z' },
       { ip: '192.168.1.9', agentId: 1, mac: 'aa:bb:cc:00:00:01', source: 'capabilities', lastSeen: '2026-01-02T00:00:00.000Z' }]
    ),
    agentId: 1,
    ip: '192.168.1.9',
  });
  // The same RFC1918 address exists at more than one site — only this agent's
  // own entry answers "what is at that address, from here".
  assert.equal(ctx.mac, 'aa:bb:cc:00:00:01');
  const r = walk({ host: '192.168.1.9', arp: ctx, results: [] });
  assert.equal(rungOf(r, 'arp').status, STATUS.OK);
});

test('an agent that has never reported a neighbour table leaves the rung unanswerable', async () => {
  const ctx = await arpContext({ arpRepo: arpRepo([]), agentId: 1, ip: '192.168.1.9' });
  assert.equal(ctx.onLocalSegment, null);
  const r = walk({ host: '192.168.1.9', arp: ctx, results: [] });
  assert.equal(rungOf(r, 'arp').status, STATUS.UNKNOWN);
});

test('no ARP repository at all is unknown, never a failed rung', async () => {
  assert.equal(await arpContext({ arpRepo: null, agentId: 1, ip: '192.168.1.9' }), null);
  const r = walk({ host: '192.168.1.9', arp: null, results: [] });
  assert.equal(rungOf(r, 'arp').status, STATUS.UNKNOWN);
});

// --------------------------------------------------------------- language

const { missingKeys, STRINGS, LOCALES } = require('../src/connectionTest/i18n');

test('every ladder sentence exists in every locale', () => {
  assert.deepEqual(missingKeys(), {}, 'a rung was added with a sentence in one language only');
});

test('every key any rung can emit has a sentence behind it', () => {
  // Sweeps EVERY ladder for the keys it actually uses rather than a list
  // somebody remembered to update: a rung wired to a key that does not exist
  // renders the key itself into the verdict, which is how an operator finds out.
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src', 'connectionTest');
  const files = [path.join(dir, 'lb.js'), ...fs.readdirSync(path.join(dir, 'ladders')).map((f) => path.join(dir, 'ladders', f))];
  const src = files.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  // Any single-quoted string that looks like a message key. Broad on purpose:
  // a sweep that has to be taught each new rung's spelling is a sweep that goes
  // stale the first time somebody writes a ternary.
  // Only keys whose first segment names a rung or a shared sentence group —
  // which keeps a default probe target ('example.com') and a filename out of it
  // without having to list every rung's spelling.
  const GROUPS = new Set([...new Set(
    require('../src/connectionTest/ladders').catalogue().flatMap((d) => d.layers)
  ), 'lb', 'natlb', 'app', 'rung', 'verdict', 'symmetry', 'direction', 'latency', 'mtu']);
  const used = [...src.matchAll(/'([a-z_]+)\.([a-z_0-9]+(?:\.[a-z_0-9]+)*)'/g)]
    .filter((m) => GROUPS.has(m[1]))
    .map((m) => `${m[1]}.${m[2]}`);
  assert.ok(used.length > 50, `only found ${used.length} keys — the sweep is not reading the ladders`);
  for (const k of new Set(used)) {
    assert.ok(Object.prototype.hasOwnProperty.call(STRINGS.en, k), `no sentence for "${k}"`);
  }
});

test('every rung id has a layer name in both catalogues', () => {
  const ladders = require('../src/connectionTest/ladders');
  for (const def of ladders.catalogue()) {
    for (const l of def.layers) {
      for (const loc of LOCALES) {
        assert.ok(Object.prototype.hasOwnProperty.call(STRINGS[loc], `layer.${l}`), `${def.id}: no ${loc} name for rung "${l}"`);
      }
    }
  }
});

test('every ladder answers every rung, in both languages, from nothing', () => {
  // The worst case a ladder can be asked: an empty context. Every rung still
  // has to produce a sentence, in both languages, with no placeholder left in
  // it — because "we measured nothing" is the state a screen opens in.
  const ladders = require('../src/connectionTest/ladders');
  for (const id of ladders.ids()) {
    for (const loc of LOCALES) {
      const r = ladders.walk({ ladder: id, ctx: {}, locale: loc });
      assert.equal(r.ladder, id);
      for (const l of r.layers) {
        assert.ok(l.because && l.because.length > 5, `${id}/${loc}/${l.layer}: no sentence`);
        assert.ok(!/^[a-z_]+\.[a-z_.]+$/.test(l.because), `${id}/${loc}/${l.layer} rendered its key: ${l.because}`);
        assert.ok(!l.because.includes('{'), `${id}/${loc}/${l.layer} left a placeholder: ${l.because}`);
      }
      assert.ok(!r.verdict.text.includes('{'), `${id}/${loc}: ${r.verdict.text}`);
    }
  }
});

test('a Danish verdict is Danish, and the technical terms are left alone', () => {
  const results = [dns(), ping(true), goodPath, tcp(443, false, 'timeout')];
  const da = walk({ host: HOST, results, locale: 'da' });
  assert.equal(da.locale, 'da');
  assert.equal(da.stopsAt, 'firewall');
  assert.match(da.verdict.text, /Kommunikationen stopper ved firewallen/);
  assert.match(da.verdict.text, /droppes lydløst/);
  // Protocol and product names stay as they are — an engineer reads them off
  // the equipment in the same words in either language.
  for (const term of ['ICMP', 'TCP/443', 'ACL', 'security group', 'ping', 'firewall']) {
    assert.ok(da.verdict.text.includes(term), `"${term}" was translated`);
  }
  // And nothing leaked from the English catalogue.
  assert.ok(!/dropped in silence/.test(da.verdict.text));
});

test('every rung answers in Danish, in every state it can reach', () => {
  const cases = [
    { host: HOST, results: [] },
    { host: HOST, results: [dns(false, { errorCode: 'NXDOMAIN' })] },
    { host: HOST, results: [dns(), ping(true), goodPath, tcp(443, false, 'refused')] },
    { host: HOST, results: [dns(), ping(false), tcp(443, true)] },
    { host: HOST, results: [dns(), ping(true), goodPath, goodTcpPath, tcp(443, true), tlsRow(true, { certExpiryDays: 3 })] },
    { host: HOST, results: [dns(), ping(true), goodPath, tcp(443, true), tlsRow(true), http(false, 500)] },
    { host: IP, arp: { onLocalSegment: true, mac: null }, results: [] },
  ];
  for (const c of cases) {
    const da = walk({ ...c, locale: 'da' });
    for (const l of da.layers) {
      assert.ok(l.because && l.because.length > 5, `${l.layer} has no sentence`);
      // A rendered key is what an untranslated rung looks like.
      assert.ok(!/^[a-z_]+\.[a-z_.]+$/.test(l.because), `${l.layer} rendered its key: ${l.because}`);
      assert.ok(!l.because.includes('{'), `${l.layer} left a placeholder: ${l.because}`);
    }
    assert.ok(!da.verdict.text.includes('{'), da.verdict.text);
  }
});

test('an unknown locale falls back to English rather than to the key', () => {
  const r = walk({ host: HOST, results: [dns()], locale: 'de' });
  assert.equal(r.locale, 'en');
  assert.match(rungOf(r, 'dns').because, /the name resolved/);
});

// --------------------------------------------------------------- config

const { DEFAULT_CONFIG, LOCKED_ORDER, MOVABLE, resolveConfig, validateOrder } = require('../src/connectionTest/ladder');

test('the causal chain cannot be reordered', () => {
  assert.equal(validateOrder([...LAYERS]), null);
  // TLS above TCP would report "stops at TLS" for a port that never opened.
  const bad = ['dns', 'arp', 'routing', 'firewall', 'tls', 'tcp', 'nat_lb', 'application'];
  assert.match(validateOrder(bad), /causal chain/);
  assert.match(validateOrder(['dns']), /all 8 rungs/);
  assert.match(validateOrder(['dns', 'dns', 'arp', 'routing', 'firewall', 'tcp', 'tls', 'application']), /repeat/);
  assert.match(validateOrder(['nope', 'arp', 'routing', 'firewall', 'tcp', 'nat_lb', 'tls', 'application']), /missing "dns"/);
  assert.equal(validateOrder('not an array'), 'order must list all 8 rungs');
});

test('the rungs that are observations, not steps, may go anywhere', () => {
  for (const movable of MOVABLE) {
    const rest = LAYERS.filter((l) => l !== movable);
    // At the very top and at the very bottom — both legal, because neither
    // gates the rung after it.
    assert.equal(validateOrder([movable, ...rest]), null, `${movable} could not go first`);
    assert.equal(validateOrder([...rest, movable]), null, `${movable} could not go last`);
  }
  assert.deepEqual(LOCKED_ORDER, ['dns', 'routing', 'firewall', 'tcp', 'tls', 'application']);
});

test('a rung switched off says so, and does not shrink the ladder', () => {
  const results = [dns(), ping(true), goodPath, tcp(443, true), tlsRow(true), http(true, 200)];
  const r = walk({ host: HOST, results, config: { enabled: { tls: false } } });
  const tlsRung = rungOf(r, 'tls');
  assert.equal(tlsRung.status, STATUS.UNKNOWN);
  assert.equal(tlsRung.disabled, true);
  assert.match(tlsRung.because, /switched off in Settings/);
  // Eight rungs, still. And the verdict does not claim to be complete.
  assert.equal(r.layers.length, 8);
  assert.equal(r.verdict.outcome, 'partial');
  const da = walk({ host: HOST, results, config: { enabled: { tls: false } }, locale: 'da' });
  assert.match(rungOf(da, 'tls').because, /slået fra under Indstillinger/);
});

test('a reordered ladder is walked in the order it was given', () => {
  const order = ['nat_lb', 'dns', 'routing', 'firewall', 'tcp', 'tls', 'application', 'arp'];
  const r = walk({ host: HOST, results: [dns(), ping(true), goodPath, tcp(443, false, 'timeout')], config: { order } });
  assert.deepEqual(r.layers.map((l) => l.layer), order);
  assert.equal(r.stopsAt, 'firewall');
  // ARP now sits ABOVE the break, so it is reported as unreached rather than
  // as an answer — the rule holds whatever the order is.
  assert.equal(rungOf(r, 'arp').status, STATUS.NA, 'a name has no ARP rung in any position');
});

test('thresholds come from the config', () => {
  const near = [dns(), ping(true), goodPath, tcp(443, true), tlsRow(true, { certExpiryDays: 30 })];
  assert.equal(rungOf(walk({ host: HOST, results: near }), 'tls').status, STATUS.OK);
  assert.equal(rungOf(walk({ host: HOST, results: near, config: { certWarnDays: 60 } }), 'tls').status, STATUS.SUSPECT);

  const lossy = [dns(), trace([{ hop: 1, ip: '10.0.0.1', lossPct: 0 }, { hop: 2, ip: null, lossPct: 8 }, { hop: 3, ip: null, lossPct: 8 }])];
  assert.equal(rungOf(walk({ host: HOST, results: lossy }), 'routing').status, STATUS.FAILED);
  assert.equal(rungOf(walk({ host: HOST, results: lossy, config: { lossThresholdPct: 20 } }), 'routing').status, STATUS.SUSPECT);
});

test('a config that cannot be honoured falls back field by field, never throws', () => {
  for (const junk of [null, 'str', [], { order: 'nope' }, { order: ['tls', 'tcp'] }, { enabled: 'no' }, { ports: [] }, { ports: ['x', -1, 99999] }, { certWarnDays: -5 }, { lossThresholdPct: 0 }]) {
    const c = resolveConfig(junk);
    assert.deepEqual(c.order, [...DEFAULT_CONFIG.order], JSON.stringify(junk));
    assert.ok(c.ports.length > 0, JSON.stringify(junk));
    assert.ok(c.certWarnDays >= 0 && c.lossThresholdPct >= 1, JSON.stringify(junk));
  }
  assert.deepEqual(resolveConfig({ ports: [8443, 8443, 22] }).ports, [8443, 22]);
});
