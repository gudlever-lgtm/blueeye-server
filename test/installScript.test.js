'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

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

test('renderInstallScript wires all three runtimes: binary (new default), Node, and Docker (opt-in)', () => {
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  // Binary is the new default when a SHA is available; falls back to node, then none.
  assert.match(script, /pick_binary_sha/);
  assert.match(script, /RUNTIME=binary/);
  assert.match(script, /command -v node/);
  assert.match(script, /RUNTIME=node/);
  // Docker is now automatic fallback (third priority).
  assert.match(script, /command -v docker/);
  assert.match(script, /RUNTIME=docker/);
  // Docker branch (opt-in)
  assert.match(script, /docker build -t "\$IMAGE"/);
  assert.match(script, /docker run -d --name "\$CONTAINER" --restart unless-stopped --network host/);
  assert.match(script, /BLUEEYE_ENROLLMENT_CODE=\$ENROLL_CODE/);
  // Node branch: versioned releases/<v> + `current` symlink, a systemd service
  // running from `current` so signed updates can swap releases atomically.
  assert.match(script, /RELEASES="\$INSTALL_DIR\/releases"/);
  assert.match(script, /mv -T "\$CURRENT\.next" "\$CURRENT"/);
  assert.match(script, /node "\$CURRENT\/src\/index\.js" enroll --code "\$ENROLL_CODE"/);
  // NODE_BIN must be captured before it's used in the ExecStart of the systemd unit.
  assert.match(script, /NODE_BIN=\$\(command -v node\)/);
  assert.match(script, /install_service "\$NODE_BIN \$CURRENT\/src\/index\.js" systemd/);
  assert.match(script, /systemctl/);
  assert.match(script, /Environment=BLUEEYE_RELEASES_DIR=\$RELEASES/);
  assert.match(script, /Environment=BLUEEYE_CURRENT_LINK=\$CURRENT/);
  // Token lives in the shared state dir (survives release swaps), pinned for both
  // the enroll step and the service.
  assert.match(script, /TOKEN_PATH="\$STATE_DIR\/token"/);
  assert.match(script, /Environment=BLUEEYE_TOKEN_PATH=\$TOKEN_PATH/);
  // Signed self-updates: fetch + pin the release public key from the server.
  assert.match(script, /enroll\/agent-release-key/);
  assert.match(script, /BLUEEYE_RELEASE_PUBLIC_KEY=/);
  // Points the operator at the shipped uninstaller.
  assert.match(script, /uninstall\.sh/);
  // Graceful "ask" when no runtime is available.
  assert.match(script, /Node\.js was not found/);
  // Binary install path: downloads pre-built binary, verifies checksum, enrolls.
  assert.match(script, /enroll\/agent-binary\/\$BINARY_ARCH/);
  assert.match(script, /"\$DEST\/blueeye-agent" enroll --code "\$ENROLL_CODE"/);
  // Slim Docker path when binary is available.
  assert.match(script, /Dockerfile\.slim/);
  // install_service is called with "binary" as the runtime tag for binary installs.
  assert.match(script, /install_service "\$CURRENT\/blueeye-agent" binary/);
});

test('renderInstallScript embeds binary SHA-256 checksums when provided', () => {
  const x64sha  = 'b'.repeat(64);
  const arm64sha = 'c'.repeat(64);
  const script = renderInstallScript({
    serverUrl: 'http://x',
    code: 'C',
    sourceSha: SHA,
    binaryChecksums: { 'linux-x64': x64sha, 'linux-arm64': arm64sha },
    agentVersion: '9.9.9',
  });
  assert.match(script, new RegExp(`BINARY_SHA_LINUX_X64="${x64sha}"`));
  assert.match(script, new RegExp(`BINARY_SHA_LINUX_ARM64="${arm64sha}"`));
  assert.match(script, /AGENT_VERSION="9\.9\.9"/);
});

test('renderInstallScript has empty binary SHAs when no checksums provided', () => {
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  assert.match(script, /BINARY_SHA_LINUX_X64=""/);
  assert.match(script, /BINARY_SHA_LINUX_ARM64=""/);
});

