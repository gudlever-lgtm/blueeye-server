'use strict';

// The rest of the catalogue: DNS records, blacklists, directory binds, clocks,
// certificates on other ports, TCP ports and databases.
//
// One rule runs through all of them and is what most of these assert: a check
// must tell "we looked and it was bad" apart from "we could not look". The first
// is the monitored service's problem, the second is ours or the network's, and
// collapsing them is how an alert stops meaning anything.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { createDnsCheck } = require('../checks/dns');
const { flatten } = require('../dnsResolve');
const { createRblCheck, reverseIpv4 } = require('../checks/rbl');
const { createLdapCheck, isCredentialFailure } = require('../checks/ldap');
const { createNtpCheck, offsetFrom, requestPacket, writeTimestamp } = require('../checks/ntp');
const { createTlsPortCheck } = require('../checks/tlsPort');
const { createTcpCheck } = require('../checks/tcpPort');
const { createDbCheck, isReadOnly } = require('../checks/db');

const monitor = (type, config, secrets = {}) => ({ id: 1, name: `${type} check`, type, target: 'x', config, secrets });

// ---------------------------------------------------------------------- DNS
const resolverOf = (answers, { code = null, fail = false } = {}) => ({
  calls: [],
  async resolve(name, record, opts) {
    this.calls.push({ name, record, opts });
    if (fail) {
      const err = new Error('SERVFAIL');
      err.code = 'ESERVFAIL';
      err.unreachable = true;
      throw err;
    }
    return { answers: answers[`${record} ${name}`] ?? answers[name] ?? [], ms: 4, code };
  },
});

test('the DNS presets ask the right question without the operator knowing where it lives', async () => {
  const resolver = resolverOf({
    'TXT example.com': ['v=spf1 include:_spf.example.net -all'],
    'TXT _dmarc.example.com': ['v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com'],
    'TXT sel1._domainkey.example.com': ['v=DKIM1; k=rsa; p=MIGf...'],
    'MX example.com': ['10 mx1.example.com', '20 mx2.example.com'],
  });
  const check = createDnsCheck({ resolver });

  for (const [preset, extra] of [['spf', {}], ['dmarc', {}], ['dkim', { selector: 'sel1' }], ['mx', {}]]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await check.check(monitor('dns_record', { domain: 'example.com', preset, min_answers: 1, ...extra }));
    assert.equal(result.status, 'ok', preset);
  }
  assert.deepEqual(resolver.calls.map((c) => `${c.record} ${c.name}`), [
    'TXT example.com', 'TXT _dmarc.example.com', 'TXT sel1._domainkey.example.com', 'MX example.com',
  ]);
});

test('every record type flattens to the strings a check can look inside', () => {
  // The one that matters: a long TXT record is chunked into 255-byte strings on
  // the wire, and comparing them one at a time finds nothing. They are joined
  // with no separator, which is what every mail server does with them.
  assert.deepEqual(flatten('TXT', [['v=spf1 include:', '_spf.example.net -all']]), ['v=spf1 include:_spf.example.net -all']);
  assert.deepEqual(flatten('MX', [{ priority: 10, exchange: 'mx1.example.com' }]), ['10 mx1.example.com']);
  assert.deepEqual(flatten('SRV', [{ priority: 0, weight: 5, port: 5060, name: 'sip.example.com' }]), ['0 5 5060 sip.example.com']);
  assert.deepEqual(flatten('SOA', [{ nsname: 'ns1.example.com', hostmaster: 'hostmaster.example.com', serial: 7 }]), ['ns1.example.com hostmaster.example.com 7']);
  assert.deepEqual(flatten('A', ['203.0.113.7']), ['203.0.113.7']);
  // A single answer that is not an array still flattens rather than throwing.
  assert.deepEqual(flatten('A', '203.0.113.7'), ['203.0.113.7']);
});

