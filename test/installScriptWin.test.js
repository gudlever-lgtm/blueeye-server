'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderInstallPs1, winSecurityPrelude } = require('../src/enroll/installScriptWin');

const SHA = 'a'.repeat(64);
const FP = Array.from({ length: 32 }, () => 'ab').join(':'); // valid 32-byte SHA-256

test('renderInstallPs1 embeds server URL, code, fingerprint and the source checksum', () => {
  const script = renderInstallPs1({
    serverUrl: 'https://blueeye.example.dk',
    code: 'CODE-123_abc',
    certFingerprint: 'ab:cd:' + 'ef'.repeat(30), // 32 bytes total = valid SHA-256
    sourceSha: SHA,
  });
  assert.match(script, /#Requires -Version 5\.1/);
  assert.match(script, /\$ServerUrl\s*=\s*'https:\/\/blueeye\.example\.dk'/);
  assert.match(script, /\$EnrollCode\s*=\s*'CODE-123_abc'/);
  assert.match(script, /\$CertFingerprint\s*=\s*'AB:CD:(EF:){29}EF'/); // normalised
  assert.match(script, new RegExp(`\\$SourceSha256\\s*=\\s*'${SHA}'`));
  assert.match(script, /enroll\/agent-source\.tgz/);
});

test('renderInstallPs1 uses PowerShell idioms, never the POSIX curl|sh one-liner', () => {
  const script = renderInstallPs1({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  // The whole point: no `curl -sSL` and no `| sh` that PowerShell cannot run.
  assert.ok(!/curl -sSL/.test(script), 'must not tell PowerShell to run curl -sSL');
  assert.ok(!/\|\s*sh\b/.test(script), 'must not pipe to sh');
  // Downloads with Invoke-WebRequest and verifies with Get-FileHash.
  assert.match(script, /Invoke-WebRequest -UseBasicParsing/);
  assert.match(script, /Get-FileHash -Algorithm SHA256/);
  assert.match(script, /checksum mismatch/);
  // Honours the same dry-run inspection hook as the shell installer.
  assert.match(script, /BLUEEYE_DRY_RUN/);
});

test('renderInstallPs1 requires Node, extracts with tar, enrolls, and registers a scheduled task', () => {
  const script = renderInstallPs1({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  assert.match(script, /Get-Command node/);
  assert.match(script, /nodejs\.org/); // clear guidance when Node is missing
  assert.match(script, /tar\.exe/);
  assert.match(script, /-xzf/);
  // npm runs via cmd.exe (cmd merges stderr) so an "npm notice" on stderr can't
  // trip $ErrorActionPreference='Stop' into a NativeCommandError on success.
  assert.match(script, /cmd \/c 'npm ci --omit=dev 2>&1'/);
  assert.match(script, /cmd \/c 'npm install --omit=dev 2>&1'/);
  assert.ok(!/& npm .*2>&1 \| Out-Null/.test(script), 'must not pipe npm stderr back into PowerShell');
  // Enrolls via the agent CLI, pinning token/config into a state dir.
  assert.match(script, /'enroll', '--code', \$EnrollCode, '--server', \$ServerUrl/);
  assert.match(script, /index\.js/);
  assert.match(script, /BLUEEYE_TOKEN_PATH/);
  // Auto-start: a Scheduled Task running as SYSTEM at boot, restart on failure.
  assert.match(script, /Register-ScheduledTask/);
  assert.match(script, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(script, /-UserId 'SYSTEM'/);
  assert.match(script, /RestartCount/);
});

test('renderInstallPs1 forces TLS 1.2 and pins a self-signed cert when a fingerprint is given', () => {
  const script = renderInstallPs1({ serverUrl: 'https://x', code: 'C', certFingerprint: FP, sourceSha: SHA });
  // TLS 1.2 (5.1 defaults to 1.0) — the 3072 bitmask.
  assert.match(script, /SecurityProtocol -bor 3072/);
  // Pins the leaf cert (SHA-256 of the DER) instead of disabling validation.
  assert.match(script, /ServerCertificateValidationCallback/);
  assert.match(script, /SHA256\]::Create\(\)\.ComputeHash\(\$cert\.GetRawCertData\(\)\)/);
  assert.ok(!/SkipCertificateCheck/.test(script), 'never blindly skips validation');
});

test('renderInstallPs1 forces TLS 1.2 but does NOT pin when no fingerprint is configured', () => {
  const script = renderInstallPs1({ serverUrl: 'https://x', code: 'C', certFingerprint: '', sourceSha: SHA });
  assert.match(script, /SecurityProtocol -bor 3072/);
  // With no fingerprint the pinning callback body is guarded off ($FpHex empty).
  assert.match(script, /if \(\$FpHex\)/);
});

test('renderInstallPs1 turns fetch failures into actionable indicators (cert vs unreachable)', () => {
  const script = renderInstallPs1({ serverUrl: 'https://x', code: 'C', certFingerprint: FP, sourceSha: SHA });
  assert.match(script, /Fetch-Or-Explain/);
  assert.match(script, /AGENT_CERT_FINGERPRINT/);       // self-signed guidance
  assert.match(script, /check DNS\/firewall/);          // unreachable-host guidance
  assert.match(script, /BLUEEYE_PUBLIC_URL/);           // bare-hostname guidance
});

test('winSecurityPrelude: single line, no double quotes, TLS always, pin only with a fingerprint', () => {
  const withFp = winSecurityPrelude(FP);
  assert.ok(!/\n/.test(withFp) && !/"/.test(withFp), 'safe to embed in powershell -Command "…"');
  assert.match(withFp, /SecurityProtocol -bor 3072/);
  assert.match(withFp, /ServerCertificateValidationCallback/);
  assert.match(withFp, new RegExp("'" + 'ab'.repeat(32) + "'")); // fingerprint hex, no separators
  const noFp = winSecurityPrelude('');
  assert.match(noFp, /SecurityProtocol -bor 3072/);
  assert.ok(!/ServerCertificateValidationCallback/.test(noFp));
});

test('renderInstallPs1 fails clearly when the server has no source published', () => {
  const script = renderInstallPs1({ serverUrl: 'http://x', code: 'C', sourceSha: '' });
  assert.match(script, /no agent source published/);
});

test('renderInstallPs1 single-quote-escapes injected values (no injection break-out)', () => {
  const script = renderInstallPs1({ serverUrl: "http://x'; rm -rf /", code: 'C', sourceSha: SHA });
  // The stray quote is doubled inside the single-quoted PS literal, not left raw.
  assert.match(script, /\$ServerUrl\s*=\s*'http:\/\/x''; rm -rf \/'/);
});
