'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderInstallPs1 } = require('../src/enroll/installScriptWin');

const SHA = 'a'.repeat(64);

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

test('renderInstallPs1 fails clearly when the server has no source published', () => {
  const script = renderInstallPs1({ serverUrl: 'http://x', code: 'C', sourceSha: '' });
  assert.match(script, /no agent source published/);
});

test('renderInstallPs1 single-quote-escapes injected values (no injection break-out)', () => {
  const script = renderInstallPs1({ serverUrl: "http://x'; rm -rf /", code: 'C', sourceSha: SHA });
  // The stray quote is doubled inside the single-quoted PS literal, not left raw.
  assert.match(script, /\$ServerUrl\s*=\s*'http:\/\/x''; rm -rf \/'/);
});
