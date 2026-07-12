'use strict';

const { createServiceNowConnector } = require('../integrations/connectors/serviceNow');
const { createNautobotConnector } = require('../integrations/connectors/nautobot');
const { createCustomCmdbConnector } = require('../integrations/connectors/customCmdb');

// The CMDB connector registry — DISTINCT from the integrations connector registry
// (src/integrations/connectors). CMDB connectors implement a read contract
// (testConnection + search) rather than the integrations' write contract
// (send + events), so keeping them separate means adding a "custom" CMDB doesn't
// leak a half-built connector into the outbound-integrations CRUD/dispatcher.
//
// ServiceNow/Nautobot reuse the same factory functions the integrations feature
// uses (they already grew testConnection/search); `custom` is fully config-driven.
function createCmdbConnectorRegistry({ fetchImpl = globalThis.fetch, logger } = {}) {
  const list = [
    createServiceNowConnector({ fetchImpl, logger }),
    createNautobotConnector({ fetchImpl, logger }),
    createCustomCmdbConnector({ fetchImpl, logger }),
  ];
  const byType = new Map(list.map((c) => [c.type, c]));
  return {
    types: () => [...byType.keys()],
    get: (type) => byType.get(type) || null,
    has: (type) => byType.has(type),
    // Meta for the Settings UI: type + supported auth types + whether it needs the
    // free-form `config` block (only `custom` does).
    meta: () => list.map((c) => ({ type: c.type, authTypes: c.authTypes || [], custom: c.type === 'custom' })),
  };
}

module.exports = { createCmdbConnectorRegistry };
