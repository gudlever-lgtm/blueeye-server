'use strict';

const { createEmailChannel, createSmtpTransport } = require('./channels/email');
const { createWebhookChannel } = require('./channels/webhook');
const { createSyslogChannel } = require('./channels/syslog');

const silentLogger = { info() {}, warn() {}, error() {} };

// The single alert-output plugin interface. Every channel is a self-contained
// plugin implementing:
//
//   { name: string, send(finding, group) -> Promise<{ ok: boolean, detail?: string }> }
//
// This registry is the one place that knows which alert plugins exist and how to
// build each from its slice of the alerting config — the alerting-side equivalent
// of integrations/connectors/index.js. The dispatcher consumes the returned
// { name: plugin } map unchanged, so payloads, triggers and throttling are
// identical to before; this only centralises construction behind one interface.
//
// NOTE: "Cisco ISE" is NOT a separate plugin. ISE ingests the RFC5424 stream the
// `syslog` plugin already emits (see channels/syslog.js), so syslog IS the ISE
// path — there is no extra output or egress.
function createAlertChannels({ alertingConfig, logger = silentLogger } = {}) {
  const channels = (alertingConfig && alertingConfig.channels) || {};
  return {
    // SMTP transport is built lazily (and rebuilt when SMTP settings change) so an
    // admin editing Settings → Alerting takes effect without a restart.
    email: createEmailChannel({
      config: channels.email,
      createTransport: (smtp) => createSmtpTransport(smtp, logger),
      logger,
    }),
    webhook: createWebhookChannel({ config: channels.webhook, logger }),
    syslog: createSyslogChannel({ config: channels.syslog, logger }),
  };
}

module.exports = { createAlertChannels };
