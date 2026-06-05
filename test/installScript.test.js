'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { renderInstallScript } = require('../src/enroll/installScript');

const SHA = 'a'.repeat(64);

test('renderInstallScript embeds server URL, code, fingerprint and the source checksum', () => {
  const script = renderInstallScript({
    serverUrl: 'https://blueeye.example.dk',
    code: 'CODE-123_abc',
    certFingerprint: 'ab:cd:' + 'ef'.repeat(30), // 32 bytes total = valid SHA-256
    sourceSha: SHA,
  });
  assert.match(script, /^#!\/bin\/sh/);
  assert.match(script, /SERVER_URL="https:\/\/blueeye\.example\.dk"/);
  assert.match(script, /ENROLL_CODE="CODE-123_abc"/);
  assert.match(script, /CERT_FINGERPRINT="AB:CD:(EF:){29}EF"/); // normalised
  assert.match(script, new RegExp(`SOURCE_SHA256="${SHA}"`));
  // Fetches the SOURCE bundle (no per-platform binary), and the safety check.
  assert.match(script, /enroll\/agent-source\.tgz/);
  assert.match(script, /checksum mismatch/);
});

test('renderInstallScript wires both runtimes: Docker (preferred) and Node', () => {
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  // Docker branch
  assert.match(script, /docker build -t "\$IMAGE"/);
  assert.match(script, /docker run -d --name "\$CONTAINER" --restart unless-stopped --network host/);
  assert.match(script, /BLUEEYE_ENROLLMENT_CODE=\$ENROLL_CODE/);
  // Node branch + systemd service
  assert.match(script, /node "\$INSTALL_DIR\/src\/index\.js" enroll --code "\$ENROLL_CODE"/);
  assert.match(script, /systemctl/);
  // Graceful "ask" when neither runtime is present.
  assert.match(script, /neither Docker nor Node/);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-curl-'));
  const curl = writeFakeCurl(dir);
  // Embed a deliberately WRONG checksum.
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: '0'.repeat(64) });

  let threw = false;
  let stderr = '';
  try {
    runScript(script, { BLUEEYE_CURL: curl, BLUEEYE_FAKE_BYTES: 'the-real-bytes', BLUEEYE_DRY_RUN: '1' });
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
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: sha });

  const out = runScript(script, { BLUEEYE_CURL: curl, BLUEEYE_FAKE_BYTES: bytes, BLUEEYE_DRY_RUN: '1' });
  assert.match(out, /checksum OK/);
  assert.match(out, /dry-run/);
});

test('install script fails clearly when the server published no source', () => {
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: '' });
  let threw = false;
  let stderr = '';
  try {
    runScript(script, { BLUEEYE_DRY_RUN: '1' });
  } catch (err) {
    threw = true;
    stderr = String(err.stderr || '');
  }
  assert.equal(threw, true);
  assert.match(stderr, /no agent source published/);
});

test('install script asks the user to install a runtime when neither is present', () => {
  const bytes = 'src-bytes';
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-curl-'));
  const curl = writeFakeCurl(dir);
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: sha });

  let threw = false;
  let stderr = '';
  try {
    // Force "no runtime"; checksum passes first, so we exercise the ask path.
    runScript(script, { BLUEEYE_CURL: curl, BLUEEYE_FAKE_BYTES: bytes, BLUEEYE_RUNTIME: 'none' });
  } catch (err) {
    threw = true;
    stderr = String(err.stderr || '');
  }
  assert.equal(threw, true);
  assert.match(stderr, /neither Docker nor Node/);
  assert.match(stderr, /docker\.com|nodejs\.org/);
});
