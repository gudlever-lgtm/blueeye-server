'use strict';

// External sources for the universal search — the resolvers that leave the
// building. Built as thunks, like makeCmdbSearch() in routes/cmdb.js: the search
// service receives a function it can call with a query, and never learns how
// credentials are stored or decrypted. A deployment with no ITSM/IPAM configured
// gets a thunk that answers [] immediately, so the resolver is a no-op rather
// than a disabled code path.
//
// Both thunks decrypt AT CALL TIME (never cache plaintext credentials) and fan
// out with Promise.allSettled across every enabled target of the right kind, so
// one unreachable ServiceNow cannot hide the tickets another one holds.

// Shapes an integrations-table row (with its encrypted blob) into what a
// connector consumes. Mirrors dispatcher.js `shape()`; a decrypt failure yields
// empty credentials so the target answers 401 and the source is reported as
// failed, never a throw that hides the other sources.
function shapeIntegration(row, secretBox, logger) {
  let credentials = {};
  try {
    credentials = secretBox.decryptJson(row.credentials_encrypted || '');
  } catch (err) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`search: could not decrypt credentials for integration #${row.id} (${err.message})`);
    }
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    authType: row.auth_type,
    credentials,
    config: row.config_json || {},
  };
}

// Runs one connector call per target; a target that throws or answers !ok is
// dropped and counted, the rest still contribute. Throws only when EVERY target
// failed — that is the signal the search service turns into `failedSources`.
async function fanOut(targets, call) {
  if (!targets.length) return [];
  const settled = await Promise.allSettled(targets.map(call));
  const results = [];
  let failures = 0;
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value && s.value.ok) results.push(...s.value.items);
    else failures += 1;
  }
  if (failures === targets.length) {
    const first = settled.find((s) => s.status === 'rejected');
    throw new Error(first ? first.reason && first.reason.message : 'every target failed');
  }
  return results;
}

// Tickets: every ENABLED integration whose connector can searchTickets (today:
// ServiceNow). Each ticket is tagged with the integration it came from, so two
// ServiceNow instances stay distinguishable in the result list.
function makeTicketSearch({ integrationsRepo, registry, secretBox, logger = null } = {}) {
  if (!integrationsRepo || !registry || !secretBox) return null;
  return async function ticketSearch(q) {
    const rows = (await integrationsRepo.findEnabledWithSecret()) || [];
    const targets = rows
      .map((row) => ({ row, connector: registry.get(row.type) }))
      .filter(({ connector }) => connector && typeof connector.searchTickets === 'function');
    return fanOut(targets, async ({ row, connector }) => {
      const integration = shapeIntegration(row, secretBox, logger);
      const res = await connector.searchTickets(integration, q);
      if (!res || !res.ok) return { ok: false };
      return {
        ok: true,
        items: (res.tickets || []).map((t) => ({
          ...t,
          integrationId: row.id,
          integrationName: row.name,
          source: row.type,
        })),
      };
    });
  };
}

// IPAM: Nautobot can be configured in TWO places — as the CMDB (singleton
// cmdb_config) and/or as an outbound integration row. Both are consulted, deduped
// on base URL so one Nautobot registered twice is asked once.
function makeIpamSearch({ cmdbConfigRepo = null, cmdbRegistry = null, integrationsRepo = null, registry = null, secretBox, logger = null } = {}) {
  if (!secretBox) return null;
  if (!(cmdbConfigRepo && cmdbRegistry) && !(integrationsRepo && registry)) return null;

  async function targets() {
    const out = [];
    const seen = new Set();
    const add = (row, connector, source) => {
      const key = String(row.base_url || '').replace(/\/+$/, '').toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ row, connector, source });
    };
    if (cmdbConfigRepo && cmdbRegistry) {
      const full = await cmdbConfigRepo.getWithSecret();
      if (full && full.enabled) {
        const connector = cmdbRegistry.get(full.type);
        if (connector && typeof connector.searchIpam === 'function') add({ ...full, id: full.id, name: 'CMDB' }, connector, full.type);
      }
    }
    if (integrationsRepo && registry) {
      const rows = (await integrationsRepo.findEnabledWithSecret()) || [];
      for (const row of rows) {
        const connector = registry.get(row.type);
        if (connector && typeof connector.searchIpam === 'function') add(row, connector, row.type);
      }
    }
    return out;
  }

  return async function ipamSearch(q) {
    return fanOut(await targets(), async ({ row, connector, source }) => {
      const integration = shapeIntegration(row, secretBox, logger);
      const res = await connector.searchIpam(integration, q);
      if (!res || !res.ok) return { ok: false };
      return {
        ok: true,
        items: (res.ipam || []).map((x) => ({ ...x, source, integrationName: row.name || null })),
      };
    });
  };
}

module.exports = { makeTicketSearch, makeIpamSearch, shapeIntegration };