// Build a fake `curl` that writes fixed bytes to the -o target (or to stdout when
// there is no -o, as the release-key fetch does), so the script's real SHA-256
// verification can be exercised without any network or system writes.
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
if [ -n "$out" ]; then
  printf '%s' "$BLUEEYE_FAKE_BYTES" > "$out"
else
  printf '%s' "$BLUEEYE_FAKE_BYTES"
fi
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

// The mismatch an operator actually hits: the script was generated before the
// server repackaged the agent source (a redeploy, a reload), so the checksum
// baked into it is old while the download is current. "checksum mismatch" alone
// reads like a corrupted or tampered download — it has to name the stale side.
test('install script names the stale SCRIPT when the server has moved on', () => {
  const bytes = 'the-real-bytes';
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-curl-'));
  const curl = path.join(dir, 'fake-curl');
  // Answers the tarball with the CURRENT bytes and /agent-source.sha256 with
  // their checksum — i.e. a server one build ahead of this script.
  fs.writeFileSync(curl, `#!/bin/sh
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *agent-source.sha256) printf '%s\\n' "${sha}" ;;
  *) printf '%s' "${bytes}" > "$out" ;;
esac
`, { mode: 0o755 });
  fs.chmodSync(curl, 0o755);

  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: '0'.repeat(64) });
  let stderr = '';
  assert.throws(() => runScript(script, { BLUEEYE_CURL: curl, BLUEEYE_DRY_RUN: '1' }), (err) => {
    stderr = String(err.stderr || '');
    return true;
  });
  assert.match(stderr, /install script is out of date/);
  assert.match(stderr, new RegExp(`now serves ${sha}`));
});

// The reverse: the server says it serves exactly what this script expects, but
// the bytes that arrived are something else — a cache or proxy in the path.
test('install script names the stale DOWNLOAD when the server agrees with the script', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-curl-'));
  const curl = path.join(dir, 'fake-curl');
  const expected = '0'.repeat(64);
  fs.writeFileSync(curl, `#!/bin/sh
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *agent-source.sha256) printf '%s\\n' "${expected}" ;;
  *) printf '%s' "stale-cached-bytes" > "$out" ;;
esac
`, { mode: 0o755 });
  fs.chmodSync(curl, 0o755);

  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: expected });
  let stderr = '';
  assert.throws(() => runScript(script, { BLUEEYE_CURL: curl, BLUEEYE_DRY_RUN: '1' }), (err) => {
    stderr = String(err.stderr || '');
    return true;
  });
  assert.match(stderr, /not what the server says it serves/);
  assert.match(stderr, /proxy or cache/);
});

// The tarball is asked for by checksum, so no cache in the path can answer with
// an older build under the same URL.
test('install script requests the source bundle by checksum (?sha=)', () => {
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: 'a'.repeat(64) });
  assert.match(script, /agent-source\.tgz\?sha=\$SOURCE_SHA256/);
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
  assert.match(stderr, /Node\.js was not found/);
  assert.match(stderr, /docker\.com|nodejs\.org/);
});

test('install script fails clearly when docker is selected but not installed', () => {
  const bytes = 'src-bytes';
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-nocker-'));
  const curl = writeFakeCurl(tmpDir);

  // Build a minimal PATH with sha256sum/awk/mktemp/rm/sh but WITHOUT docker, so the
  // guard "RUNTIME=docker but docker not found" is exercised even when docker is
  // installed on the host running the tests.
  // NOTE: on modern Debian/Ubuntu /bin -> /usr/bin (usrmerge), so we cannot use /bin
  // as a PATH component — it would expose /usr/bin/docker too. Instead we symlink the
  // exact tools we need (including sh/dash) into an isolated dir.
  const toolsDir = path.join(tmpDir, 'tools');
  fs.mkdirSync(toolsDir);
  for (const tool of ['sha256sum', 'shasum', 'awk', 'mktemp', 'rm', 'sh', 'dash']) {
    try {
      const real = execFileSync('which', [tool], { encoding: 'utf8' }).trim();
      if (real) fs.symlinkSync(real, path.join(toolsDir, tool));
    } catch (_) { /* optional tool */ }
  }

  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: sha });

  // PATH is ONLY toolsDir — docker is absent; command -v docker will fail as intended.
  const minimalPath = toolsDir;

  let threw = false;
  let stderr = '';
  try {
    runScript(script, {
      BLUEEYE_CURL: curl,
      BLUEEYE_FAKE_BYTES: bytes,
      BLUEEYE_RUNTIME: 'docker',
      PATH: minimalPath,
    });
  } catch (err) {
    threw = true;
    stderr = String(err.stderr || '');
  }
  assert.equal(threw, true);
  assert.match(stderr, /Docker runtime selected/);
  assert.match(stderr, /docker\.com/);
});

