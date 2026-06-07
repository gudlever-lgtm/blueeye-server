'use strict';

const { createServiceNowConnector } = require('./serviceNow');
const { createNautobotConnector } = require('./nautobot');
const { createWebhookConnector } = require('./webhook');

// The connector registry: type -> connector instance. New connectors (e.g.
// Netbox) are added here and become available to the CRUD validation, the trigger
// dispatcher and the test-fire endpoint with no other wiring. fetch is injected
// so the whole stack runs offline under test.
function createConnectorRegistry({ fetchImpl = globalThis.fetch, logger } = {}) {
  const list = [
    createServiceNowConnector({ fetchImpl, logger }),
    createNautobotConnector({ fetchImpl, logger }),
    createWebhookConnector({ fetchImpl, logger }),
  ];
  const byType = new Map(list.map((c) => [c.type, c]));

  return {
    types: () => [...byType.keys()],
    get: (type) => byType.get(type) || null,
    has: (type) => byType.has(type),
    // Events a connector reacts to: an integration's config.events override, else
    // the connector's defaults. Used by the dispatcher to route each event. The
    // dispatcher passes the raw DB row (config_json); accept the shaped `config`
    // form too.
    eventsFor: (integration, connector) => {
      const cfg = (integration && (integration.config_json || integration.config)) || null;
      const override = cfg && Array.isArray(cfg.events) ? cfg.events.filter((e) => typeof e === 'string') : null;
      return override && override.length ? override : (connector.defaultEvents || []);
    },
  };
}

module.exports = { createConnectorRegistry };
