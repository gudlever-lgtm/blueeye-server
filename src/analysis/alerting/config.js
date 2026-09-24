'use strict';

const { Severity } = require('../constants');

// Severity ordering for "minimum severity" rules.
const RANK = { INFO: 1, WARN: 2, CRIT: 3 };
function rank(sev) { return RANK[sev] || 0; }

function toBool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function toInt(v, d) { const n = Number.parseInt(v, 10); return Number.isNaN(n) ? d : n; }
function sevOf(v, d) { const s = String(v || '').toUpperCase(); return RANK[s] ? s : d; }

// THE MASTER SWITCH IS TRI-STATE.
//
// ALERTING_ENABLED used to default to false, so a customer who configured an
// e-mail or webhook channel — and did nothing else — still got no alert at
// all, and nothing said why. The rule now:
//
//   ALERTING_ENABLED unset (or "auto") → on iff at least ONE channel is
//                                         configured (enabled + has a target)
//   ALERTING_ENABLED=true/1/yes/on     → on
//   ALERTING_ENABLED=false/0/no/off    → off, even with channels configured
//
// The same three states are the Settings → Alerting master switch
// (`enabledMode`: auto | on | off, see services/settings.js), and the
// effective state carries the REASON, so GET /api/alerting/config — and the
// settings screen that reads it — can say "on, because the e-mail channel is
// configured" or "off, switched off explicitly" instead of a bare boolean.
//
// `enabledSetting` is the operator's choice (true | false | null = automatic);
// `enabled` is the effective answer every consumer reads, and is recomputed by
// refreshEffectiveEnabled() whenever the setting or a channel changes.

// true | false | null (automatic) from an env value. Anything that is not
// clearly "on" or "automatic" is an explicit off — the previous fail-closed
// reading of an unrecognised value.
function parseEnabledSetting(v) {
  if (v === undefined || v === null) return null;
  if (v === true || v === false) return v;
  const str = String(v).trim();
  if (str === '' || /^auto$/i.test(str)) return null;
  return /^(1|true|yes|on)$/i.test(str);
}

// A channel is CONFIGURED when it is switched on and has somewhere to send to.
// An enabled channel with no address would never deliver, so it does not turn
// alerting on by itself.
function channelConfigured(name, c) {
  if (!c || !c.enabled) return false;
  const has = (v) => typeof v === 'string' ? v.trim() !== '' : v != null;
  if (name === 'email') return has(c.to) && Boolean(c.smtp && has(c.smtp.host));
  if (name === 'webhook') return has(c.url);
  if (name === 'matrix') return has(c.homeserver) && has(c.roomId) && has(c.accessToken);
  if (name === 'syslog') return has(c.host);
  return false;
}

function configuredChannels(cfg) {
  const ch = (cfg && cfg.channels) || {};
  return Object.keys(ch).filter((name) => channelConfigured(name, ch[name]));
}

// The effective master switch and why:
//   { enabled, setting, reason, configuredChannels }
// reason: 'explicit-on' | 'explicit-off' | 'auto-channels' | 'auto-no-channels'.
// A config without `enabledSetting` (built by hand, e.g. in a test) is read as
// an explicit choice of its `enabled` flag.
function resolveAlertingEnabled(cfg) {
  const c = cfg || {};
  const setting = Object.prototype.hasOwnProperty.call(c, 'enabledSetting')
    ? parseEnabledSetting(c.enabledSetting)
    : Boolean(c.enabled);
  const configured = configuredChannels(c);
  if (setting === true) return { enabled: true, setting, reason: 'explicit-on', configuredChannels: configured };
  if (setting === false) return { enabled: false, setting, reason: 'explicit-off', configuredChannels: configured };
  return configured.length
    ? { enabled: true, setting: null, reason: 'auto-channels', configuredChannels: configured }
    : { enabled: false, setting: null, reason: 'auto-no-channels', configuredChannels: configured };
}

// Recomputes `enabled` (+ `enabledReason`) on a live config IN PLACE, so every
// consumer holding the object sees the new answer. Returns the resolution.
function refreshEffectiveEnabled(cfg) {
  const r = resolveAlertingEnabled(cfg);
  cfg.enabled = r.enabled;
  cfg.enabledReason = r.reason;
  return r;
}

// Alerting configuration, read from the same env mechanism as the rest of the
// server. Channels are disabled until configured; sensible default minimum
// severities (webhook = CRIT only, syslog = everything, email = WARN+).
function loadAlertingConfig(env = process.env) {
  const cfg = {
    // The operator's choice (true/false/null = automatic) and the effective
    // answer — filled in below, once the channels are known.
    enabledSetting: parseEnabledSetting(env.ALERTING_ENABLED),
    enabled: false,
    enabledReason: null,
    cooldownMs: toInt(env.ALERT_COOLDOWN_MS, 15 * 60 * 1000),
    channels: {
      email: {
        enabled: toBool(env.ALERT_EMAIL_ENABLED, false),
        minSeverity: sevOf(env.ALERT_EMAIL_MIN_SEVERITY, Severity.WARN),
        from: env.ALERT_EMAIL_FROM || 'blueeye@localhost',
        to: env.ALERT_EMAIL_TO || '',
        smtp: {
          host: env.SMTP_HOST || '',
          port: toInt(env.SMTP_PORT, 587),
          user: env.SMTP_USER || '',
          pass: env.SMTP_PASS || '',
          secure: toBool(env.SMTP_SECURE, false),
        },
      },
      webhook: {
        enabled: toBool(env.ALERT_WEBHOOK_ENABLED, false),
        minSeverity: sevOf(env.ALERT_WEBHOOK_MIN_SEVERITY, Severity.CRIT),
        url: env.ALERT_WEBHOOK_URL || '',
        secret: env.ALERT_WEBHOOK_SECRET || '',
      },
      // Matrix — a room on the customer's OWN homeserver. See
      // channels/matrix.js for why this, rather than Slack or Teams, is the
      // chat channel an on-prem EU product ships. WARN+ by default: a room is
      // read by people, and INFO in a room is how a room gets muted.
      matrix: {
        enabled: toBool(env.ALERT_MATRIX_ENABLED, false),
        minSeverity: sevOf(env.ALERT_MATRIX_MIN_SEVERITY, Severity.WARN),
        homeserver: env.MATRIX_HOMESERVER || '',
        roomId: env.MATRIX_ROOM_ID || '',
        accessToken: env.MATRIX_ACCESS_TOKEN || '',
      },
      syslog: {
        enabled: toBool(env.ALERT_SYSLOG_ENABLED, false),
        minSeverity: sevOf(env.ALERT_SYSLOG_MIN_SEVERITY, Severity.INFO),
        host: env.SYSLOG_HOST || '',
        port: toInt(env.SYSLOG_PORT, 514),
        proto: (env.SYSLOG_PROTO || 'udp').toLowerCase(),
        appName: env.SYSLOG_APP || 'blueeye',
      },
    },
  };
  refreshEffectiveEnabled(cfg);
  return cfg;
}

module.exports = {
  loadAlertingConfig, rank, RANK,
  parseEnabledSetting, channelConfigured, configuredChannels, resolveAlertingEnabled, refreshEffectiveEnabled,
};
