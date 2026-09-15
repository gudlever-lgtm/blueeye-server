'use strict';

const net = require('net');
const { ok, failed, unreachable, KIND } = require('../result');

// "Is that port open, and is the thing behind it the thing we expect?"
//
// The plainest check in the catalogue, and the one every other one falls back to
// when it fails: before asking why a database check failed, it helps to know
// whether anything is listening at all.
//
// `expect_banner` is what makes it more than a port scan. A service that accepts
// a connection and then says nothing, or says the wrong thing, is open without
// being up — a load balancer answering for a backend that is gone looks exactly
// like a healthy port until you read what it says.

function createTcpCheck({ connect = null, now = () => Date.now() } = {}) {
  const open = typeof connect === 'function' ? connect : ((opts) => net.connect(opts));

  function probe({ host, port, timeoutMs, wantBanner }) {
    return new Promise((resolve) => {
      const started = now();
      let socket;
      let settled = false;
      let banner = '';
      const finish = (row) => {
        if (settled) return;
        settled = true;
        try { if (socket && !socket.destroyed) socket.destroy(); } catch { /* answered */ }
        resolve(row);
      };
      try {
        socket = open({ host, port, timeout: timeoutMs });
      } catch (err) {
        return finish({ error: (err && err.message) || String(err) });
      }
      if (!socket || typeof socket.on !== 'function') return finish({ error: 'no socket' });

      socket.on('error', (err) => finish({ error: (err && err.message) || 'connection failed', ms: now() - started }));
      socket.on('timeout', () => finish({ error: `no answer within ${timeoutMs} ms`, ms: now() - started, banner }));
      socket.on('connect', () => {
        const connected = now() - started;
        if (!wantBanner) return finish({ ms: connected, connect_ms: connected });
        // A greeting is read only when one is wanted. Many protocols send
        // nothing until spoken to, so the wait is bounded by the same timeout
        // and an empty banner is reported rather than waited out forever.
        const wait = setTimeout(() => finish({ ms: now() - started, connect_ms: connected, banner }), Math.min(timeoutMs, 3000));
        socket.on('data', (chunk) => {
          banner += chunk.toString('utf8');
          if (banner.includes('\n') || banner.length > 512) {
            clearTimeout(wait);
            finish({ ms: now() - started, connect_ms: connected, banner });
          }
        });
        return undefined;
      });
      return undefined;
    });
  }

  async function check(monitor) {
    const cfg = monitor.config || {};
    const host = cfg.host;
    const port = cfg.port;
    const timeoutMs = cfg.timeout_ms || 10000;
    const want = cfg.expect_banner ? String(cfg.expect_banner) : null;
    const result = await probe({ host, port, timeoutMs, wantBanner: !!want });

    if (result.error) {
      return unreachable({
        summary: `${host}:${port} did not accept a connection: ${result.error}`,
        error: result.error,
        durationMs: result.ms || null,
        detail: { host, port, kind: KIND.TCP_REFUSED },
      });
    }
    const banner = (result.banner || '').trim().slice(0, 255);
    if (want && !banner.toLowerCase().includes(want.toLowerCase())) {
      return failed(KIND.TCP_BANNER_MISMATCH, {
        summary: banner
          ? `${host}:${port} answered "${banner.slice(0, 80)}", which does not contain "${want}".`
          : `${host}:${port} accepted the connection but said nothing (expected "${want}").`,
        value: result.ms,
        unit: 'ms',
        durationMs: result.ms,
        detail: { host, port, banner, expect_banner: want },
      });
    }
    return ok({
      summary: `${host}:${port} answered in ${Math.round(result.connect_ms)} ms.`,
      value: result.connect_ms,
      unit: 'ms',
      durationMs: result.ms,
      timings: { connect: Math.round(result.connect_ms) },
      detail: { host, port, banner: banner || null },
    });
  }

  return { check };
}

module.exports = { createTcpCheck };
