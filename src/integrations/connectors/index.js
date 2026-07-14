'use strict';

const { createServiceNowConnector } = require('./serviceNow');
const { createNautobotConnector } = require('./nautobot');
const { createWebhookConnector } = require('./webhook');
const { createCustomItsmConnector } = require('./customItsm');

// Category hints for the Settings UI + the Test-area grouping: ServiceNow is
// ITSM ticketing, Nautobot is IPAM/CMDB (device inventory — NOT ITSM), the
// generic webhook and the config-driven custom connector are "any".
const CONNECTOR_CATEGORY = { servicenow: 'itsm', nautobot: 'cmdb', webhook: 'any', custom: 'any' };

// The connector registry: type -> connector instance. New connectors (e.g.
// Netbox) are added here and become available to the CRUD validation, the trigger
// dispatcher and the test-fire endpoint with no other wiring. fetch is injected
// so the whole stack runs offline under test.
function createConnectorRegistry({ fetchImpl = globalThis.fetch, logger } = {}) {
  const list = [
    createServiceNowConnector({ fetchImpl, logger }),
    createNautobotConnector({ fetchImpl, logger }),
    createWebhookConnector({ fetchImpl, logger }),
    createCustomItsmConnector({ fetchImpl, logger }),
  ];
  const byType = new Map(list.map((c) => [c.type, c]));

  return {
    types: () => [...byType.keys()],
    get: (type) => byType.get(type) || null,
    has: (type) => byType.has(type),
    // ITSM ticketing / CMDB-IPAM inventory / generic — drives the Settings UI copy.
    categoryOf: (type) => CONNECTOR_CATEGORY[type] || 'any',
    // Events a connector reacts to: an integration's config.events override, else
    // the connector's defaults. Used by the dispatcher to route each event. The
    // dispatcher passes the raw DB row (config_json); accept the shaped `config`
    // form too.
    eventsFor: (integration, connector) => {
      const cfg = (integration && (integration.config_json || integration.config)) || null;
      // A PRESENT array (even empty) is an explicit override: `events: []` means
      // "subscribe to nothing" (fire only on manual test). Only a missing/invalid
      // override falls back to the connector defaults.
      if (cfg && Array.isArray(cfg.events)) return cfg.events.filter((e) => typeof e === 'string');
      return connector.defaultEvents || [];
    },
  };
}

module.exports = { createConnectorRegistry, CONNECTOR_CATEGORY };
