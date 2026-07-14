'use strict';

// Named ITSM/receiver presets for the Settings → ITSM dropdown. Each preset either
// targets a built-in connector (servicenow / nautobot / webhook) with no config, or
// the config-driven `custom` connector pre-filled with sensible defaults for a
// known ticketing system — so an admin can pick "Jira Service Management" and get a
// working body shape instead of hand-building the field map. Presets are STARTING
// POINTS: the admin still supplies the base URL, credentials and any project/queue
// keys, and can tweak every field before saving. `category` tags each entry as ITSM
// ticketing vs CMDB/IPAM inventory (Nautobot) vs generic. `docsHint` flags systems
// whose native API needs adaptation.
//
// The `preset` id round-trips in config_json (surviving the connector's config
// normalisation) so the dropdown can re-select the named template on reload.

const ITSM_PRESETS = [
  { id: 'servicenow', label: 'ServiceNow (ITSM incident)', category: 'itsm', type: 'servicenow', region: 'any', authType: 'basic', baseUrlPlaceholder: 'https://<instance>.service-now.com', config: {} },
  { id: 'nautobot', label: 'Nautobot (CMDB/IPAM device sync)', category: 'cmdb', type: 'nautobot', region: 'any', authType: 'token', baseUrlPlaceholder: 'https://nautobot.example.org', config: {} },
  { id: 'webhook', label: 'Webhook (generic JSON POST)', category: 'any', type: 'webhook', region: 'any', authType: 'none', baseUrlPlaceholder: 'https://receiver.example.org/blueeye', config: {} },
  {
    id: 'jira', label: 'Jira Service Management', category: 'itsm', type: 'custom', region: 'any', authType: 'basic',
    baseUrlPlaceholder: 'https://<org>.atlassian.net',
    docsHint: 'Basic auth = your Atlassian account email + an API token. Set the project key and issue type below to match your JSM project.',
    config: {
      preset: 'jira', path: '/rest/api/2/issue', method: 'POST',
      fields: { 'fields.summary': 'title', 'fields.description': 'explanation' },
      staticFields: { fields: { project: { key: 'OPS' }, issuetype: { name: 'Incident' } } },
    },
  },
  {
    id: 'topdesk', label: 'TOPdesk (NL)', category: 'itsm', type: 'custom', region: 'EU', authType: 'basic',
    baseUrlPlaceholder: 'https://<org>.topdesk.net',
    docsHint: 'Use a TOPdesk application password for basic auth. Add caller/category static fields as your instance requires.',
    config: {
      preset: 'topdesk', path: '/tas/api/incidents', method: 'POST',
      fields: { briefDescription: 'title', request: 'explanation' },
    },
  },
  {
    id: 'glpi', label: 'GLPI (FR)', category: 'itsm', type: 'custom', region: 'EU', authType: 'token',
    baseUrlPlaceholder: 'https://glpi.example.org',
    docsHint: "GLPI needs an App-Token header and a Session-Token. Set App-Token below and a long-lived user_token, or front the API with a proxy that manages the session.",
    config: {
      preset: 'glpi', path: '/apirest.php/Ticket', method: 'POST', tokenScheme: 'user_token',
      fields: { 'input.name': 'title', 'input.content': 'explanation' },
      headers: { 'App-Token': '' },
    },
  },
  { id: 'custom', label: 'Custom (bring your own)', category: 'any', type: 'custom', region: 'any', authType: 'none', baseUrlPlaceholder: 'https://itsm.example.org/api', config: { preset: 'custom' } },
];

module.exports = { ITSM_PRESETS };
