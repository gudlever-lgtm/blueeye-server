'use strict';

// Named CMDB presets for the Settings → CMDB dropdown. Each preset either targets
// a built-in connector (servicenow / nautobot) with no config, or the config-driven
// `custom` connector pre-filled with sensible defaults for a known CMDB — so an
// admin can pick "NetBox" and get the right paths/field-maps instead of typing them
// by hand. Presets are STARTING POINTS: the admin still supplies the base URL and
// credentials, and can tweak every field before saving. `docsHint` flags systems
// whose native API needs adaptation.
//
// The `preset` id is stored in config_json (for custom-backed presets) so the
// dropdown can re-select the named template on reload.

const CMDB_PRESETS = [
  { id: 'servicenow', label: 'ServiceNow (CMDB)', type: 'servicenow', region: 'any', authType: 'basic', baseUrlPlaceholder: 'https://<instance>.service-now.com', config: {} },
  { id: 'nautobot', label: 'Nautobot (IPAM/DCIM)', type: 'nautobot', region: 'any', authType: 'token', baseUrlPlaceholder: 'https://nautobot.example.org', config: {} },
  {
    id: 'netbox', label: 'NetBox (IPAM/DCIM)', type: 'custom', region: 'any', authType: 'token',
    baseUrlPlaceholder: 'https://netbox.example.org',
    config: { preset: 'netbox', searchPath: '/api/dcim/devices/', queryParam: 'q', resultsPath: 'results', idField: 'id', nameField: 'name', typeField: 'device_type.display', locationField: 'location.display', tokenScheme: 'Token' },
  },
  {
    id: 'idoit', label: 'i-doit (DE)', type: 'custom', region: 'EU', authType: 'token',
    baseUrlPlaceholder: 'https://i-doit.example.org',
    docsHint: "i-doit's native API is JSON-RPC (POST). Point this at a REST wrapper that exposes a GET object search, or adjust the fields to match your gateway.",
    config: { preset: 'idoit', searchPath: '/search.php', queryParam: 'q', resultsPath: 'results', idField: 'documentId', nameField: 'title', typeField: 'type', locationField: 'location' },
  },
  {
    id: 'glpi', label: 'GLPI (FR)', type: 'custom', region: 'EU', authType: 'token',
    baseUrlPlaceholder: 'https://glpi.example.org',
    docsHint: "GLPI's REST API needs an App-Token header and a Session-Token; set App-Token below and use a long-lived session token, or front it with a proxy.",
    config: { preset: 'glpi', searchPath: '/apirest.php/search/Computer', queryParam: 'searchText', resultsPath: 'data', idField: '2', nameField: '1', tokenScheme: 'user_token', headers: { 'App-Token': '' } },
  },
  { id: 'custom', label: 'Custom (bring your own)', type: 'custom', region: 'any', authType: 'none', baseUrlPlaceholder: 'https://cmdb.example.org', config: { preset: 'custom' } },
];

module.exports = { CMDB_PRESETS };
