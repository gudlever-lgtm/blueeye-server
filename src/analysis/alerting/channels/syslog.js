'use strict';

const dgram = require('dgram');
const net = require('net');

const silentLogger = { info() {}, warn() {}, error() {} };

// RFC5424 severity codes for our finding severities. Maps so a downstream
// collector (e.g. Cisco ISE) sees the right level: CRIT→err, WARN→warning,
// INFO→info.
const SYSLOG_SEVERITY = { CRIT: 3, WARN: 4, INFO: 6 };
const FACILITY = 16; // local0

// Builds an RFC5424 syslog line:
//   <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
function rfc5424(finding, { appName = 'blueeye' } = {}) {
  const sev = SYSLOG_SEVERITY[finding.severity] ?? 6;
  const pri = FACILITY * 8 + sev;
  const ts = new Date(finding.createdAt || Date.now()).toISOString();
  const host = String(finding.hostId || '-').replace(/\s+/g, '_') || '-';
  const msg = `${finding.metric || '-'} severity=${finding.severity || 'INFO'} kind=${finding.kind || '-'} ${finding.explanation || ''}`
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return `<${pri}>1 ${ts} ${host} ${appName} - finding - ${msg}`;
}

// Default network send over UDP or TCP. Injected in tests.
function defaultSend(buf, { host, port, proto = 'udp' }) {
  return new Promise((resolve, reject) => {
    if (proto === 'tcp') {
      const sock = net.createConnection({ host, port });
      sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('syslog tcp timeout')); });
      sock.on('error', reject);
      sock.on('connect', () => sock.write(buf, () => { sock.end(); resolve(); }));
    } else {
      const sock = dgram.createSocket('udp4');
      sock.send(buf, port, host, (err) => { sock.close(); if (err) reject(err); else resolve(); });
    }
  });
}

// Syslog channel. send() is injected for tests so nothing hits the network.
function createSyslogChannel({ config = {}, send = defaultSend, logger = silentLogger }) {
  async function sendFinding(finding) {
    if (!config.host) return { ok: false, detail: 'no syslog host configured' };
    const line = rfc5424(finding, { appName: config.appName });
    try {
      await send(Buffer.from(line, 'utf8'), { host: config.host, port: config.port, proto: config.proto });
    } catch (err) {
      logger.warn(`alerting: syslog send failed (${err.message})`);
      return { ok: false, detail: `send failed: ${err.message}` };
    }
    return { ok: true, detail: `sent to ${config.host}:${config.port}/${config.proto}` };
  }

  // Built on Node's dgram/net — no optional dependency, always available.
  function status() {
    return { available: true };
  }

  return { name: 'syslog', send: sendFinding, status };
}

module.exports = { createSyslogChannel, rfc5424, SYSLOG_SEVERITY };
