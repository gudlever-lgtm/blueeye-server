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

// Alerting configuration, read from the same env mechanism as the rest of the
// server. Channels are disabled until configured; sensible default minimum
// severities (webhook = CRIT only, syslog = everything, email = WARN+).
function loadAlertingConfig(env = process.env) {
  return {
    enabled: toBool(env.ALERTING_ENABLED, false),
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
}

module.exports = { loadAlertingConfig, rank, RANK };
