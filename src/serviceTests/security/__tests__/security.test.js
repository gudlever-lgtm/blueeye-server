'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHostPolicy, validateEntry, parseEntry, denyReason, explainReason, REASON } = require('../hostPolicy');
const { validateImport, toCsvExport, parseLines } = require('../allowlistIo');

const DEFAULTS = { minCidrPrefix: 16, maxAddressesPerApplication: 65536 };
const resolveTo = (addresses) => async () => addresses;

// ---------------------------------------------------------------- deny-list
test('loopback, link-local, metadata and localhost are refused as literals', () => {
  for (const host of ['127.0.0.1', '127.255.255.254', '169.254.169.254', 'localhost', 'app.localhost', '0.0.0.0', '::1']) {
    assert.equal(denyReason(host), REASON.DENIED_ADDRESS, host);
  }
  assert.equal(denyReason('93.184.216.34'), null);
  assert.equal(denyReason('portal.kunde.dk'), null, 'a hostname is judged after resolution, not here');
});

test('nothing can put loopback or metadata on an allowlist, however wide the caps are opened', () => {
  const wideOpen = { minCidrPrefix: 8, maxAddressesPerApplication: 16777216 };
  for (const entry of ['127.0.0.1', '127.0.0.0/8', '127.0.0.0/24', 'localhost', '169.254.169.254', '169.254.0.0/16', '0.0.0.0/8']) {
    assert.ok(validateEntry(entry, null, { settings: wideOpen }).errors, `${entry} must never be allowlistable`);
  }
});

test('a range that merely OVERLAPS the deny-list is refused, not silently punctured', () => {
  // 127.0.0.0/6 covers 124.0.0.0-127.255.255.255 — it swallows loopback.
  const wideOpen = { minCidrPrefix: 8, maxAddressesPerApplication: 16777216 };
  assert.ok(validateEntry('124.0.0.0/6', null, { settings: wideOpen }).errors);
});

// ---------------------------------------------------------------- allowlist
test('RFC1918 IS allowlistable — that is the point of the feature', () => {
  for (const entry of ['10.20.0.0/16', '192.168.1.0/24', '172.16.5.0/24', '10.20.30.40']) {
    const { value, errors } = validateEntry(entry, null, { settings: DEFAULTS });
    assert.equal(errors, undefined, `${entry}: ${JSON.stringify(errors)}`);
    assert.ok(['cidr', 'ip'].includes(value.entry_type));
  }
});

test('a range wider than the configured floor is refused with the numbers, not a generic error', () => {
  const { errors } = validateEntry('10.0.0.0/8', null, { settings: DEFAULTS });
  assert.match(errors.value, /16,777,216 addresses/);
  assert.match(errors.value, /\/16/);
});

test('the address cap counts the whole application, so many small ranges cannot beat it', () => {
  const existing = [
    { entry_type: 'cidr', value: '10.1.0.0/17' },
    { entry_type: 'cidr', value: '10.2.0.0/17' },
  ]; // 32768 + 32768 = the cap exactly
  const { errors } = validateEntry('10.3.0.0/24', null, { settings: DEFAULTS, existing });
  assert.ok(errors, 'one more address past the cap must be refused');
  assert.match(errors.value, /the limit is 65,536/);
});

test('re-validating an entry that already exists does not double-count it', () => {
  const existing = [{ entry_type: 'cidr', value: '10.20.0.0/16' }];
  assert.equal(validateEntry('10.20.0.0/16', null, { settings: DEFAULTS, existing }).errors, undefined);
});

test('entry types are inferred, and nonsense is refused', () => {
  assert.equal(parseEntry('10.20.0.0/16').entry_type, 'cidr');
  assert.equal(parseEntry('10.20.30.40').entry_type, 'ip');
  assert.equal(parseEntry('portal.kunde.dk').entry_type, 'host');
  for (const bad of ['', '   ', '10.20.0.0/33', '999.1.1.1', 'not a host!', 'x'.repeat(300)]) {
    assert.ok(parseEntry(bad).error, bad);
  }
});

// ---------------------------------------------------------------- the policy
test('an application reaches its own hosts and nothing else', async () => {
  const policy = createHostPolicy({
    baseUrls: ['https://customer.example.com', 'https://staging.customer.example.com'],
    entries: [],
    resolve: resolveTo(['93.184.216.34']),
  });
  assert.equal((await policy.check('https://customer.example.com/login')).allowed, true);
  assert.equal((await policy.check('https://staging.customer.example.com/')).allowed, true);

  const other = await policy.check('https://evil.example.net/');
  assert.equal(other.allowed, false);
  assert.equal(other.reason, REASON.NOT_ALLOWLISTED);
});

test('only http and https reach the browser', async () => {
  const policy = createHostPolicy({ baseUrls: ['https://app.test'], resolve: resolveTo(['93.184.216.34']) });
  for (const url of ['file:///etc/passwd', 'ftp://app.test/x', 'data:text/html,<h1>x', 'ws://app.test/socket']) {
    const verdict = await policy.check(url);
    assert.equal(verdict.allowed, false, url);
    assert.equal(verdict.reason, REASON.SCHEME, url);
  }
});

