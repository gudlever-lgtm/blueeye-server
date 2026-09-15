'use strict';

const { ok, failed, unreachable, misconfigured, KIND } = require('../result');

// "Can anyone still sign in?"
//
// Directory failures are the ones the help desk hears about first and monitoring
// hears about last: the certificate on the domain controller expired, the
// service account's password rotated, a replication partner went away. A bind
// every few minutes answers it before the first call.
//
// Two halves, and the second is optional:
//   bind    — the credentials are accepted. Proves authentication works.
//   search  — the directory answers a question. Proves it is not merely
//             listening; a DC that binds and then cannot read is a real state.
//
// ldapts is lazily required (it is already a dependency for LDAP sign-in) and
// injected in tests, so the suite never opens a socket.

function defaultClientFactory({ url, timeoutMs, rejectUnauthorized }) {
  let ldapts;
  try {
    ldapts = require('ldapts'); // eslint-disable-line global-require
  } catch {
    return null;
  }
  return new ldapts.Client({
    url,
    timeout: timeoutMs,
    connectTimeout: timeoutMs,
    tlsOptions: { rejectUnauthorized: rejectUnauthorized !== false },
  });
}

// A refused bind and an unreachable host look similar in an error message and
// mean opposite things: one is "your credentials are wrong", the other is "the
// directory is down". ldapts reports the first as an InvalidCredentials error
// (code 49) and the second as a socket error.
function isCredentialFailure(err) {
  const code = err && (err.code !== undefined ? err.code : null);
  if (code === 49) return true;
  return /invalid credentials|49/i.test(String((err && err.message) || ''));
}

function createLdapCheck({ clientFactory = defaultClientFactory, now = () => Date.now() } = {}) {
  async function check(monitor) {
    const cfg = monitor.config || {};
    const secrets = monitor.secrets || {};
    if (!cfg.url || !cfg.bind_dn) return misconfigured({ summary: 'The monitor needs a directory address and a bind DN.' });

    const timeoutMs = cfg.timeout_ms || 10000;
    const client = clientFactory({ url: cfg.url, timeoutMs, rejectUnauthorized: cfg.tls_reject_unauthorized !== false });
    if (!client) return misconfigured({ summary: 'ldapts is not installed, so directory checks cannot run.' });

    const started = now();
    let boundAt = null;
    try {
      await client.bind(cfg.bind_dn, secrets.bind_password || '');
      boundAt = now();

      if (cfg.base_dn) {
        const result = await client.search(cfg.base_dn, {
          scope: 'base',
          filter: cfg.filter || '(objectClass=*)',
          attributes: ['dn'],
          sizeLimit: 1,
        });
        const entries = (result && result.searchEntries) || [];
        const ms = now() - started;
        if (!entries.length) {
          return failed(KIND.LDAP_SEARCH_EMPTY, {
            summary: `The bind succeeded but ${cfg.base_dn} returned nothing for ${cfg.filter || '(objectClass=*)'}.`,
            value: ms,
            unit: 'ms',
            durationMs: ms,
            timings: { bind: boundAt - started, search: ms - (boundAt - started) },
            detail: { url: cfg.url, bind_dn: cfg.bind_dn, base_dn: cfg.base_dn, filter: cfg.filter || null },
          });
        }
      }

      const ms = now() - started;
      return ok({
        summary: cfg.base_dn
          ? `Bound as ${cfg.bind_dn} and read ${cfg.base_dn} in ${ms} ms.`
          : `Bound as ${cfg.bind_dn} in ${ms} ms.`,
        value: ms,
        unit: 'ms',
        durationMs: ms,
        timings: { bind: boundAt - started, search: ms - (boundAt - started) },
        detail: { url: cfg.url, bind_dn: cfg.bind_dn, base_dn: cfg.base_dn || null },
      });
    } catch (err) {
      const message = (err && err.message) || String(err);
      const ms = now() - started;
      if (isCredentialFailure(err)) {
        return failed(KIND.LDAP_BIND_FAILED, {
          summary: `The directory refused the bind for ${cfg.bind_dn}: ${message}`,
          error: message,
          durationMs: ms,
          detail: { url: cfg.url, bind_dn: cfg.bind_dn },
        });
      }
      return unreachable({
        summary: `Could not reach the directory at ${cfg.url}: ${message}`,
        error: message,
        durationMs: ms,
        detail: { url: cfg.url },
      });
    } finally {
      try { await client.unbind(); } catch { /* the verdict is already made */ }
    }
  }

  return { check };
}

module.exports = { createLdapCheck, isCredentialFailure };
