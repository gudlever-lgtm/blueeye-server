'use strict';

// scripts/install-server.sh — the .env it writes for a customer host.
//
// The one thing that must never regress here is the separation from
// scripts/dev-bootstrap.js: that one writes the vendor's PRIVATE signing key,
// a demo licence and demo seeds, and it exists for a disposable local stack.
// The installer runs on a CUSTOMER host, where none of those may appear. The
// script is exercised in --dry-run, which stops before docker.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'install-server.sh');

// Runs the installer in dry-run against a throwaway .env and returns its text.
// Answers come from the env overrides, so nothing ever waits on a prompt.
function install(answers = {}, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-install-'));
  const envPath = path.join(dir, '.env');
  const stdout = execFileSync('bash', [SCRIPT, '--non-interactive', '--dry-run', '--env-file', envPath, ...args], {
    env: { ...process.env, BLUEEYE_LICENSE_KEY: 'CUST-0001-ABCD-EFGH', ...answers },
    encoding: 'utf8',
  });
  return { stdout, envPath, dir, text: fs.readFileSync(envPath, 'utf8') };
}

// Reads a KEY=value out of the generated file, unwrapping the single quotes the
// script writes so a password with a space in it survives compose.
function envValue(text, key) {
  const line = text.split('\n').find((l) => l.startsWith(`${key}=`));
  if (!line) return undefined;
  const raw = line.slice(key.length + 1);
  return raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replace(/'\\''/g, "'") : raw;
}

test('writes a customer .env with generated secrets', () => {
  const { text } = install();

  assert.equal(envValue(text, 'LICENSE_KEY'), 'CUST-0001-ABCD-EFGH');
  assert.equal(envValue(text, 'DB_USER'), 'blueeye');
  // Generated, not defaulted: a shared password across installs is one leak.
  assert.ok((envValue(text, 'DB_PASSWORD') || '').length >= 16);
  assert.ok((envValue(text, 'MYSQL_ROOT_PASSWORD') || '').length >= 16);
  assert.ok((envValue(text, 'SERVER_JWT_SECRET') || '').length >= 32);
  assert.notEqual(envValue(text, 'DB_PASSWORD'), envValue(text, 'MYSQL_ROOT_PASSWORD'));
});

test('two runs never produce the same secrets', () => {
  const a = install();
  const b = install();
  assert.notEqual(envValue(a.text, 'SERVER_JWT_SECRET'), envValue(b.text, 'SERVER_JWT_SECRET'));
  assert.notEqual(envValue(a.text, 'DB_PASSWORD'), envValue(b.text, 'DB_PASSWORD'));
});

test('never writes vendor-only or demo settings', () => {
  const { text } = install();

  // The private signing key lives ONLY on blueeye-licens.
  assert.ok(!/^LICENSE_SIGNING_KEY=/m.test(text));
  // The trust anchor is the key embedded in src/license/publicKey.js; an env
  // override on a customer box would let the operator self-sign a licence.
  assert.ok(!/^LICENSE_PUBLIC_KEY=/m.test(text));
  assert.ok(!/^TRUST_ANCHOR_OVERRIDE_ACK=/m.test(text));
  // No demo customer, no DEMO-… licence, no fixed enrollment code.
  assert.equal(envValue(text, 'SEED_DEMO'), '0');
  assert.ok(!/DEMO-/.test(text));
  // The server derives a stable host id and licens binds it on first validation.
  assert.ok(!/^LICENSE_SERVER_ID=/m.test(text));
});

test('the file is not world-readable', () => {
  const { envPath } = install();
  assert.equal(fs.statSync(envPath).mode & 0o077, 0);
});

test('an https public URL turns on TRUST_PROXY, plain http does not', () => {
  const secure = install({ BLUEEYE_PUBLIC_URL: 'https://blueeye.kunde.dk' });
  assert.equal(envValue(secure.text, 'BLUEEYE_PUBLIC_URL'), 'https://blueeye.kunde.dk');
  assert.equal(envValue(secure.text, 'TRUST_PROXY'), '1');

  const plain = install({ BLUEEYE_PUBLIC_URL: 'http://10.0.0.5:3000' });
  assert.equal(envValue(plain.text, 'TRUST_PROXY'), '');

  // An explicit answer still wins over the guess.
  const forced = install({ BLUEEYE_PUBLIC_URL: 'https://blueeye.kunde.dk', BLUEEYE_TRUST_PROXY: '0' });
  assert.equal(envValue(forced.text, 'TRUST_PROXY'), '');
});

test('the licence server URL is omitted unless given (defaults to the vendor)', () => {
  assert.equal(envValue(install().text, 'LICENSE_SERVER_URL'), undefined);

  const pointed = install({ BLUEEYE_LICENSE_SERVER_URL: 'https://licens.gnf.dk' });
  assert.equal(envValue(pointed.text, 'LICENSE_SERVER_URL'), 'https://licens.gnf.dk');
});

test('the update button is wired to deploy.sh, and can be declined', () => {
  const on = install();
  assert.ok((envValue(on.text, 'SERVER_UPDATE_COMMAND') || '').endsWith('/scripts/deploy.sh'));

  const off = install({ BLUEEYE_UPDATE_BUTTON: '0' });
  assert.equal(envValue(off.text, 'SERVER_UPDATE_COMMAND'), undefined);
});

test('a password with shell metacharacters survives quoting', () => {
  const password = "pa ss'w$ord`x";
  const { text } = install({ BLUEEYE_ADMIN_PASSWORD: password });
  assert.equal(envValue(text, 'ADMIN_PASSWORD'), password);
});

test('ports are validated', () => {
  assert.equal(envValue(install({ BLUEEYE_SERVER_PORT: '8080' }).text, 'SERVER_HOST_PORT'), '8080');
  assert.throws(() => install({ BLUEEYE_SERVER_PORT: 'eighty' }), /whole numbers/);
  assert.throws(() => install({ BLUEEYE_DB_PORT: '70000' }), /out of range/);
});

test('a missing licence key stops the install rather than writing a broken .env', () => {
  assert.throws(() => install({ BLUEEYE_LICENSE_KEY: '' }), /licence key is required/);
});

test('a URL without a scheme is rejected', () => {
  assert.throws(() => install({ BLUEEYE_PUBLIC_URL: 'blueeye.kunde.dk' }), /http:\/\/ or https:\/\//);
});

test('an existing .env is never silently overwritten', () => {
  const { envPath, text } = install();
  const args = ['--non-interactive', '--dry-run', '--env-file', envPath];
  const env = { ...process.env, BLUEEYE_LICENSE_KEY: 'CUST-0002' };

  assert.throws(() => execFileSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' }), /already exists/);
  assert.equal(fs.readFileSync(envPath, 'utf8'), text, 'the original .env is untouched');

  // --force overwrites, but keeps a backup of what was there.
  execFileSync('bash', [SCRIPT, ...args, '--force'], { env, encoding: 'utf8' });
  assert.equal(envValue(fs.readFileSync(envPath, 'utf8'), 'LICENSE_KEY'), 'CUST-0002');
  const backups = fs.readdirSync(path.dirname(envPath)).filter((f) => f.startsWith('.env.bak.'));
  assert.equal(backups.length, 1);
  assert.equal(envValue(fs.readFileSync(path.join(path.dirname(envPath), backups[0]), 'utf8'), 'LICENSE_KEY'), 'CUST-0001-ABCD-EFGH');
});