// The gap a literal-only guard leaves open.
test('an allowlisted hostname that resolves to a blocked address is still refused', async () => {
  const policy = createHostPolicy({
    baseUrls: ['https://rebind.example.com'],
    resolve: resolveTo(['169.254.169.254']),
  });
  const verdict = await policy.check('https://rebind.example.com/');
  assert.equal(verdict.allowed, false, 'DNS rebinding must not get past the policy');
  assert.equal(verdict.reason, REASON.RESOLVED_DENIED);
  assert.match(verdict.detail, /169\.254\.169\.254/);
});

test('every resolved address is checked, not just the first', async () => {
  const policy = createHostPolicy({
    baseUrls: ['https://multi.example.com'],
    resolve: resolveTo(['93.184.216.34', '127.0.0.1']),
  });
  assert.equal((await policy.check('https://multi.example.com/')).allowed, false);
});

test('a host that will not resolve is refused rather than attempted', async () => {
  const policy = createHostPolicy({
    baseUrls: ['https://gone.example.com'],
    resolve: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.equal((await policy.check('https://gone.example.com/')).reason, REASON.RESOLVE_FAILED);
});

test('an allowlisted range admits an address inside it and refuses one outside', async () => {
  const policy = createHostPolicy({
    baseUrls: ['https://app.test'],
    entries: [{ entry_type: 'cidr', value: '10.20.0.0/16' }],
    resolve: resolveTo(['93.184.216.34']),
  });
  assert.equal((await policy.check('http://10.20.30.40/app')).allowed, true);
  assert.equal((await policy.check('http://10.21.30.40/app')).allowed, false);
});

test('the synchronous request-time check is never more permissive than the full one', async () => {
  const policy = createHostPolicy({
    baseUrls: ['https://app.test'],
    entries: [{ entry_type: 'cidr', value: '10.20.0.0/16' }],
    resolve: resolveTo(['93.184.216.34']),
  });
  const urls = [
    'https://app.test/x', 'http://10.20.30.40/', 'http://10.21.0.1/',
    'http://127.0.0.1/', 'file:///etc/passwd', 'https://evil.example.net/', 'not a url',
  ];
  for (const url of urls) {
    const sync = policy.checkSync(url);
    const full = await policy.check(url);
    if (sync.allowed) assert.ok(full.allowed || full.reason === REASON.RESOLVED_DENIED, `${url}: sync allowed what the full check refused`);
  }
});

test('refusals explain themselves in words an operator can act on', () => {
  assert.match(explainReason(REASON.NOT_ALLOWLISTED, 'evil.example.net'), /not on this application's allowed list/);
  assert.match(explainReason(REASON.DENIED_ADDRESS, '127.0.0.1'), /permanently blocked/);
  assert.match(explainReason(REASON.SCHEME, 'file'), /http and https/);
});

// ---------------------------------------------------------------- import/export
test('import accepts a bare list, a CSV, comments and a header row', () => {
  const text = [
    'type,value,note',
    'host,portal.kunde.dk,Frontend',
    '# a comment',
    '',
    '10.20.0.0/24',
    '"cidr","10.21.0.0/24","Med komma, her"',
  ].join('\n');
  const { value, errors } = validateImport(text, { settings: DEFAULTS });
  assert.equal(errors, undefined, JSON.stringify(errors));
  assert.equal(value.entries.length, 3);
  assert.equal(value.entries[2].note, 'Med komma, her');
});

test('one bad row rejects the whole import and names the line', () => {
  const { errors } = validateImport('portal.kunde.dk\n127.0.0.1\nok.kunde.dk', { settings: DEFAULTS });
  assert.ok(errors['line 2']);
  assert.ok(!errors['line 1'], 'the good rows are not blamed');
  assert.ok(!errors['line 3']);
});

test('the cap applies to the whole file, not row by row', () => {
  const text = Array.from({ length: 4 }, (_, i) => `10.${i}.0.0/16`).join('\n');
  const { errors } = validateImport(text, { settings: DEFAULTS });
  assert.ok(errors, '4 × /16 is 262 144 addresses, far past the cap');
});

test('a duplicate inside the file is collapsed rather than treated as an error', () => {
  const { value, errors } = validateImport('portal.kunde.dk\nportal.kunde.dk', { settings: DEFAULTS });
  assert.equal(errors, undefined);
  assert.equal(value.entries.length, 1);
});

test('import is bounded in both entries and bytes', () => {
  const tooMany = Array.from({ length: 1001 }, (_, i) => `host-${i}.kunde.dk`).join('\n');
  assert.ok(validateImport(tooMany, { settings: DEFAULTS }).errors.file);
  assert.ok(validateImport('x'.repeat(1024 * 1024 + 1), { settings: DEFAULTS }).errors.file);
  assert.ok(validateImport('', { settings: DEFAULTS }).errors.file);
  assert.ok(validateImport(null, { settings: DEFAULTS }).errors.file);
});

test('the export neutralises a formula so an opened CSV cannot execute it', () => {
  const csv = toCsvExport([{ entry_type: 'host', value: 'a.dk', note: '=cmd|/c calc' }]);
  assert.match(csv, /^type,value,note/);
  assert.ok(csv.includes("'=cmd"), 'a leading = must be neutralised');
});

test('parseLines survives garbage without throwing', () => {
  for (const input of [undefined, null, 42, '', '\n\n\n', '"unclosed']) {
    assert.doesNotThrow(() => parseLines(input));
  }
});
