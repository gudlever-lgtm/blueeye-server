'use strict';

// The monitor catalogue — every non-browser check Service Assurance can run,
// declared once.
//
// A MONITOR asks one question on an interval: did the mail arrive, is DMARC
// still published, can anyone bind to the directory, is that clock right. The
// browser tests answer "can a user do X"; these answer the questions that fail
// silently underneath them.
//
// Same shape as engine/dsl.js, and for the same reason: the validator, the API's
// `GET /monitors/types`, the UI form and the checker registry are all derived
// from this table, so adding a check type is one entry plus one checker file
// rather than five edits in five places.
//
// Every entry declares:
//   label        what a human calls it
//   category     how the UI groups it
//   target       which config field is THE address (denormalised onto the row so
//                a list and an incident can name it without parsing JSON)
//   fields       the config fields, bounded — { type, required, max, min, values }
//   secrets      config fields that are WRITE-ONLY and stored encrypted
//   measures     { unit, label } when the check produces a number worth charting
//   layer        which observation layer the result belongs to
//   kind         the observation kind the result is stored as
//   hostFields   config fields holding a host that must clear the deny-list
//
// Field types: text | host | domain | email | int | boolean | enum | list | secret

const FIELD_TYPES = ['text', 'host', 'domain', 'email', 'int', 'boolean', 'enum', 'list', 'secret'];

const CATEGORIES = ['mail', 'dns', 'directory', 'data', 'infrastructure'];

// The verdict vocabulary every checker shares. Stored in
// service_monitor_results.status — see migration 094 for what each means.
const STATUS = {
  OK: 'ok',
  SLOW: 'slow',
  FAILED: 'failed',
  UNREACHABLE: 'unreachable',
  MISCONFIGURED: 'misconfigured',
  UNKNOWN: 'unknown',
};

// The finer-grained reason an incident carries. `status` is what a list shows;
// `kind` is what policy.js decides a severity from.
const KIND = {
  MAIL_REJECTED: 'mail_rejected',
  MAIL_UNDELIVERED: 'mail_undelivered',
  MAIL_SLOW: 'mail_slow',
  MAIL_AUTH_FAILED: 'mail_auth_failed',
  DNS_RECORD_MISSING: 'dns_record_missing',
  DNS_RECORD_MISMATCH: 'dns_record_mismatch',
  DNS_UNEXPECTED_RECORD: 'dns_unexpected_record',
  RBL_LISTED: 'rbl_listed',
  LDAP_BIND_FAILED: 'ldap_bind_failed',
  LDAP_SEARCH_EMPTY: 'ldap_search_empty',
  NTP_OFFSET_HIGH: 'ntp_offset_high',
  TLS_EXPIRING: 'tls_expiring',
  TLS_EXPIRED: 'tls_expired',
  TLS_INVALID: 'tls_invalid',
  TCP_REFUSED: 'tcp_refused',
  TCP_BANNER_MISMATCH: 'tcp_banner_mismatch',
  DB_QUERY_FAILED: 'db_query_failed',
  SLOW: 'monitor_slow',
  UNREACHABLE: 'monitor_unreachable',
  MISCONFIGURED: 'monitor_misconfigured',
};

// Convenience DNS presets. The operator picks "DMARC for kunde.dk" and the
// preset fills in the name, the record type and what must be in the answer —
// because remembering that DMARC is a TXT record at `_dmarc.<domain>` starting
// `v=DMARC1` is exactly the knowledge a no-code module exists to not require.
const DNS_PRESETS = {
  spf: { record: 'TXT', name: (c) => c.domain, contains: 'v=spf1' },
  dmarc: { record: 'TXT', name: (c) => `_dmarc.${c.domain}`, contains: 'v=DMARC1' },
  dkim: { record: 'TXT', name: (c) => `${c.selector}._domainkey.${c.domain}`, contains: 'v=DKIM1' },
  mx: { record: 'MX', name: (c) => c.domain, contains: null },
  a: { record: 'A', name: (c) => c.domain, contains: null },
  ns: { record: 'NS', name: (c) => c.domain, contains: null },
  custom: { record: null, name: (c) => c.name || c.domain, contains: null },
};

const DNS_RECORDS = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'SRV'];