// ---- cross-platform: macOS (Darwin) support --------------------------------
test('renderInstallScript guards the pre-built binary to Linux (macOS must not grab a Linux binary)', () => {
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: 'a'.repeat(64) });
  // Both binary pickers bail out unless the kernel is Linux.
  const guards = script.match(/\[ "\$\(uname -s\)" = "Linux" \] \|\| \{ printf ''; return 0; \}/g) || [];
  assert.ok(guards.length >= 2, 'both pick_binary_arch and pick_binary_sha are Linux-guarded');
});

test('renderInstallScript installs a launchd daemon on macOS and a portable current-symlink swap', () => {
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: 'a'.repeat(64) });
  // Darwin branch in install_service delegates to a LaunchDaemon writer.
  assert.match(script, /uname -s.*= "Darwin"/);
  assert.match(script, /install_launchd/);
  assert.match(script, /LaunchDaemons\/\$LABEL\.plist/);
  assert.match(script, /com\.blueeye\.agent/);
  assert.match(script, /launchctl bootstrap system|launchctl load -w/);
  // The current-symlink swap is portable: GNU mv -T on Linux, plain ln on Darwin.
  assert.match(script, /point_current/);
  assert.match(script, /rm -f "\$CURRENT" && ln -sfn "\$DEST_LINK" "\$CURRENT"/);
  assert.match(script, /mv -T "\$CURRENT\.next" "\$CURRENT"/);
});

test('renderInstallScript runs the agent connection self-test (doctor) after install', () => {
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: 'a'.repeat(64) });
  assert.match(script, /run_doctor/);
  assert.match(script, /node "\$CURRENT\/src\/index\.js" doctor/);
  assert.match(script, /docker exec "\$CONTAINER" node src\/index\.js doctor/);
});

// ---- release trust anchor (resolve_release_key) ---------------------------
//
// The installer must never silently re-anchor an installed agent to a different
// release key: a server compromised AFTER install could otherwise replace the
// very key that is supposed to detect it. These exercise the real shell function
// by sourcing the script with its `main "$@"` entry point stripped off.

function sourceAndCall(script, snippet, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-key-'));
  const lib = path.join(dir, 'lib.sh');
  fs.writeFileSync(lib, `${script.replace(/\nmain "\$@"\s*$/, '\n')}\n${snippet}\n`);
  // The function logs to stderr (its stdout is the key itself), so both streams
  // are needed to assert on the value AND on what the operator was told.
  const r = spawnSync('sh', [lib], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, `snippet failed: ${r.stderr}`);
  return `${r.stdout}${r.stderr}`;
}

test('resolve_release_key prefers an out-of-band provisioned key over the server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-curl-'));
  const curl = writeFakeCurl(dir);
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  const out = sourceAndCall(script, 'printf "KEY=[%s]\\n" "$(resolve_release_key)"', {
    BLUEEYE_CURL: curl,
    BLUEEYE_FAKE_BYTES: 'key-from-server',
    BLUEEYE_RELEASE_PUBLIC_KEY: 'key-from-operator',
  });
  assert.match(out, /KEY=\[key-from-operator\]/);
  assert.match(out, /provisioned BLUEEYE_RELEASE_PUBLIC_KEY/);
});