test('a missing record and a resolver that will not answer are different verdicts', async () => {
  const missing = createDnsCheck({ resolver: resolverOf({}, { code: 'ENODATA' }) });
  const gone = await missing.check(monitor('dns_record', { domain: 'example.com', preset: 'spf', min_answers: 1 }));
  assert.equal(gone.status, 'failed');
  assert.equal(gone.kind, 'dns_record_missing');
  assert.match(gone.summary, /No TXT record at example\.com/);

  const broken = createDnsCheck({ resolver: resolverOf({}, { fail: true }) });
  const noAnswer = await broken.check(monitor('dns_record', { domain: 'example.com', preset: 'spf' }));
  assert.equal(noAnswer.status, 'unreachable', 'a resolver that is down says nothing about the record');
});

test('a weakened record is caught even though it still resolves', async () => {
  const check = createDnsCheck({
    resolver: resolverOf({ 'TXT _dmarc.example.com': ['v=DMARC1; p=none'] }),
  });
  const weakened = await check.check(monitor('dns_record', {
    domain: 'example.com', preset: 'dmarc', expect_absent: 'p=none', min_answers: 1,
  }));
  assert.equal(weakened.status, 'failed');
  assert.equal(weakened.kind, 'dns_unexpected_record');

  const dropped = await createDnsCheck({
    resolver: resolverOf({ 'TXT example.com': ['v=spf1 -all'] }),
  }).check(monitor('dns_record', {
    domain: 'example.com', preset: 'spf', expect_contains: 'include:_spf.example.net', min_answers: 1,
  }));
  assert.equal(dropped.status, 'failed');
  assert.equal(dropped.kind, 'dns_record_mismatch');
  assert.match(dropped.summary, /no longer contains/);
});

test('a long TXT record split into chunks on the wire is matched as one string', async () => {
  // The resolver flattens chunks; this asserts the check sees the joined value.
  const check = createDnsCheck({
    resolver: resolverOf({ 'TXT example.com': ['v=spf1 include:_spf.example.net ip4:203.0.113.0/24 -all'] }),
  });
  const result = await check.check(monitor('dns_record', {
    domain: 'example.com', preset: 'spf', expect_contains: 'ip4:203.0.113.0/24', min_answers: 1,
  }));
  assert.equal(result.status, 'ok');
});

// ---------------------------------------------------------------------- RBL
test('a listing names the lists and the reason; a clean address is a measured zero', async () => {
  const listed = createRblCheck({
    resolver: {
      async resolve(name, record) {
        if (name.startsWith('4.3.2.1.zen')) {
          return record === 'TXT'
            ? { answers: ['https://check.spamhaus.org/query/ip/1.2.3.4'], ms: 2 }
            : { answers: ['127.0.0.4'], ms: 2 };
        }
        return { answers: [], ms: 2, code: 'ENOTFOUND' };
      },
    },
  });
  const bad = await listed.check(monitor('rbl', { ip: '1.2.3.4', lists: ['zen.spamhaus.org', 'bl.spamcop.net'] }));
  assert.equal(bad.status, 'failed');
  assert.equal(bad.kind, 'rbl_listed');
  assert.equal(bad.value, 1);
  assert.equal(bad.detail.listed[0].list, 'zen.spamhaus.org');
  assert.match(bad.detail.listed[0].reason, /spamhaus/);

  const clean = createRblCheck({
    resolver: { async resolve() { return { answers: [], ms: 2, code: 'ENOTFOUND' }; } },
  });
  const good = await clean.check(monitor('rbl', { ip: '1.2.3.4', lists: ['zen.spamhaus.org'] }));
  assert.equal(good.status, 'ok');
  assert.equal(good.value, 0);
});

test('when no blacklist answers at all, the result is "we could not look" rather than "not listed"', async () => {
  const check = createRblCheck({
    resolver: { async resolve() { throw new Error('SERVFAIL'); } },
  });
  const result = await check.check(monitor('rbl', { ip: '1.2.3.4', lists: ['zen.spamhaus.org'] }));
  assert.equal(result.status, 'unreachable');
});

