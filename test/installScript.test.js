'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { renderInstallScript } = require('../src/enroll/installScript');

const CHECKSUMS = {
  'linux-amd64': 'a'.repeat(64),
  'windows-amd64': 'b'.repeat(64),
};

test('renderInstallScript embeds server URL, code, fingerprint and checksums', () => {
  const script = renderInstallScript({
    serverUrl: 'https://blueeye.example.dk',
    code: 'CODE-123_abc',
    certFingerprint: 'ab:cd:' + 'ef'.repeat(30), // 32 bytes total = valid SHA-256
    checksums: CHECKSUMS,
  });
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /SERVER_URL="https:\/\/blueeye\.example\.dk"/);
  assert.match(script, /ENROLL_CODE="CODE-123_abc"/);
  assert.match(script, /CERT_FINGERPRINT="AB:CD:(EF:){29}EF"/); // normalised
  assert.match(script, /linux-amd64\) printf '%s' "a{64}"/);
  assert.match(script, /windows-amd64\) printf '%s' "b{64}"/);
  // The core safety check + idempotency hooks must be present.
  assert.match(script, /checksum mismatch/);
  assert.match(script, /enroll --code/);
  assert.match(script, /systemctl/);
});

// Build a fake `curl` that writes fixed bytes to the -o target, so the script's
// real SHA-256 verification can be exercised without any network or system writes.
function writeFakeCurl(dir) {
  const p = path.join(dir, 'fake-curl');
  fs.writeFileSync(p, `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$BLUEEYE_FAKE_BYTES" > "$out"
`, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

function runScript(script, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-install-'));
  const scriptPath = path.join(dir, 'install.sh');
  fs.writeFileSync(scriptPath, script);
  return execFileSync('sh', [scriptPath], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('install script ABORTS on checksum mismatch (real sha256 verification)', () => {
  const bytes = 'the-real-bytes';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-curl-'));
  const curl = writeFakeCurl(dir);
  // Embed a deliberately WRONG checksum for linux-amd64.
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', checksums: { 'linux-amd64': '0'.repeat(64) } });

  let threw = false;
  let stderr = '';
  try {
    runScript(script, { BLUEEYE_PLATFORM: 'linux-amd64', BLUEEYE_CURL: curl, BLUEEYE_FAKE_BYTES: bytes, BLUEEYE_DRY_RUN: '1' });
  } catch (err) {
    threw = true;
    stderr = String(err.stderr || '');
  }
  assert.equal(threw, true, 'script should exit non-zero on mismatch');
  assert.match(stderr, /checksum mismatch/);
});

test('install script verifies a correct checksum and stops at dry-run', () => {
  const bytes = 'the-real-bytes';
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-curl-'));
  const curl = writeFakeCurl(dir);
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', checksums: { 'linux-amd64': sha } });

  const out = runScript(script, { BLUEEYE_PLATFORM: 'linux-amd64', BLUEEYE_CURL: curl, BLUEEYE_FAKE_BYTES: bytes, BLUEEYE_DRY_RUN: '1' });
  assert.match(out, /checksum OK/);
  assert.match(out, /dry-run/);
});

test('install script fails for a platform with no published binary', () => {
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', checksums: CHECKSUMS });
  let threw = false;
  let stderr = '';
  try {
    runScript(script, { BLUEEYE_PLATFORM: 'solaris-sparc', BLUEEYE_DRY_RUN: '1' });
  } catch (err) {
    threw = true;
    stderr = String(err.stderr || '');
  }
  assert.equal(threw, true);
  assert.match(stderr, /no agent binary published/);
});