test('resolve_release_key keeps a key already pinned on the host', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-curl-'));
  const curl = writeFakeCurl(dir);
  const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-units-'));
  fs.mkdirSync(path.join(unitDir, 'blueeye-agent.service.d'), { recursive: true });
  fs.writeFileSync(
    path.join(unitDir, 'blueeye-agent.service.d', '10-release-key.conf'),
    '[Service]\nEnvironment=BLUEEYE_RELEASE_PUBLIC_KEY=already-pinned\n'
  );

  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  const out = sourceAndCall(script, 'printf "KEY=[%s]\\n" "$(resolve_release_key)"', {
    BLUEEYE_CURL: curl,
    BLUEEYE_FAKE_BYTES: 'key-from-server',
    BLUEEYE_UNIT_DIR: unitDir,
  });
  // Empty return = "leave the pinned drop-in alone"; the server's key is ignored.
  assert.match(out, /KEY=\[\]/);
  assert.match(out, /already pinned on this host/);
  assert.doesNotMatch(out, /key-from-server/);
});

test('resolve_release_key falls back to the server and says it is trust-on-first-use', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-curl-'));
  const curl = writeFakeCurl(dir);
  const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-units-'));
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  const out = sourceAndCall(script, 'printf "KEY=[%s]\\n" "$(resolve_release_key)"', {
    BLUEEYE_CURL: curl,
    BLUEEYE_FAKE_BYTES: 'key-from-server',
    BLUEEYE_UNIT_DIR: unitDir,
  });
  assert.match(out, /KEY=\[key-from-server\]/);
  assert.match(out, /trust-on-first-use/);
});

