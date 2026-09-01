'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderInstallPs1, renderUpdatePs1, winSecurityPrelude, renderUninstallPs1 } = require('../src/enroll/installScriptWin');

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

test('renderInstallPs1 stops a running instance BEFORE replacing the code (so a re-run actually upgrades the running version)', () => {
  const script = renderInstallPs1({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  // Must terminate the live agent first — otherwise the old-version process keeps
  // running (Scheduled Task ignores a second Start) and the dashboard never sees
  // the new version.
  assert.match(script, /Stop-ScheduledTask -TaskName \$ServiceName/);
  // ...and that stop has to happen before the extract, not after.
  const stopIdx = script.indexOf('Stop-ScheduledTask -TaskName $ServiceName');
  const extractIdx = script.indexOf('extracting agent source');
  assert.ok(stopIdx !== -1 && extractIdx !== -1 && stopIdx < extractIdx,
    'the running task must be stopped before the code is extracted');
});

test('renderInstallPs1 treats a stored token as success even when node exits non-zero', () => {
  const script = renderInstallPs1({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  // Capture the enroll exit code, then decide by the RESULT (token present) rather
  // than the exit code — so an exit-time crash after a successful enroll doesn't
  // abort a working install.
  assert.match(script, /\$enrollExit = \$LASTEXITCODE/);
  assert.match(script, /Test-Path \$TokenPath/);
  assert.match(script, /treating enrollment as successful/);
  // A genuinely missing token is still a hard failure.
  assert.match(script, /no token was written/);
  // And "success" with no token written is rejected too (never register a dead agent).
  assert.match(script, /refusing to register a non-working agent/);
});

test('renderInstallPs1 prints the uninstall command up front, not only at the end', () => {
  const script = renderInstallPs1({ serverUrl: 'https://blueeye.example.dk', code: 'C', sourceSha: SHA });
  const lines = script.split('\n');
  const earlyIdx = lines.findIndex((l) => /to remove the agent at any time/.test(l));
  const downloadIdx = lines.findIndex((l) => /downloading agent source/.test(l));
  assert.ok(earlyIdx !== -1, 'must echo an uninstall hint');
  assert.ok(earlyIdx < downloadIdx, 'uninstall hint must come before the download line');
  assert.match(lines[earlyIdx], /uninstall\.ps1'' -OutFile/);
});

test('renderInstallPs1 makes the SYSTEM service observable — captures the agent log and shows it', () => {
  const script = renderInstallPs1({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  // The launcher redirects the agent's stdout+stderr into agent.log (a SYSTEM
  // scheduled task has no console, so otherwise "not connected" has no indicator).
  assert.match(script, /agent\.log/);
  assert.match(script, /index\.js'\)"" >> ""\$AgentLog"" 2>&1/);
  // The installer shows the first log lines + how to tail it, so the operator can
  // see whether it actually connected.
  assert.match(script, /Get-Content \$AgentLog -Tail/);
  assert.match(script, /Get-Content '\$AgentLog' -Wait/);
  assert.match(script, /Get-ScheduledTaskInfo/);
});

test('renderInstallPs1 runs the agent connection self-test (doctor) at the end', () => {
  const script = renderInstallPs1({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  assert.match(script, /index\.js'\) doctor/);
});

test('renderInstallPs1 Fail prints a clean message, not a WriteErrorException', () => {
  const script = renderInstallPs1({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  assert.match(script, /\[Console\]::Error\.WriteLine\("\[blueeye\] ERROR: \$m"\); exit 1/);
  assert.ok(!/function Fail.*Write-Error/.test(script), 'Fail must not use Write-Error (throws WriteErrorException under Stop)');
});

test('renderInstallPs1 prints a runnable manual uninstall hint (backtick-escaped $false)', () => {
  const script = renderInstallPs1({ serverUrl: 'http://x', code: 'C', sourceSha: SHA });
  const line = script.split('\n').find((l) => /remove it:/.test(l));
  // Must be `$false (escaped) so Write-Host prints a literal $false, not "False".
  assert.match(line, /-Confirm:`\$false/);
  assert.ok(!/-Confirm:\$false(?!`)/.test(line.replace('`$false', '')), 'no un-escaped $false that would expand to False');
});

test('renderUninstallPs1 is a real Windows uninstaller, not a Linux one', () => {
  const script = renderUninstallPs1();
  assert.match(script, /#Requires -Version 5\.1/);
  assert.match(script, /Unregister-ScheduledTask -TaskName \$ServiceName -Confirm:\$false/);
  assert.match(script, /Remove-Item -Recurse -Force \$d/);
  // Must not be bash / point Windows at the Linux uninstaller.
  assert.ok(!/#!\/.*sh/.test(script));
  assert.ok(!/curl -sSL/.test(script));
  assert.ok(!/\| sudo sh/.test(script));
  assert.ok(!/systemctl|launchctl/.test(script));
});

test('renderUninstallPs1 frees in-use files: kills any BlueEyes node, waits, retries removal', () => {
  const script = renderUninstallPs1();
  // Kill matches any agent node (service or a foreground doctor run), not just index.js.
  assert.match(script, /CommandLine -like '\*BlueEyes\*'/);
  assert.match(script, /Start-Sleep/);
  assert.match(script, /for \(\$i = 0; \(\$i -lt 3\)/); // retry loop
  assert.match(script, /could not fully remove/); // clear message if something is still locked
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

// ---- renderUpdatePs1 (the Windows "just update" one-liner) ------------------
// The dashboard's Update button hands this to an operator when a Windows agent is
// behind: it upgrades the agent that is already on the host and must never turn
// into a fresh installation (which would enroll a SECOND agent on the server).

test('renderUpdatePs1 carries no enrollment code and never enrolls', () => {
  const script = renderUpdatePs1({ serverUrl: 'https://blueeye.example.dk', sourceSha: SHA, agentVersion: '1.4.0' });
  assert.ok(!/\$EnrollCode/.test(script), 'must not embed an enrollment code');
  assert.ok(!/'enroll', '--code'/.test(script), 'must not run the agent enroll command');
  // The task normally already exists; it is only re-registered when missing, so an
  // update never rewrites a task the operator has tuned.
  assert.match(script, /\$task = Get-ScheduledTask -TaskName \$ServiceName[\s\S]*?if \(-not \$task\) \{[\s\S]*?Register-ScheduledTask/);
  assert.match(script, /\$ServerUrl\s*=\s*'https:\/\/blueeye\.example\.dk'/);
  assert.match(script, new RegExp(`\\$SourceSha256\\s*=\\s*'${SHA}'`));
  assert.match(script, /\$AgentVersion\s*=\s*'1\.4\.0'/);
  assert.match(script, /enroll\/update\.ps1' -OutFile/); // the command it documents
});

test('renderUpdatePs1 refuses to run where there is no installed, enrolled agent', () => {
  const script = renderUpdatePs1({ serverUrl: 'http://x', sourceSha: SHA });
  // No install dir -> stop (this script cannot install one).
  assert.match(script, /no BlueEyes agent install was found/);
  assert.match(script, /only UPDATES an existing agent/);
  // Install dir but no token -> also stop: updating an unenrolled copy would
  // leave a host that never connects.
  assert.match(script, /no enrollment token was found/);
  assert.match(script, /Add agent/); // points at the real install path
  // Both checks come before anything is downloaded or changed.
  const tokenIdx = script.indexOf('no enrollment token was found');
  const downloadIdx = script.indexOf('downloading agent source');
  assert.ok(tokenIdx !== -1 && downloadIdx !== -1 && tokenIdx < downloadIdx);
});

test('renderUpdatePs1 keeps the agent identity: the state dir is never touched', () => {
  const script = renderUpdatePs1({ serverUrl: 'http://x', sourceSha: SHA });
  // Only the install dir is emptied — the token/config live in the state dir.
  assert.match(script, /Get-ChildItem -Path \$InstallDir -Force[\s\S]*?Remove-Item -Recurse -Force/);
  assert.ok(!/Remove-Item[^\n]*\$StateDir/.test(script), 'must never delete the state dir');
  assert.ok(!/Remove-Item[^\n]*\$TokenPath/.test(script), 'must never delete the token');
});

test('renderUpdatePs1 verifies the download, stops the agent, then restarts it', () => {
  const script = renderUpdatePs1({ serverUrl: 'http://x', sourceSha: SHA });
  assert.match(script, /Invoke-WebRequest -UseBasicParsing/);
  assert.match(script, /Get-FileHash -Algorithm SHA256/);
  assert.match(script, /refusing to update/); // checksum mismatch aborts
  assert.match(script, /BLUEEYE_DRY_RUN/); // same inspection hook as the installer
  const stopIdx = script.indexOf('Stop-ScheduledTask -TaskName $ServiceName');
  const extractIdx = script.indexOf('extracting the new agent source');
  const startIdx = script.indexOf('Start-ScheduledTask -TaskName $ServiceName');
  assert.ok(stopIdx !== -1 && stopIdx < extractIdx, 'stop the running agent before replacing its code');
  assert.ok(startIdx !== -1 && extractIdx < startIdx, 'start it again once the new code is in place');
  // Dependencies are reinstalled through cmd so an npm notice on stderr can't
  // trip $ErrorActionPreference='Stop'.
  assert.match(script, /cmd \/c 'npm ci --omit=dev 2>&1'/);
});

test('renderUpdatePs1 preserves the launcher it is about to delete', () => {
  const script = renderUpdatePs1({ serverUrl: 'http://x', sourceSha: SHA });
  // run-agent.cmd lives in the install dir, which is wiped — back it up first and
  // restore it, so the scheduled task keeps the environment it was installed with.
  const backupIdx = script.indexOf('$launcherBackup = Join-Path $Tmp');
  const wipeIdx = script.indexOf('Get-ChildItem -Path $InstallDir -Force');
  assert.ok(backupIdx !== -1 && backupIdx < wipeIdx, 'the launcher must be copied out before the wipe');
  assert.match(script, /Copy-Item -Path \$launcherBackup -Destination \$launcher -Force/);
});

test('renderUpdatePs1 fails clearly when the server has no source published', () => {
  const script = renderUpdatePs1({ serverUrl: 'http://x', sourceSha: '' });
  assert.match(script, /no agent source published/);
});

test('renderUpdatePs1 uses PowerShell idioms and escapes injected values', () => {
  const script = renderUpdatePs1({ serverUrl: "http://x'; rm -rf /", sourceSha: SHA });
  assert.ok(!/curl -sSL/.test(script) && !/\|\s*sh\b/.test(script));
  assert.match(script, /\$ServerUrl\s*=\s*'http:\/\/x''; rm -rf \/'/);
});