test('the address is reversed the way a DNSBL expects, and a hostname is refused', async () => {
  assert.equal(reverseIpv4('1.2.3.4'), '4.3.2.1');
  assert.equal(reverseIpv4('mail.example.com'), null);
  assert.equal(reverseIpv4('1.2.3.999'), null);
  const check = createRblCheck({ resolver: { async resolve() { throw new Error('must not be asked'); } } });
  const result = await check.check(monitor('rbl', { ip: 'mail.example.com', lists: ['zen.spamhaus.org'] }));
  assert.equal(result.status, 'misconfigured');
});

// -------------------------------------------------------------------- LDAP
function ldapClient({ bindError = null, entries = [{ dn: 'dc=example,dc=com' }] } = {}) {
  return {
    bound: false,
    unbound: false,
    async bind() { if (bindError) throw bindError; this.bound = true; },
    async search() { return { searchEntries: entries }; },
    async unbind() { this.unbound = true; },
  };
}

test('a bind that is refused and a directory that is unreachable are different incidents', async () => {
  const refused = Object.assign(new Error('Invalid Credentials'), { code: 49 });
  const bad = await createLdapCheck({ clientFactory: () => ldapClient({ bindError: refused }) })
    .check(monitor('ldap_bind', { url: 'ldaps://dc.example.com', bind_dn: 'cn=svc' }, { bind_password: 'x' }));
  assert.equal(bad.status, 'failed');
  assert.equal(bad.kind, 'ldap_bind_failed');

  const down = await createLdapCheck({ clientFactory: () => ldapClient({ bindError: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }) })
    .check(monitor('ldap_bind', { url: 'ldaps://dc.example.com', bind_dn: 'cn=svc' }));
  assert.equal(down.status, 'unreachable');

  assert.equal(isCredentialFailure({ code: 49 }), true);
  assert.equal(isCredentialFailure({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }), false);
});

test('a directory that binds but answers nothing is a half-working directory, and says so', async () => {
  const client = ldapClient({ entries: [] });
  const result = await createLdapCheck({ clientFactory: () => client })
    .check(monitor('ldap_bind', { url: 'ldaps://dc.example.com', bind_dn: 'cn=svc', base_dn: 'dc=example,dc=com' }));
  assert.equal(result.status, 'failed');
  assert.equal(result.kind, 'ldap_search_empty');
  assert.equal(client.unbound, true, 'the connection is always given back');

  const ok = await createLdapCheck({ clientFactory: () => ldapClient() })
    .check(monitor('ldap_bind', { url: 'ldaps://dc.example.com', bind_dn: 'cn=svc', base_dn: 'dc=example,dc=com' }));
  assert.equal(ok.status, 'ok');
  assert.equal(ok.unit, 'ms');
});

test('without ldapts the check reports misconfigured rather than pretending the directory is down', async () => {
  const result = await createLdapCheck({ clientFactory: () => null })
    .check(monitor('ldap_bind', { url: 'ldaps://dc.example.com', bind_dn: 'cn=svc' }));
  assert.equal(result.status, 'misconfigured');
  assert.match(result.summary, /ldapts is not installed/);
});

// --------------------------------------------------------------------- NTP
// A UDP socket that answers with a server packet built from the offset we want
// to measure, so the arithmetic is tested rather than the network.
function ntpSocket({ offsetMs = 0, stratum = 3, silent = false, short = false } = {}) {
  const socket = new EventEmitter();
  socket.close = () => {};
  socket.send = (buf, port, host, cb) => {
    if (cb) cb(null);
    if (silent) return;
    setImmediate(() => {
      const reply = Buffer.alloc(short ? 20 : 48);
      if (!short) {
        reply[1] = stratum;
        const at = Date.now() + offsetMs;
        writeTimestamp(reply, 32, at);   // receive
        writeTimestamp(reply, 40, at);   // transmit
      }
      socket.emit('message', reply);
    });
  };
  return socket;
}