test('the generated systemd unit is sandboxed', () => {
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  for (const directive of ['NoNewPrivileges=yes', 'PrivateTmp=yes', 'ProtectHome=read-only', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK', 'UMask=0077', 'LimitCORE=0']) {
    assert.ok(script.includes(directive), `unit is missing ${directive}`);
  }
  // ProtectSystem would break install-tool (the package manager writes /usr) and
  // ProcSubset=pid would hide /proc/net from the proc traffic source. Match on a
  // directive at the start of a line, so the comment naming them doesn't count.
  assert.doesNotMatch(script, /^ProtectSystem=/m, 'ProtectSystem must stay off');
  assert.doesNotMatch(script, /^ProcSubset=/m, 'ProcSubset must stay off');
});

// ---------------------------------------------------------------------------
// The SIGNED release path.
//
// This is the path that exists because the source bundle could not carry its
// own integrity: it is repackaged whenever the server restarts, and the
// checksum to judge it by arrives in a SEPARATE request, which a cache or an
// inspecting proxy can answer on its own. A signed release is published once
// and carries its sha256 inside the bytes that were signed, so both of those
// failure modes stop being possible.
//
// These tests run the generated shell for real against a fake curl, with a real
// Ed25519 keypair — not a shape assertion about the script text.

const { canonicalize } = require('../src/lib/canonicalize');

// A curl that answers per URL and honours -D/-o, so the script's header parsing
// and its 404 fallback are both exercised.
function writeReleaseCurl(dir) {
  const p = path.join(dir, 'release-curl');
  fs.writeFileSync(p, `#!/bin/sh
out=""; hdr=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -D) hdr="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *agent-release.tgz*)
    [ -n "$BLUEEYE_FAKE_RELEASE" ] || exit 22
    [ -n "$hdr" ] && {
      printf 'HTTP/1.1 200 OK\\r\\n'                              >  "$hdr"
      printf 'X-Release-Version: %s\\r\\n' "$BLUEEYE_FAKE_VERSION" >> "$hdr"
      printf 'X-Release-Manifest: %s\\r\\n' "$BLUEEYE_FAKE_MANIFEST" >> "$hdr"
      printf 'X-Release-Signature: %s\\r\\n' "$BLUEEYE_FAKE_SIG"  >> "$hdr"
      printf '\\r\\n'                                             >> "$hdr"
    }
    [ -n "$out" ] && printf '%s' "$BLUEEYE_FAKE_RELEASE" > "$out"
    exit 0 ;;
  *agent-release-key*)
    printf '%s' "$BLUEEYE_FAKE_KEY"; exit 0 ;;
  *agent-source*)
    [ -n "$out" ] && printf '%s' "$BLUEEYE_FAKE_BYTES" > "$out"
    printf '%s' "$BLUEEYE_FAKE_BYTES"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

// Builds a release + the env the fake curl serves it from.
function signedRelease({ bytes = 'the signed agent release', tamperBytes = null, wrongKey = false } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const served = tamperBytes == null ? bytes : tamperBytes;
  const sha256 = crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  const manifest = { version: '0.43.0', sha256, size: Buffer.byteLength(bytes), created_at: '2026-09-25T10:00:00.000Z' };
  const canonical = Buffer.from(canonicalize(manifest), 'utf8');
  const signer = wrongKey ? crypto.generateKeyPairSync('ed25519').privateKey : privateKey;
  return {
    BLUEEYE_FAKE_RELEASE: served,
    BLUEEYE_FAKE_VERSION: '0.43.0',
    BLUEEYE_FAKE_MANIFEST: canonical.toString('base64'),
    BLUEEYE_FAKE_SIG: crypto.sign(null, canonical, signer).toString('base64'),
    BLUEEYE_RELEASE_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

test('the installer prefers the signed release, and verifies its signature for real', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-rel-'));
  const curl = writeReleaseCurl(dir);
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: 'a'.repeat(64) });

  const out = runScript(script, { BLUEEYE_CURL: curl, BLUEEYE_DRY_RUN: '1', ...signedRelease() });
  assert.match(out, /signature verified/, 'the signature was not actually checked');
  assert.match(out, /sha256 matches its manifest/);
  assert.match(out, /source bundle not needed/, 'it fell back to the unsigned path anyway');
});

test('a signed release whose bytes do not match its own manifest is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-rel-'));
  const curl = writeReleaseCurl(dir);
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: 'a'.repeat(64) });

  // Exactly the reported production symptom: the manifest is authentic, the
  // bytes that arrived are not the ones it names.
  const env = signedRelease({ bytes: 'the real release', tamperBytes: 'a cached, older release' });
  assert.throws(() => runScript(script, { BLUEEYE_CURL: curl, BLUEEYE_DRY_RUN: '1', ...env }), (err) => {
    const s = String(err.stderr || '');
    assert.match(s, /does not match its own signed manifest/);
    assert.match(s, /altered or cached/);
    return true;
  });
});

test('a bad signature ABORTS — it never falls back to the unsigned bundle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-rel-'));
  const curl = writeReleaseCurl(dir);
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: 'a'.repeat(64) });

  // Falling back here would mean anyone who can break the signature can
  // downgrade the install to the path with no signature at all.
  const env = signedRelease({ wrongKey: true });
  assert.throws(() => runScript(script, { BLUEEYE_CURL: curl, BLUEEYE_DRY_RUN: '1', ...env }), (err) => {
    const s = String(err.stderr || '');
    assert.match(s, /did NOT pass signature verification/);
    assert.ok(!/checksum OK/.test(String(err.stdout || '')), 'it fell through to the source bundle');
    return true;
  });
});

test('no signed release published falls back to the source bundle, as before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-rel-'));
  const curl = writeReleaseCurl(dir);
  const bytes = 'the-source-bytes';
  const sha = crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: sha });

  const out = runScript(script, {
    BLUEEYE_CURL: curl, BLUEEYE_DRY_RUN: '1', BLUEEYE_FAKE_BYTES: bytes,
    // BLUEEYE_FAKE_RELEASE unset -> the fake curl answers 404 for the release.
  });
  assert.match(out, /no signed release published/);
  assert.match(out, /checksum OK/);
});

test('with no key to check against it says so, and REQUIRE_SIGNED_INSTALL turns that into a refusal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-rel-'));
  const curl = writeReleaseCurl(dir);
  const script = renderInstallScript({ serverUrl: 'http://x', code: 'C', sourceSha: 'a'.repeat(64) });
  const env = signedRelease();
  delete env.BLUEEYE_RELEASE_PUBLIC_KEY;   // and the fake curl serves no key either

  const out = runScript(script, { BLUEEYE_CURL: curl, BLUEEYE_DRY_RUN: '1', ...env });
  assert.match(out, /SIGNATURE could not be checked here/);
  assert.match(out, /sha256 matches its manifest/, 'the sha256 binding still has to hold');

  assert.throws(
    () => runScript(script, { BLUEEYE_CURL: curl, BLUEEYE_DRY_RUN: '1', BLUEEYE_REQUIRE_SIGNED_INSTALL: '1', ...env }),
    (err) => { assert.match(String(err.stderr || ''), /REQUIRE_SIGNED_INSTALL is set/); return true; },
  );
});