const TYPES = {
  // ------------------------------------------------------------------ mail
  mail: {
    label: 'Mail delivery',
    category: 'mail',
    target: 'smtp_host',
    layer: 'application',
    kind: 'mail.delivery',
    measures: { unit: 'ms', label: 'Delivery time' },
    defaultIntervalSec: 900,
    hostFields: ['smtp_host', 'imap_host'],
    secrets: ['smtp_password', 'imap_password'],
    fields: {
      smtp_host: { type: 'host', required: true, max: 255 },
      smtp_port: { type: 'int', min: 1, max: 65535, default: 587 },
      // How TLS is reached: starttls upgrades a plain connection (587), tls
      // connects encrypted from the first byte (465), none is plaintext and is
      // refused unless the operator explicitly asks for it.
      smtp_security: { type: 'enum', values: ['starttls', 'tls', 'none'], default: 'starttls' },
      smtp_username: { type: 'text', max: 255 },
      smtp_password: { type: 'secret', max: 512 },
      from_address: { type: 'email', required: true, max: 255 },
      to_address: { type: 'email', required: true, max: 255 },
      subject_prefix: { type: 'text', max: 120, default: 'BlueEyes assurance probe' },
      // Round-trip half. Without it the monitor measures ACCEPTANCE only, which
      // is a real but weaker answer: a queue that silently drops mail accepts it
      // first. With it, the check reads the mailbox back and measures delivery.
      roundtrip: { type: 'boolean', default: false },
      imap_host: { type: 'host', max: 255 },
      imap_port: { type: 'int', min: 1, max: 65535, default: 993 },
      imap_username: { type: 'text', max: 255 },
      imap_password: { type: 'secret', max: 512 },
      imap_mailbox: { type: 'text', max: 255, default: 'INBOX' },
      // How long to keep looking before calling it undelivered.
      deadline_sec: { type: 'int', min: 10, max: 1800, default: 300 },
      // Delete the probe message once it has been seen. Default on: a mailbox
      // that collects one message every 15 minutes forever is a fault we caused.
      cleanup: { type: 'boolean', default: true },
    },
  },

  // ------------------------------------------------------------------- dns
  dns_record: {
    label: 'DNS record',
    category: 'dns',
    target: 'domain',
    layer: 'network',
    kind: 'dns.record',
    measures: { unit: 'ms', label: 'Lookup time' },
    defaultIntervalSec: 3600,
    hostFields: ['resolver'],
    secrets: [],
    fields: {
      domain: { type: 'domain', required: true, max: 255 },
      preset: { type: 'enum', values: Object.keys(DNS_PRESETS), default: 'spf' },
      // Only for preset=dkim.
      selector: { type: 'text', max: 120 },
      // Only for preset=custom.
      name: { type: 'domain', max: 255 },
      record: { type: 'enum', values: DNS_RECORDS },
      // The answer must contain this string. For SPF/DMARC/DKIM the preset
      // supplies one; an operator can pin more ("include:mailgun.org").
      expect_contains: { type: 'text', max: 255 },
      // …or must NOT contain it. "p=none" on a DMARC record is a policy that
      // publishes and enforces nothing, and an operator who moved to p=quarantine
      // wants to know if it moves back.
      expect_absent: { type: 'text', max: 255 },
      min_answers: { type: 'int', min: 1, max: 100, default: 1 },
      // Ask a specific resolver rather than the server's own. The authoritative
      // answer and what the internet sees can differ during a propagation, and
      // "which one am I asking" must not be a guess.
      resolver: { type: 'host', max: 255 },
    },
  },

  rbl: {
    label: 'Blacklist (RBL)',
    category: 'mail',
    target: 'ip',
    layer: 'infrastructure',
    kind: 'mail.rbl',
    measures: { unit: 'count', label: 'Lists' },
    defaultIntervalSec: 3600,
    hostFields: [],
    secrets: [],
    fields: {
      // The sending address to look up. Deliberately an IP: an RBL is indexed by
      // address, and resolving a hostname here would silently check whatever it
      // pointed at today.
      ip: { type: 'host', required: true, max: 45 },
      lists: { type: 'list', max: 20, default: ['zen.spamhaus.org', 'bl.spamcop.net'] },
    },
  },

  // -------------------------------------------------------------- directory
  ldap_bind: {
    label: 'Directory bind (LDAP)',
    category: 'directory',
    target: 'url',
    layer: 'application',
    kind: 'ldap.bind',
    measures: { unit: 'ms', label: 'Bind time' },
    defaultIntervalSec: 900,
    hostFields: ['url'],
    secrets: ['bind_password'],
    fields: {
      url: { type: 'text', required: true, max: 255 },
      bind_dn: { type: 'text', required: true, max: 512 },
      bind_password: { type: 'secret', max: 512 },
      // Optional second half: bind proved the credentials work, a search proves
      // the directory still answers questions about them.
      base_dn: { type: 'text', max: 512 },
      filter: { type: 'text', max: 512, default: '(objectClass=*)' },
      tls_reject_unauthorized: { type: 'boolean', default: true },
      timeout_ms: { type: 'int', min: 1000, max: 60000, default: 10000 },
    },
  },

  // ------------------------------------------------------------------- data
  db_connect: {
    label: 'Database connection',
    category: 'data',
    target: 'host',
    layer: 'server',
    kind: 'db.query',
    measures: { unit: 'ms', label: 'Query time' },
    defaultIntervalSec: 300,
    hostFields: ['host'],
    secrets: ['password'],
    fields: {
      engine: { type: 'enum', values: ['mysql', 'postgres'], default: 'mysql', required: true },
      host: { type: 'host', required: true, max: 255 },
      port: { type: 'int', min: 1, max: 65535 },
      database: { type: 'text', max: 128 },
      username: { type: 'text', max: 128 },
      password: { type: 'secret', max: 512 },
      // Read-only by contract: the validator refuses anything but a SELECT, so a
      // monitor can never become a scheduled write against a customer database.
      query: { type: 'text', max: 512, default: 'SELECT 1' },
      timeout_ms: { type: 'int', min: 1000, max: 60000, default: 10000 },
    },
  },

  // --------------------------------------------------------- infrastructure
  ntp_offset: {
    label: 'Clock offset (NTP)',
    category: 'infrastructure',
    target: 'host',
    layer: 'infrastructure',
    kind: 'ntp.offset',
    measures: { unit: 'ms', label: 'Offset' },
    defaultIntervalSec: 3600,
    hostFields: ['host'],
    secrets: [],
    fields: {
      host: { type: 'host', required: true, max: 255 },
      port: { type: 'int', min: 1, max: 65535, default: 123 },
      timeout_ms: { type: 'int', min: 1000, max: 30000, default: 5000 },
    },
  },

  tls_port: {
    label: 'Certificate on a port',
    category: 'infrastructure',
    target: 'host',
    layer: 'infrastructure',
    kind: 'infrastructure.tls',
    measures: { unit: 'days', label: 'Days remaining' },
    defaultIntervalSec: 21600,
    hostFields: ['host'],
    secrets: [],
    fields: {
      // The certificate watcher covers an application's https address. This
      // covers everything else with a certificate on it: submission on 465,
      // IMAPS on 993, LDAPS on 636, RDP on 3389.
      host: { type: 'host', required: true, max: 255 },
      port: { type: 'int', min: 1, max: 65535, default: 993, required: true },
      warn_days: { type: 'int', min: 0, max: 365, default: 30 },
      critical_days: { type: 'int', min: 0, max: 365, default: 7 },
      timeout_ms: { type: 'int', min: 1000, max: 60000, default: 10000 },
    },
  },

  tcp_port: {
    label: 'TCP port',
    category: 'infrastructure',
    target: 'host',
    layer: 'network',
    kind: 'network.tcp',
    measures: { unit: 'ms', label: 'Connect time' },
    defaultIntervalSec: 300,
    hostFields: ['host'],
    secrets: [],
    fields: {
      host: { type: 'host', required: true, max: 255 },
      port: { type: 'int', min: 1, max: 65535, required: true },
      // Read the greeting and check it. A port that accepts a connection and
      // then says nothing useful is open without being up.
      expect_banner: { type: 'text', max: 255 },
      timeout_ms: { type: 'int', min: 1000, max: 60000, default: 10000 },
    },
  },
};