test('the clock offset is measured, signed and reported in milliseconds', async () => {
  const ahead = await createNtpCheck({ createSocket: () => ntpSocket({ offsetMs: 4000 }) })
    .check(monitor('ntp_offset', { host: 'ntp.example.com' }));
  assert.equal(ahead.status, 'ok');
  assert.equal(ahead.unit, 'ms');
  assert.ok(ahead.value > 3500 && ahead.value < 4500, `offset was ${ahead.value}`);
  assert.match(ahead.summary, /ahead of us/);

  const behind = await createNtpCheck({ createSocket: () => ntpSocket({ offsetMs: -4000 }) })
    .check(monitor('ntp_offset', { host: 'ntp.example.com' }));
  assert.match(behind.summary, /behind/);
  assert.ok(behind.value > 3500, 'the value is the absolute offset, so a threshold works in both directions');
});

test('a silent or nonsense NTP answer is unreachable, and a kiss-o\'-death is a refusal', async () => {
  const silent = await createNtpCheck({ createSocket: () => ntpSocket({ silent: true }) })
    .check(monitor('ntp_offset', { host: 'ntp.example.com', timeout_ms: 1000 }));
  assert.equal(silent.status, 'unreachable');

  const short = await createNtpCheck({ createSocket: () => ntpSocket({ short: true }) })
    .check(monitor('ntp_offset', { host: 'ntp.example.com', timeout_ms: 1000 }));
  assert.equal(short.status, 'unreachable');

  const kod = await createNtpCheck({ createSocket: () => ntpSocket({ stratum: 0 }) })
    .check(monitor('ntp_offset', { host: 'ntp.example.com' }));
  assert.equal(kod.status, 'failed');
  assert.equal(kod.kind, 'ntp_offset_high');
});

test('the four-timestamp arithmetic is the standard one', () => {
  // A peer one second ahead, with a 40 ms round trip.
  assert.deepEqual(offsetFrom({ t1: 1000, t2: 2020, t3: 2020, t4: 1040 }), { offset_ms: 1000, delay_ms: 40 });
  assert.equal(offsetFrom({ t1: 1000, t2: null, t3: 2, t4: 3 }), null);
  assert.equal(requestPacket(Date.now()).length, 48);
  assert.equal(requestPacket(Date.now())[0], (4 << 3) | 3, 'version 4, mode 3 (client)');
});

// --------------------------------------------------------------------- TLS
test('a certificate on any port is judged as a deadline, an expiry or a failure', async () => {
  const checkerFor = (row) => ({ async check() { return { host: 'imap.example.com', port: 993, ...row }; } });

  const fine = await createTlsPortCheck({ checker: checkerFor({ status: 'ok', days_remaining: 180, valid_to: new Date() }) })
    .check(monitor('tls_port', { host: 'imap.example.com', port: 993, warn_days: 30 }));
  assert.equal(fine.status, 'ok');
  assert.equal(fine.unit, 'days');

  const soon = await createTlsPortCheck({ checker: checkerFor({ status: 'expiring', days_remaining: 9 }) })
    .check(monitor('tls_port', { host: 'imap.example.com', port: 993, warn_days: 30 }));
  assert.equal(soon.status, 'failed');
  assert.equal(soon.kind, 'tls_expiring');
  assert.equal(soon.value, 9);

  const gone = await createTlsPortCheck({ checker: checkerFor({ status: 'expired', days_remaining: -2 }) })
    .check(monitor('tls_port', { host: 'imap.example.com', port: 993 }));
  assert.equal(gone.kind, 'tls_expired');
  assert.match(gone.summary, /expired 2 day/);

  const unreachable = await createTlsPortCheck({ checker: checkerFor({ status: 'unreachable', error_message: 'ECONNREFUSED' }) })
    .check(monitor('tls_port', { host: 'imap.example.com', port: 993 }));
  assert.equal(unreachable.status, 'unreachable');
});

