'use strict';

const dgram = require('dgram');
const { ok, failed, unreachable, KIND } = require('../result');

// "Is that clock right?"
//
// Clock drift is the fault that presents as five other faults. Kerberos refuses
// tickets more than five minutes out, so SSO breaks with an authentication
// error. TOTP codes stop matching. Log correlation across hosts quietly stops
// lining up, which is discovered during the post-mortem of something else.
// Nothing reports "the clock is wrong" — it reports whatever broke because of
// it.
//
// This is SNTP (RFC 4330 §5), the client subset of NTP: one 48-byte packet out,
// one back, four timestamps, two numbers. It does not steer any clock and never
// could — it measures and reports.

// Seconds between the NTP epoch (1900-01-01) and the Unix epoch (1970-01-01).
const NTP_EPOCH_OFFSET = 2208988800;

// An NTP timestamp is 32 bits of seconds and 32 bits of fraction, big-endian.
function readTimestamp(buf, offset) {
  const seconds = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  if (seconds === 0 && fraction === 0) return null;
  return (seconds - NTP_EPOCH_OFFSET) * 1000 + (fraction * 1000) / 2 ** 32;
}

function writeTimestamp(buf, offset, ms) {
  const seconds = Math.floor(ms / 1000) + NTP_EPOCH_OFFSET;
  const fraction = Math.floor(((ms % 1000) / 1000) * 2 ** 32);
  buf.writeUInt32BE(seconds >>> 0, offset);
  buf.writeUInt32BE(fraction >>> 0, offset + 4);
}

// The client request: LI = 0 (no warning), VN = 4, Mode = 3 (client).
function requestPacket(transmitMs) {
  const buf = Buffer.alloc(48);
  buf[0] = (0 << 6) | (4 << 3) | 3;
  writeTimestamp(buf, 40, transmitMs);
  return buf;
}

// The four-timestamp arithmetic every NTP client does:
//   offset = ((T2 − T1) + (T3 − T4)) / 2      how far the peer's clock is from ours
//   delay  = (T4 − T1) − (T3 − T2)            the round trip, minus the peer's own delay
// Exported because it is the whole verdict and deserves its own test.
function offsetFrom({ t1, t2, t3, t4 }) {
  if (![t1, t2, t3, t4].every((v) => Number.isFinite(v))) return null;
  return {
    offset_ms: ((t2 - t1) + (t3 - t4)) / 2,
    delay_ms: Math.max(0, (t4 - t1) - (t3 - t2)),
  };
}

function createNtpCheck({ createSocket = null, now = () => Date.now() } = {}) {
  const open = typeof createSocket === 'function' ? createSocket : (() => dgram.createSocket('udp4'));

  function exchange({ host, port, timeoutMs }) {
    return new Promise((resolve, reject) => {
      let socket;
      let settled = false;
      let sent = null;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        try { if (socket) socket.close(); } catch { /* already closed */ }
        fn(arg);
      };
      try {
        socket = open();
      } catch (err) {
        return reject(err);
      }
      // Not unref'd: this timer is the only thing that turns "the server never
      // answered" into a verdict. It is cleared on the message and on an error.
      const timer = setTimeout(() => finish(reject, new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);

      socket.on('error', (err) => { clearTimeout(timer); finish(reject, err); });
      socket.on('message', (msg) => {
        clearTimeout(timer);
        const t4 = now();
        if (!msg || msg.length < 48) return finish(reject, new Error('the answer was not an NTP packet'));
        return finish(resolve, {
          t1: sent,
          t2: readTimestamp(msg, 32),
          t3: readTimestamp(msg, 40),
          t4,
          stratum: msg[1],
        });
      });

      // t1 is read here rather than taken from the packet's transmit field on
      // the way back: a server is not required to echo it, and measuring with a
      // number we know beats measuring with one we hope for.
      const t1 = now();
      sent = t1;
      socket.send(requestPacket(t1), port, host, (err) => {
        if (err) { clearTimeout(timer); finish(reject, err); }
      });
      return undefined;
    });
  }

  async function check(monitor) {
    const cfg = monitor.config || {};
    const host = cfg.host;
    const port = cfg.port || 123;
    const timeoutMs = cfg.timeout_ms || 5000;
    let answer;
    try {
      answer = await exchange({ host, port, timeoutMs });
    } catch (err) {
      return unreachable({
        summary: `No NTP answer from ${host}: ${(err && err.message) || err}`,
        error: (err && err.message) || String(err),
        detail: { host, port },
      });
    }
    const measured = offsetFrom({ t1: answer.t1, t2: answer.t2, t3: answer.t3, t4: answer.t4 });
    if (!measured) {
      return unreachable({
        summary: `${host} answered without usable timestamps.`,
        detail: { host, port, stratum: answer.stratum },
      });
    }
    const abs = Math.abs(measured.offset_ms);
    const detail = {
      host,
      port,
      offset_ms: Math.round(measured.offset_ms),
      delay_ms: Math.round(measured.delay_ms),
      stratum: answer.stratum,
    };
    // A stratum of 0 in a server reply is a kiss-o'-death packet: the server is
    // telling us to go away, not telling us the time.
    if (answer.stratum === 0) {
      return failed(KIND.NTP_OFFSET_HIGH, {
        summary: `${host} refused the request (kiss-o'-death).`,
        durationMs: measured.delay_ms,
        detail,
      });
    }
    // The threshold lives on the monitor (warn_ms/crit_ms) and is applied by the
    // shared threshold pass, so `value` is the absolute offset: that is the
    // number an operator sets a limit on.
    return ok({
      summary: `${host} is ${measured.offset_ms >= 0 ? 'ahead of' : 'behind'} us by ${Math.round(abs)} ms (round trip ${Math.round(measured.delay_ms)} ms).`,
      value: abs,
      unit: 'ms',
      durationMs: Math.round(measured.delay_ms),
      timings: { delay: Math.round(measured.delay_ms) },
      detail,
    });
  }

  return { check };
}

module.exports = { createNtpCheck, offsetFrom, writeTimestamp, requestPacket };