const TYPE_NAMES = Object.keys(TYPES);
const isType = (t) => Object.prototype.hasOwnProperty.call(TYPES, t);
const typeMeta = (t) => (isType(t) ? TYPES[t] : null);

// Defaults for one type's config — what the form opens with, and what a stored
// config is merged onto so a field added later has a value for existing rows.
function defaultsFor(type) {
  const meta = typeMeta(type);
  if (!meta) return {};
  const out = {};
  for (const [name, field] of Object.entries(meta.fields)) {
    if (field.default !== undefined) out[name] = Array.isArray(field.default) ? [...field.default] : field.default;
  }
  return out;
}

// The secret field names for a type — the ones that are write-only in the API
// and encrypted at rest.
const secretFields = (type) => (typeMeta(type) ? [...typeMeta(type).secrets] : []);

// The config fields naming a host that must clear the permanent deny-list.
const hostFields = (type) => (typeMeta(type) ? [...(typeMeta(type).hostFields || [])] : []);

// The catalogue as the UI needs it: JSON-safe, no functions, secrets marked.
function catalogue() {
  return TYPE_NAMES.map((name) => {
    const meta = TYPES[name];
    return {
      type: name,
      label: meta.label,
      category: meta.category,
      target: meta.target,
      default_interval_sec: meta.defaultIntervalSec,
      measures: meta.measures || null,
      secrets: [...meta.secrets],
      fields: Object.entries(meta.fields).map(([field, spec]) => ({
        field,
        type: spec.type,
        required: !!spec.required,
        min: spec.min ?? null,
        max: spec.max ?? null,
        values: spec.values || null,
        default: spec.default ?? null,
      })),
    };
  });
}

module.exports = {
  TYPES, TYPE_NAMES, CATEGORIES, FIELD_TYPES, STATUS, KIND,
  DNS_PRESETS, DNS_RECORDS,
  isType, typeMeta, defaultsFor, secretFields, hostFields, catalogue,
};