// --------------------------------------------------------------------- TCP
function tcpSocket({ banner = null, error = null, connectMs = 0 } = {}) {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  setTimeout(() => {
    if (error) { socket.emit('error', new Error(error)); return; }
    socket.emit('connect');
    if (banner !== null) setImmediate(() => socket.emit('data', Buffer.from(banner)));
  }, connectMs);
  return socket;
}

test('an open port is measured; a refused one is unreachable; a wrong greeting is a mismatch', async () => {
  const open = await createTcpCheck({ connect: () => tcpSocket() })
    .check(monitor('tcp_port', { host: 'mail.example.com', port: 25 }));
  assert.equal(open.status, 'ok');
  assert.equal(open.unit, 'ms');

  const refused = await createTcpCheck({ connect: () => tcpSocket({ error: 'ECONNREFUSED' }) })
    .check(monitor('tcp_port', { host: 'mail.example.com', port: 25 }));
  assert.equal(refused.status, 'unreachable');

  const right = await createTcpCheck({ connect: () => tcpSocket({ banner: '220 mail.example.com ESMTP Postfix\r\n' }) })
    .check(monitor('tcp_port', { host: 'mail.example.com', port: 25, expect_banner: 'ESMTP' }));
  assert.equal(right.status, 'ok');

  const wrong = await createTcpCheck({ connect: () => tcpSocket({ banner: '220 something else\r\n' }) })
    .check(monitor('tcp_port', { host: 'mail.example.com', port: 25, expect_banner: 'ESMTP' }));
  assert.equal(wrong.status, 'failed');
  assert.equal(wrong.kind, 'tcp_banner_mismatch');
});

// ---------------------------------------------------------------- database
test('a database check connects, runs the SELECT and reports both times', async () => {
  const connector = async () => ({
    async query(sql) { assert.equal(sql, 'SELECT 1'); return [{ 1: 1 }]; },
    async close() {},
  });
  const result = await createDbCheck({ connector }).check(monitor('db_connect', { engine: 'mysql', host: 'db.example.com', query: 'SELECT 1' }));
  assert.equal(result.status, 'ok');
  assert.equal(result.detail.rows, 1);
  assert.ok('connect' in result.timings && 'query' in result.timings);
});

test('a database monitor is read-only, and refuses to run anything else', async () => {
  for (const sql of ['DELETE FROM users', 'SELECT 1; DROP TABLE users', 'update t set a=1', 'SET GLOBAL x=1', '']) {
    assert.equal(isReadOnly(sql), false, sql);
  }
  for (const sql of ['SELECT 1', 'select count(*) from orders where created_at > now()', '  SELECT 1;  ']) {
    assert.equal(isReadOnly(sql), true, sql);
  }
  let asked = false;
  const connector = async () => { asked = true; return { async query() { return []; }, async close() {} }; };
  const result = await createDbCheck({ connector })
    .check(monitor('db_connect', { engine: 'mysql', host: 'db.example.com', query: 'DELETE FROM users' }));
  assert.equal(result.status, 'misconfigured');
  assert.equal(asked, false, 'nothing was even connected to');
});

test('a refused login and an unreachable database are different verdicts', async () => {
  const denied = async () => { throw Object.assign(new Error('Access denied for user'), { code: 'ER_ACCESS_DENIED_ERROR' }); };
  const bad = await createDbCheck({ connector: denied }).check(monitor('db_connect', { engine: 'mysql', host: 'db.example.com' }));
  assert.equal(bad.status, 'failed');
  assert.equal(bad.kind, 'db_query_failed');

  const down = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
  const gone = await createDbCheck({ connector: down }).check(monitor('db_connect', { engine: 'mysql', host: 'db.example.com' }));
  assert.equal(gone.status, 'unreachable');

  const missing = await createDbCheck({ connector: async () => null }).check(monitor('db_connect', { engine: 'postgres', host: 'db.example.com' }));
  assert.equal(missing.status, 'misconfigured');
});
