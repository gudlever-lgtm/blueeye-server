'use strict';

// Renders the one-line PowerShell installer served at GET /enroll/:code/install.ps1.
//
// The Windows counterpart of installScript.js. Windows PowerShell cannot run the
// POSIX `curl -sSL <url>/install.sh | sh` one-liner (`curl` is an alias for
// Invoke-WebRequest with different flags, and there is no `sh`), so Windows hosts
// get their own self-contained script, which is downloaded to a file and then run
// (see winRunSteps for why it is downloaded to a file and not piped into `iex`).
//
// Like the shell installer it bakes everything in (server URL, cert fingerprint,
// one-time code, expected SHA-256 of the agent SOURCE bundle) and:
//   1. requires Node.js on the host (Windows has no pre-built binary / Docker path
//      by default) — prints a clear message with the download link and stops if absent,
//   2. downloads the agent source from the BlueEyes server itself,
//   3. verifies SHA-256 against the embedded checksum (ABORTS on mismatch),
//   4. extracts it with the built-in tar.exe (Windows 10 1803+ / Server 2019+),
//      installs production dependencies with npm,
//   5. enrolls with the embedded one-time code (pinning the cert fingerprint),
//   6. registers a Scheduled Task that runs the agent as SYSTEM at boot and
//      restarts it on failure — the dependency-free Windows equivalent of the
//      systemd unit (no service-wrapper package required).
// It is idempotent (re-running reuses the stored token) and exposes the same
// BLUEEYE_DRY_RUN hook as the shell installer so the download+verify path can be
// exercised without touching the system.
//
// Windows self-update is intentionally NOT wired into the agent: it only accepts
// the server's push-update command under systemd (see blueeye-agent runtime.js).
// A Windows host upgrades by running the UPDATE command instead — see
// renderUpdatePs1 below, served at GET /enroll/update.ps1. That script replaces
// the code of an ALREADY-ENROLLED agent in place; it never enrolls, so it needs
// no enrollment code and never produces a second agent on the server.

const { normalizeFingerprint } = require('./fingerprint');

// Single-quote for a PowerShell single-quoted string literal (the only escaping
// PowerShell does inside '...' is doubling an embedded quote). Inputs are already
// constrained (code is base64url, fingerprint hex, serverUrl a validated origin),
// but we quote defensively all the same.
function psSq(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

// The generated scripts must be pure ASCII. Windows PowerShell 5.1 decodes a
// BOM-less .ps1 in the host's ANSI code page, so a UTF-8 em-dash ("—", bytes
// E2 80 94) becomes "â€”" — and its last character, U+201D, is a quote
// character to PowerShell, which turns a comment or message into a broken
// string and the whole file into a parse error. The route also prepends a
// UTF-8 BOM, but the script text stays ASCII so it survives any transport
// (copy/paste, a browser "save as", a mail attachment). Typographic characters
// are mapped to their ASCII look-alikes. Injected values (server URL, code) are
// left as they are — an IDN hostname must not be mangled; the BOM covers those.
const ASCII_MAP = { '\u2014': '-', '\u2013': '-', '\u2026': '...', '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u00a0': ' ' };
function psAscii(script) {
  return String(script).replace(/[\u2014\u2013\u2026\u2018\u2019\u201c\u201d\u00a0]/g, (ch) => ASCII_MAP[ch]);
}

// A single-line PowerShell prelude that makes the bootstrap download of
// install.ps1 work against an on-prem server: force TLS 1.2 (5.1 defaults to
// TLS 1.0) and, when the cert fingerprint is known, pin the self-signed leaf to
// it so the bootstrap fetch is authenticated (no MITM of install.ps1) rather than
// blindly trusted. Contains NO double quotes, so it also embeds safely inside a
// `powershell -Command "…"` argument. Ends with ';' so a fetch can follow.
function winSecurityPrelude(certFingerprint) {
  const tls = '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072;';
  const fp = normalizeFingerprint(certFingerprint);
  if (!fp) return tls;
  const fpHex = fp.replace(/:/g, '').toLowerCase();
  const pin = `[Net.ServicePointManager]::ServerCertificateValidationCallback = { param($s,$c,$ch,$e) try { ((([Security.Cryptography.SHA256]::Create().ComputeHash($c.GetRawCertData()) | ForEach-Object { $_.ToString('x2') }) -join '') -eq '${fpHex}') } catch { $false } };`;
  return `${tls} ${pin}`;
}

// How an operator fetches and runs one of this server's PowerShell scripts:
// download it to a FILE, then run the file.
//
// Deliberately NOT `irm <url> | iex`. Piping a downloaded script straight into
// the interpreter — normally behind `powershell -NoProfile -ExecutionPolicy
// Bypass -Command` — is the exact shape of a PowerShell stager, so it is what
// intrusion detection and endpoint AV look for. Emerging Threats ships a rule for
// the flag combination alone ("ET ATTACK_RESPONSE PowerShell NoProfile Command
// Received In Powershell Stagers"), and it fires the moment the command text
// crosses the wire in an HTTP response — including the dashboard page that shows
// an operator the install command. The customer then sees an intrusion alert
// naming their own BlueEyes server, and the install itself gets blocked on the
// host. Both are false positives, and both are avoidable.
//
// Downloading to a file gets the same result without the stager shape: the script
// lands on disk where AMSI and antivirus can scan it, an operator can read it
// before running it, and it can be allowlisted by path. Nothing is encoded or
// hidden. The execution policy is relaxed for THIS PowerShell process only
// (-Scope Process), which needs no admin rights and leaves the machine's policy
// alone, and -NoProfile is gone: it bought nothing here, and it is the literal
// token the IPS rule matches on.
//
// Returns the two steps separately (for the dashboard, which shows them as two
// lines) plus the same thing joined into one pasteable line. Both are meant for
// an ELEVATED PowerShell prompt — unlike the old form they are not wrapped in
// `powershell -Command "…"`, so cmd.exe is not a supported host for them.
function winRunSteps({ serverUrl, path, fileName, certFingerprint = '' } = {}) {
  const url = `${String(serverUrl == null ? '' : serverUrl).replace(/\/+$/, '')}${path}`;
  const tmp = `"$env:TEMP\\${fileName}"`;
  const download = `${winSecurityPrelude(certFingerprint)} Invoke-WebRequest -UseBasicParsing -Uri '${psSq(url)}' -OutFile ${tmp}`;
  const run = `Set-ExecutionPolicy Bypass -Scope Process -Force; & ${tmp}`;
  return { url, file: `$env:TEMP\\${fileName}`, download, run, oneLiner: `${download}; ${run}` };
}

// PowerShell shared by the installer and the updater: friendly Info/Fail output,
// the TLS-1.2 + cert-pinning setup Windows PowerShell 5.1 needs against an on-prem
// server, and a download helper that explains a failure instead of dumping a .NET
// stack. Both scripts define $CertFingerprint before including this.
const PS_COMMON = `function Info([string]$m) { Write-Host "[blueeye] $m" }
# Write the reason plainly to stderr and exit non-zero. NOT Write-Error: under
# $ErrorActionPreference='Stop' that throws a WriteErrorException whose type
# headline hides the actual message - the opposite of a useful indicator.
function Fail([string]$m) { [Console]::Error.WriteLine("[blueeye] ERROR: $m"); exit 1 }

# Registering a scheduled task that runs as SYSTEM needs an elevated session.
# Check it UP FRONT - before the enrollment step consumes the one-time code - so
# a plain (non-admin) PowerShell window fails in one sentence instead of after
# "Enrolled as agent N" with Register-ScheduledTask: Access is denied.
function Assert-Elevated([string]$retry) {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail ("this script must run from an ELEVATED PowerShell (Administrator): it registers a scheduled task that runs as SYSTEM. Right-click PowerShell, choose 'Run as administrator', then re-run:" + [Environment]::NewLine + "  $retry")
  }
  # Say so in the transcript: when a later step is still denied, this line settles
  # whether elevation was the problem.
  Info "running elevated (Administrator): yes, as $($id.Name)"
}

# Windows PowerShell 5.1 still negotiates TLS 1.0 by default (which a modern
# server rejects) and refuses a self-signed certificate outright - the two most
# common on-prem failures. Force TLS 1.2, and when the server's cert fingerprint
# is known, PIN the self-signed leaf to it (SHA-256 of the DER) instead of
# disabling validation, so integrity is preserved.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
$FpHex = ($CertFingerprint -replace '[^0-9A-Fa-f]', '').ToLower()
if ($FpHex) {
  [Net.ServicePointManager]::ServerCertificateValidationCallback = {
    param($psender, $cert, $chain, $sslErrors)
    try {
      $h = [Security.Cryptography.SHA256]::Create().ComputeHash($cert.GetRawCertData())
      ((($h | ForEach-Object { $_.ToString('x2') }) -join '') -eq $FpHex)
    } catch { $false }
  }
}

# Turns a raw Invoke-WebRequest failure into an actionable message (an indicator,
# not a .NET stack): TLS-trust vs unreachable-host vs other.
function Fetch-Or-Explain([string]$url, [string]$outFile) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $outFile
  } catch {
    $m = $_.Exception.Message
    if ($m -match 'trust relationship|SSL/TLS|secure channel|certificate') {
      Fail ("could not verify the server's TLS certificate for $url. On-prem servers usually use a self-signed cert - set its SHA-256 fingerprint on the server (AGENT_CERT_FINGERPRINT) and regenerate the command so this script can pin it. Details: $m")
    } elseif ($m -match 'Unable to connect|could not be resolved|actively refused|timed out|remote name') {
      Fail ("cannot reach $url from this host - check DNS/firewall, or set BLUEEYE_PUBLIC_URL on the server to an address this machine can actually reach (a bare hostname often will not resolve). Details: $m")
    } elseif ($m -match '\(409\)') {
      Fail ("the server has repackaged the agent source since this script was generated, so the checksum baked into this script is stale. Re-run the one-liner - it downloads a fresh script carrying the current checksum.")
    } else {
      Fail "download failed for $url : $m"
    }
  }
}

# Downloads the agent source bundle and verifies it against $SourceSha256 - the
# checksum baked into THIS script when the server generated it. The script and
# the tarball arrive in two separate requests, so they can only disagree when
# something changed or was cached in between. The ?sha= query handles both: the
# URL is unique per server build, so nothing in the path can answer with an older
# tarball under it, and a server that HAS repackaged refuses with 409 instead of
# handing over bytes this script would then call corrupt.
#
# When they still disagree, ask the server what it serves right now and name the
# side that is stale. "checksum mismatch" on its own sends operators hunting for a
# broken download, which is almost never what happened.
function Get-AgentSource([string]$outFile, [string]$verb) {
  $want = $SourceSha256.ToLower()
  Info "downloading agent source from $ServerUrl/enroll/agent-source.tgz"
  Fetch-Or-Explain "$ServerUrl/enroll/agent-source.tgz?sha=$want" $outFile
  $actual = (Get-FileHash -Algorithm SHA256 -Path $outFile).Hash.ToLower()
  if ($actual -eq $want) { Info "checksum OK ($want)"; return }
  $live = ''
  try { $live = (Invoke-WebRequest -UseBasicParsing -Uri "$ServerUrl/enroll/agent-source.sha256").Content.Trim().ToLower() } catch {}
  $retry = 'Re-run the one-liner - it downloads a fresh script carrying the current checksum.'
  if ($live -and $live -eq $actual) {
    Fail ("this script is out of date: it expects agent source $want, but the server now serves $live - which is what was just downloaded." + [Environment]::NewLine + "  $retry")
  }
  if ($live -and $live -eq $want) {
    Fail ("the agent source that arrived is not what the server says it serves (expected $want, got $actual) - something between this host and the server returned a stale or altered copy. Check any proxy or cache in the path, then retry.")
  }
  $serving = if ($live) { $live } else { 'unknown (the server could not be asked)' }
  Fail ("checksum mismatch (expected $want, got $actual) - refusing to $verb." + [Environment]::NewLine + "  the server currently serves: $serving" + [Environment]::NewLine + "  $retry")
}

# The release key this host trusts, as a file, or $null when there is none.
#
# Windows pinned NO key at all before this: BLUEEYE_RELEASE_PUBLIC_KEY was absent
# from the whole installer, so a Windows agent had nothing to verify a release
# against and the update path rested entirely on a checksum fetched in a second
# request. That is the gap a cache or an inspecting proxy walked straight into.
#
# Same security order as the shell installer: provisioned out of band wins, then
# the key already pinned on this host (a re-install must never silently
# re-anchor an installed agent), then the server, which is trust-on-first-use
# and says so.
function Get-ReleaseKeyFile([string]$tmp, [string]$stateDir) {
  $dest = Join-Path $tmp 'release-key.txt'
  if ($env:BLUEEYE_RELEASE_PUBLIC_KEY) {
    Info 'release key: using the provisioned BLUEEYE_RELEASE_PUBLIC_KEY'
    Set-Content -LiteralPath $dest -Value $env:BLUEEYE_RELEASE_PUBLIC_KEY -Encoding ascii -NoNewline
    return $dest
  }
  $pinned = Join-Path $stateDir 'release-key.pem'
  if (Test-Path -LiteralPath $pinned) {
    Info 'release key: already pinned on this host - keeping it'
    Copy-Item -LiteralPath $pinned -Destination $dest -Force
    return $dest
  }
  try {
    $fromServer = (Invoke-WebRequest -UseBasicParsing -Uri "$ServerUrl/enroll/agent-release-key").Content
  } catch { $fromServer = '' }
  if (-not $fromServer) { return $null }
  Info 'release key: taken from the server (trust-on-first-use). To anchor it independently, set BLUEEYE_RELEASE_PUBLIC_KEY from an out-of-band copy.'
  Set-Content -LiteralPath $dest -Value $fromServer -Encoding ascii -NoNewline
  return $dest
}

# Stores the key so later updates verify against THIS host's pin rather than
# whatever the server hands out at the time.
function Save-ReleaseKey([string]$keyFile, [string]$stateDir) {
  if (-not $keyFile) { return }
  $pinned = Join-Path $stateDir 'release-key.pem'
  if (Test-Path -LiteralPath $pinned) { return }
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  Copy-Item -LiteralPath $keyFile -Destination $pinned -Force
  Info 'signed updates enabled (release key pinned)'
}

# Downloads the SIGNED release and accepts it only once its signature AND its
# sha256 both hold. Returns $true when $outFile now holds a release to install,
# $false when the server publishes none (fall back to the source bundle).
#
# A release that IS published and fails to verify does not return $false - it
# aborts. Falling back there would let anyone who can break the signature
# downgrade the install to the path that has no signature at all.
function Get-AgentRelease([string]$outFile, [string]$tmp, [string]$stateDir, [string]$verb) {
  $hdrFile = Join-Path $tmp 'release.hdr'
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "$ServerUrl/enroll/agent-release.tgz" -OutFile $outFile -PassThru
  } catch {
    return $false
  }
  $manifestB64 = $resp.Headers['X-Release-Manifest']
  $sigB64      = $resp.Headers['X-Release-Signature']
  $relVersion  = $resp.Headers['X-Release-Version']
  if ($manifestB64 -is [array]) { $manifestB64 = $manifestB64[0] }
  if ($sigB64 -is [array])      { $sigB64 = $sigB64[0] }
  if ($relVersion -is [array])  { $relVersion = $relVersion[0] }
  if (-not $manifestB64 -or -not $sigB64) {
    Info 'signed release: the server served one without a manifest or signature - falling back to the source bundle'
    return $false
  }

  $manifestFile = Join-Path $tmp 'release-manifest.bin'
  try {
    [IO.File]::WriteAllBytes($manifestFile, [Convert]::FromBase64String($manifestB64))
  } catch {
    Fail 'the signed release manifest could not be decoded - refusing to install'
  }

  # The sha256 the PUBLISHER put its name to. Read by pattern from the canonical
  # manifest (keys sorted, no whitespace) and required to be exactly 64 hex, so a
  # truncated or decorated value fails rather than matching something shorter.
  $manifestText = [IO.File]::ReadAllText($manifestFile)
  $m = [regex]::Match($manifestText, '"sha256":"([0-9a-f]{64})"')
  if (-not $m.Success) { Fail 'the signed release manifest carries no usable sha256 - refusing to install' }
  $want = $m.Groups[1].Value

  $actual = (Get-FileHash -Algorithm SHA256 -Path $outFile).Hash.ToLower()
  if ($actual -ne $want) {
    Fail ("the signed release that arrived does not match its own signed manifest (manifest says $want, got $actual) - something between this host and the server altered or cached it. Refusing to $verb.")
  }

  $sigFile = Join-Path $tmp 'release.sig.b64'
  Set-Content -LiteralPath $sigFile -Value $sigB64 -Encoding ascii -NoNewline
  $keyFile = Get-ReleaseKeyFile $tmp $stateDir

  if (-not $keyFile) {
    if ($env:BLUEEYE_REQUIRE_SIGNED_INSTALL) {
      Fail 'BLUEEYE_REQUIRE_SIGNED_INSTALL is set, but this host has no release key to verify against - refusing.'
    }
    Info ("signed release v$relVersion" + ': sha256 matches its manifest, but there is no key here to check the SIGNATURE against. Set BLUEEYE_REQUIRE_SIGNED_INSTALL=1 to refuse instead.')
    return $true
  }

  # Node is a hard requirement on Windows (the agent runs on it), so unlike the
  # shell installer there is always a verifier - no "could not check" branch.
  $verifier = Join-Path $tmp 'verify.js'
  $verifierJs = @'
'use strict';
const fs = require('fs');
const crypto = require('crypto');
try {
  const [manifestFile, signatureFile, keyFile] = process.argv.slice(2);
  if (!manifestFile || !signatureFile || !keyFile) process.exit(2);
  let key = fs.readFileSync(keyFile, 'utf8').trim();
  if (key.indexOf('-----BEGIN') !== 0) key = Buffer.from(key, 'base64').toString('utf8');
  const ok = crypto.verify(
    null,
    fs.readFileSync(manifestFile),
    crypto.createPublicKey(key),
    Buffer.from(fs.readFileSync(signatureFile, 'utf8').trim(), 'base64')
  );
  process.exit(ok ? 0 : 1);
} catch (err) {
  process.exit(2);
}
'@
  Set-Content -LiteralPath $verifier -Value $verifierJs -Encoding ascii
  & $NodeExe $verifier $manifestFile $sigFile $keyFile 2>&1 | Out-Null
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    Info ("signed release v$relVersion" + ': signature verified, sha256 matches its manifest')
    Save-ReleaseKey $keyFile $stateDir
    return $true
  }
  if ($code -eq 1) {
    Fail ("the signed release v$relVersion did NOT pass signature verification against the key this host trusts - refusing to $verb. If the server's signing key was rotated, re-pin this host (Settings -> Updates shows the command).")
  }
  Fail ("the signed release v$relVersion could not be verified on this host (the verifier could not run) - refusing to $verb.")
}`;

// Stops a running agent before its code is replaced. On an upgrade the old process
// keeps the PREVIOUS version loaded and holds file locks in the install dir; a
// Scheduled Task also ignores a second Start while one instance is live
// (MultipleInstances = IgnoreNew), so leaving it running means the new code lands
// on disk but never runs — the dashboard would keep showing the old version.
//
// WHY THIS WAITS INSTEAD OF SLEEPING. "I have to run the update twice" was this:
// the stop was fire-and-forget (Stop-ScheduledTask does not wait, Stop-Process
// does not wait) followed by a flat two-second sleep. On a host where node took
// longer than that to go, the old process still held its files, the delete below
// failed SILENTLY (-ErrorAction SilentlyContinue), tar unpacked over a directory
// that still had the old tree in it, and the scheduled task then refused the
// Start because an instance was still live. Nothing failed loudly, so the script
// printed "done" — and the second run worked only because the FIRST run's kill
// had finally taken effect by then.
//
// So: ask, then WAIT until it is actually gone, and say so if it is not. A
// process that will not die is a real failure and the operator needs to hear
// about it before the code is replaced, not after.
const PS_STOP_RUNNING = `Info "stopping any running '$ServiceName' before replacing the code ..."
try { Stop-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue | Out-Null } catch {}

# Every node.exe belonging to THIS install: matched on the command line and on
# the image path, because a process whose command line we may not read (access
# denied) is exactly the one still holding the files.
function Get-AgentProcs {
  try {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        ($_.CommandLine -and $_.CommandLine -like "*$InstallDir*") -or
        ($_.ExecutablePath -and $_.ExecutablePath -like "$InstallDir*")
      }
  } catch { @() }
}

$deadline = (Get-Date).AddSeconds(45)
while ($true) {
  $procs = @(Get-AgentProcs)
  $taskState = $null
  try { $taskState = (Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue).State } catch {}
  if ($procs.Count -eq 0 -and $taskState -ne 'Running') { break }
  if ((Get-Date) -gt $deadline) {
    $ids = ($procs | ForEach-Object { $_.ProcessId }) -join ', '
    Fail ("the running agent did not stop within 45s (task state '$taskState'" +
      $(if ($ids) { ", node.exe PID $ids" } else { '' }) + ")." + [Environment]::NewLine +
      'Its files are still locked, so replacing the code now would leave a half-updated agent.' + [Environment]::NewLine +
      "Stop it by hand and run this again:  Stop-ScheduledTask -TaskName '$ServiceName'")
  }
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
  }
  Start-Sleep -Milliseconds 500
}
Info 'the agent is stopped.'`;

// Empties the install dir, and MEANS it. The old code swallowed every error
// here, which is how a locked file turned into a silent half-update. A file
// still in use right after the stop is usually an antivirus or an indexer with
// the handle open for another moment, so this retries briefly and then reports
// exactly which file is stuck rather than unpacking on top of it.
const PS_CLEAR_INSTALL_DIR = `$clearDeadline = (Get-Date).AddSeconds(20)
while ($true) {
  $stuck = @()
  # A plain foreach over a materialised list, not a ForEach-Object pipeline: the
  # scoping of an assignment inside a pipeline script block is the kind of detail
  # that decides whether this loop can ever terminate.
  $entries = @(Get-ChildItem -Path $InstallDir -Force -ErrorAction SilentlyContinue)
  foreach ($entry in $entries) {
    try { Remove-Item -LiteralPath $entry.FullName -Recurse -Force -ErrorAction Stop }
    catch { $stuck = $stuck + $entry.FullName }
  }
  if ($stuck.Count -eq 0) { break }
  if ((Get-Date) -gt $clearDeadline) {
    $names = ($stuck | Select-Object -First 5) -join ', '
    Fail ("could not empty $InstallDir - still locked: $names" + [Environment]::NewLine +
      'Something has the old agent open (antivirus, an editor, a second node.exe). Close it and run this again.')
  }
  Start-Sleep -Milliseconds 500
}`;

function renderInstallPs1({
  serverUrl,
  code,
  certFingerprint = '',
  sourceSha = '',
  serviceName = 'blueeye-agent',
  agentVersion = '',
} = {}) {
  const fp = normalizeFingerprint(certFingerprint);
  // The commands this script prints back to the operator (how it was started, how
  // to undo it). Built here rather than assembled from $ServerUrl at runtime so
  // they are byte-for-byte the ones the dashboard shows — and so the script body
  // itself never carries an `irm … | iex` stager pattern for an IPS to flag on its
  // way to the host. They go into single-quoted PowerShell literals, so the
  // $env:TEMP in them stays literal instead of expanding as the line is printed.
  const installCmd = winRunSteps({ serverUrl, path: `/enroll/${code}/install.ps1`, fileName: 'blueeye-install.ps1', certFingerprint }).oneLiner;
  const uninstallCmd = winRunSteps({ serverUrl, path: '/enroll/uninstall.ps1', fileName: 'blueeye-uninstall.ps1', certFingerprint }).oneLiner;
  // NB: written to avoid JS template-literal collisions — PowerShell `$var` is
  // fine (only `${` would interpolate in JS, and we never use PS brace-vars), and
  // no backticks are used (PowerShell's line-continuation char clashes with the
  // template literal). Injected values go through psSq() + single quotes.
  return psAscii(`#Requires -Version 5.1
# BlueEyes agent installer (Windows) - generated by blueeye-server. Do not edit by hand.
#
# Run from an ELEVATED PowerShell (Administrator):
#   ${installCmd}
#
# Everything needed is embedded below: the server URL, the certificate fingerprint
# to pin, your one-time enrollment code and the expected SHA-256 of the agent
# SOURCE bundle. The agent is downloaded from the BlueEyes server itself (no GitHub,
# no registry) and run with native Node.js under a Scheduled Task.
$ErrorActionPreference = 'Stop'

$ServerUrl       = '${psSq(serverUrl)}'
$EnrollCode      = '${psSq(code)}'
$CertFingerprint = '${psSq(fp)}'
$SourceSha256    = '${psSq(sourceSha)}'
$ServiceName     = '${psSq(serviceName)}'
$AgentVersion    = '${psSq(agentVersion)}'

$InstallDir = if ($env:BLUEEYE_INSTALL_DIR) { $env:BLUEEYE_INSTALL_DIR } else { Join-Path $env:ProgramData 'BlueEyes\\agent' }
$StateDir   = if ($env:BLUEEYE_STATE_DIR)   { $env:BLUEEYE_STATE_DIR }   else { Join-Path $env:ProgramData 'BlueEyes\\state' }
$LogDir     = if ($env:BLUEEYE_LOG_DIR)     { $env:BLUEEYE_LOG_DIR }     else { Join-Path $env:ProgramData 'BlueEyes\\logs' }
$TokenPath  = Join-Path $StateDir 'token'
$ConfigPath = Join-Path $StateDir 'config.json'

${PS_COMMON}

Assert-Elevated '${psSq(installCmd)}'

if (-not $SourceSha256) {
  Fail 'the BlueEyes server has no agent source published - set AGENT_SOURCE_DIR on the server (see docs/enrollment.md), then retry'
}

# Node.js is required (the Windows install has no binary/Docker fallback).
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail ("Node.js was not found on this host. Install Node.js 18+ from https://nodejs.org/ (or 'winget install OpenJS.NodeJS.LTS'), reopen PowerShell, then re-run:" + [Environment]::NewLine +
        '  ${psSq(installCmd)}')
}
$NodeExe = $node.Source

# tar.exe ships in Windows 10 1803+ / Server 2019+; it extracts .tgz directly.
$tar = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tar) {
  Fail 'tar.exe was not found - Windows 10 1803+ or Server 2019+ is required (it provides the built-in tar used to unpack the agent).'
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('blueeye-' + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
  # Show how to undo this right up front, so an operator who needs to bail out (a
  # failed/partial install, a wrong host) always has the removal command to hand -
  # without hunting for it at the very end of a long install.
  Info ('to remove the agent at any time, run (elevated):  ${psSq(uninstallCmd)}')

  # THE SIGNED RELEASE FIRST. It is a fixed artefact: published once, never
  # repackaged, and carrying its own signed manifest - so its checksum does not
  # move under the installer, and the sha256 it is judged by travels WITH the
  # bytes instead of arriving in a second request a cache can answer on its own.
  $Tarball = Join-Path $Tmp 'agent-release.tgz'
  if (-not (Get-AgentRelease $Tarball $Tmp $StateDir 'install')) {
    Info 'no signed release published on this server - using the source bundle'
    $Tarball = Join-Path $Tmp 'agent-source.tgz'
    Get-AgentSource $Tarball 'install'
  }

  # Inspection/test mode: verified, nothing written to the system yet.
  if ($env:BLUEEYE_DRY_RUN) { Info 'dry-run: verified, stopping before install'; exit 0 }

  # Stop any running instance BEFORE replacing the code (see PS_STOP_RUNNING).
  ${PS_STOP_RUNNING.split('\n').join('\n  ')}

  # Lay the agent out fresh under the install dir (a re-run replaces the code but
  # keeps the token/config in the separate state dir, so it stays idempotent).
  New-Item -ItemType Directory -Force -Path $InstallDir, $StateDir, $LogDir | Out-Null
  ${PS_CLEAR_INSTALL_DIR.split('\n').join('\n  ')}

  Info "extracting agent source to $InstallDir"
  & $tar.Source -xzf $Tarball -C $InstallDir
  if ($LASTEXITCODE -ne 0) { Fail 'could not extract the agent source (tar)' }

  $version = $AgentVersion
  if (-not $version) {
    try { $version = (Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json).version } catch { $version = 'unknown' }
  }

  Info "installing dependencies (npm) for v$version ..."
  Push-Location $InstallDir
  try {
    # Run npm via cmd.exe with cmd's own 2>&1 merge. npm writes notices/warnings to
    # stderr, and on Windows npm resolves to the npm.ps1 shim: piping its stderr
    # back into PowerShell (2>&1) under $ErrorActionPreference='Stop' turns the very
    # first npm-notice line into a terminating NativeCommandError even on success.
    # Letting cmd merge the streams means PowerShell only sees stdout - no phantom
    # error - and we judge success by the real process exit code.
    $npmOut = & cmd /c 'npm ci --omit=dev 2>&1'
    if ($LASTEXITCODE -ne 0) { $npmOut = & cmd /c 'npm install --omit=dev 2>&1' }
    if ($LASTEXITCODE -ne 0) {
      Info 'npm failed - last lines of its output:'
      $npmOut | Select-Object -Last 25 | ForEach-Object { Write-Host "  $_" }
      Fail 'dependency install failed (npm) - see the npm output above'
    }
  } finally { Pop-Location }

  # Enroll once - idempotent: the agent skips enrollment when a token already
  # exists. Token/config live in the state dir so a re-run/upgrade never loses them.
  Info 'enrolling with the BlueEyes server ...'
  $env:BLUEEYE_TOKEN_PATH = $TokenPath
  $env:BLUEEYE_AGENT_CONFIG = $ConfigPath
  $env:BLUEEYE_SERVER_CERT_FINGERPRINT = $CertFingerprint
  $enrollArgs = @((Join-Path $InstallDir 'src\\index.js'), 'enroll', '--code', $EnrollCode, '--server', $ServerUrl)
  if ($CertFingerprint) { $enrollArgs += @('--fingerprint', $CertFingerprint) }
  & $NodeExe @enrollArgs
  $enrollExit = $LASTEXITCODE
  # Trust the RESULT, not just the exit code. Enrollment writes the token before
  # the process exits; some hosts (notably older agents on Windows) can abort node
  # on the way out AFTER that write, on a libuv teardown race, leaving a non-zero
  # exit code on a genuinely successful enrollment. If the token file is present
  # and non-empty, the agent is enrolled - proceed (with a note) instead of forcing
  # a pointless re-run. Only a MISSING/empty token is a real failure.
  $tokenOk = (Test-Path $TokenPath) -and ((Get-Item $TokenPath -ErrorAction SilentlyContinue).Length -gt 0)
  if ($enrollExit -ne 0) {
    if ($tokenOk) {
      Info "enroll process exited with code $enrollExit, but a token was stored at $TokenPath - treating enrollment as successful (this is a known exit-time crash, harmless here)."
    } else {
      Fail "enrollment failed (node exited with code $enrollExit and no token was written to $TokenPath)"
    }
  } elseif (-not $tokenOk) {
    Fail "enrollment reported success but no token was written to $TokenPath - refusing to register a non-working agent"
  }

  # Launcher .cmd carries the environment the agent needs at boot (a Scheduled
  # Task action cannot set env vars itself) - the Windows analogue of the
  # systemd unit's Environment= lines.
  $launcher = Join-Path $InstallDir 'run-agent.cmd'
  $AgentLog = Join-Path $LogDir 'agent.log'
  # The Scheduled Task runs as SYSTEM with no console, so the agent's stdout/stderr
  # would otherwise vanish (and "installed but not connected" has no indicator).
  # Redirect both to agent.log with a timestamped start marker, so a failure to
  # launch node, reach the server, or a rejected token is visible on the host.
  $launcherLines = @(
    '@echo off',
    "set ""BLUEEYE_SERVER_URL=$ServerUrl""",
    "set ""BLUEEYE_SERVER_CERT_FINGERPRINT=$CertFingerprint""",
    "set ""BLUEEYE_TOKEN_PATH=$TokenPath""",
    "set ""BLUEEYE_AGENT_CONFIG=$ConfigPath""",
    "set ""BLUEEYE_ACTION_LOG=$(Join-Path $LogDir 'actions.log')""",
    'set "BLUEEYE_RUNTIME=unmanaged"',
    "cd /d ""$InstallDir""",
    "echo [%DATE% %TIME%] starting blueeye-agent >> ""$AgentLog""",
    """$NodeExe"" ""$(Join-Path $InstallDir 'src\\index.js')"" >> ""$AgentLog"" 2>&1"
  )
  Set-Content -Path $launcher -Value $launcherLines -Encoding ASCII

  # Register (or replace) a Scheduled Task: run as SYSTEM at startup, restart on
  # failure - the dependency-free equivalent of the systemd service.
  Info "registering scheduled task '$ServiceName' (runs at boot as SYSTEM) ..."
  $action    = New-ScheduledTaskAction -Execute $launcher
  $trigger   = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  # -ErrorAction Stop is explicit: the ScheduledTasks cmdlets come from a CDXML
  # module with its own $ErrorActionPreference, so the script-level 'Stop' does
  # not reach them and a denied registration would otherwise scroll past while
  # the script carries on to Start-ScheduledTask ("cannot find the file").
  try {
    Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $ServiceName -ErrorAction Stop
  } catch {
    $why = $_.Exception.Message
    $hint = ''
    if ($why -match 'Access is denied') {
      # Elevation was verified above, so a denial here comes from the Task
      # Scheduler side: its service stopped/disabled, or a policy/ACL on the task
      # store (C:\Windows\System32\Tasks). Show what can be seen from here.
      $svc = Get-Service -Name Schedule -ErrorAction SilentlyContinue
      $svcState = if ($svc) { "$($svc.Status) (StartType $($svc.StartType))" } else { 'not found' }
      $hint = " This session IS elevated, so the denial comes from Task Scheduler itself: service 'Schedule' is $svcState (it must be Running); a Group Policy or a damaged ACL on C:\Windows\System32\Tasks can also deny task creation - check that folder's permissions for SYSTEM/Administrators, and 'Event Viewer > Microsoft > Windows > TaskScheduler > Operational' for the denied registration."
    }
    Fail ("could not register/start scheduled task '$ServiceName': $why.$hint The agent is enrolled (token at $TokenPath) but has no service yet - fix the cause and re-run this script from an ELEVATED PowerShell (Administrator); enrollment is skipped when the token already exists.")
  }

  # Give the agent a moment to boot and show what it logged, so the operator sees
  # right away whether it connected - rather than "installed OK" with no signal.
  Start-Sleep -Seconds 4
  if (Test-Path $AgentLog) {
    Info 'first lines from the agent log:'
    Get-Content $AgentLog -Tail 20 | ForEach-Object { Write-Host "  $_" }
  } else {
    Info "the agent has not written a log yet - check $AgentLog in a moment."
  }

  # Connection self-test: run the agent's built-in doctor so the install ends with
  # a clear CONNECTED / NOT-CONNECTED verdict and fix suggestions, instead of a
  # silent "installed OK". Informational only - its exit code never fails the
  # install (and an older agent source without 'doctor' just prints usage).
  Info 'running connection self-test (blueeye-agent doctor) ...'
  $env:BLUEEYE_SERVER_URL = $ServerUrl
  & $NodeExe (Join-Path $InstallDir 'src\\index.js') doctor

  Info "done - agent v$version enrolled; scheduled task '$ServiceName' started."
  Info "live log:  Get-Content '$AgentLog' -Wait -Tail 30"
  Info "task state:  Get-ScheduledTask $ServiceName | Get-ScheduledTaskInfo"
  Info "manage it:  Stop-ScheduledTask $ServiceName  |  Start-ScheduledTask $ServiceName"
  # The false literal below is backtick-escaped so PowerShell prints it verbatim:
  # an un-escaped false inside this double-quoted string expands to the word
  # "False", producing a broken "-Confirm:False" the operator cannot run.
  Info ('remove it:  ${psSq(uninstallCmd)}' + "  (or: Unregister-ScheduledTask -TaskName $ServiceName -Confirm:\`$false ; Remove-Item -Recurse -Force '$InstallDir','$StateDir')")
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
`);
}

// The Windows UPDATER (PowerShell), served at GET /enroll/update.ps1 — what the
// dashboard's "Update" button hands an operator for a Windows agent that is behind.
//
// It upgrades an agent that is ALREADY on this host, in place:
//   1. refuses to run unless an enrolled agent is present (install dir + a
//      non-empty token) — so a stray paste can never create a second agent,
//   2. downloads the agent SOURCE bundle from this server and verifies its
//      embedded SHA-256 (ABORTS on mismatch),
//   3. stops the scheduled task, replaces the CODE in the install dir (the state
//      dir with token/config is never touched — no enrollment, no new code),
//   4. reinstalls production dependencies and starts the task again.
// No enrollment code is involved, which is exactly what makes it an update rather
// than an install: the agent keeps its identity and reappears in the dashboard on
// the new version. Honours the same BLUEEYE_INSTALL_DIR / _STATE_DIR / _LOG_DIR
// overrides and the same BLUEEYE_DRY_RUN inspection hook as the installer.
function renderUpdatePs1({
  serverUrl,
  certFingerprint = '',
  sourceSha = '',
  serviceName = 'blueeye-agent',
  agentVersion = '',
} = {}) {
  const fp = normalizeFingerprint(certFingerprint);
  const updateCmd = winRunSteps({ serverUrl, path: '/enroll/update.ps1', fileName: 'blueeye-update.ps1', certFingerprint }).oneLiner;
  return psAscii(`#Requires -Version 5.1
# BlueEyes agent updater (Windows) - generated by blueeye-server. Do not edit by hand.
#
# Run from an ELEVATED PowerShell (Administrator) on a host that ALREADY runs the agent:
#   ${updateCmd}
#
# Updates the installed agent in place. It does NOT enroll and does NOT need an
# enrollment code: the token and config in the state dir are left untouched, so the
# host keeps its existing agent identity instead of appearing as a new agent.
$ErrorActionPreference = 'Stop'

$ServerUrl       = '${psSq(serverUrl)}'
$CertFingerprint = '${psSq(fp)}'
$SourceSha256    = '${psSq(sourceSha)}'
$ServiceName     = '${psSq(serviceName)}'
$AgentVersion    = '${psSq(agentVersion)}'

$InstallDir = if ($env:BLUEEYE_INSTALL_DIR) { $env:BLUEEYE_INSTALL_DIR } else { Join-Path $env:ProgramData 'BlueEyes\\agent' }
$StateDir   = if ($env:BLUEEYE_STATE_DIR)   { $env:BLUEEYE_STATE_DIR }   else { Join-Path $env:ProgramData 'BlueEyes\\state' }
$LogDir     = if ($env:BLUEEYE_LOG_DIR)     { $env:BLUEEYE_LOG_DIR }     else { Join-Path $env:ProgramData 'BlueEyes\\logs' }
$TokenPath  = Join-Path $StateDir 'token'
$ConfigPath = Join-Path $StateDir 'config.json'

${PS_COMMON}

Assert-Elevated '${psSq(updateCmd)}'

if (-not $SourceSha256) {
  Fail 'the BlueEyes server has no agent source published - set AGENT_SOURCE_DIR on the server (see docs/enrollment.md), then retry'
}

# UPDATE ONLY. Without an enrolled agent here there is nothing to upgrade, and this
# script cannot enroll one (it carries no enrollment code) - so say so plainly
# rather than leaving a half-installed, never-connecting copy behind.
if (-not (Test-Path (Join-Path $InstallDir 'package.json'))) {
  Fail ("no BlueEyes agent install was found at $InstallDir - this script only UPDATES an existing agent." + [Environment]::NewLine +
        "  To install the agent on this host, use 'Add agent' in the dashboard and run the install command it gives you.")
}
$tokenOk = (Test-Path $TokenPath) -and ((Get-Item $TokenPath -ErrorAction SilentlyContinue).Length -gt 0)
if (-not $tokenOk) {
  Fail ("no enrollment token was found at $TokenPath - this host has an agent directory but is not enrolled, so there is nothing to update." + [Environment]::NewLine +
        "  Use 'Add agent' in the dashboard and run the install command it gives you.")
}

$Before = 'unknown'
try { $Before = (Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json).version } catch {}
Info "found an enrolled agent v$Before at $InstallDir (identity kept: $TokenPath)"
if ($AgentVersion) { Info "the server publishes v$AgentVersion" }

# Node.js is required (the Windows install runs the agent with native Node).
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail ("Node.js was not found on this host. Install Node.js 18+ from https://nodejs.org/ (or 'winget install OpenJS.NodeJS.LTS'), reopen PowerShell, then re-run:" + [Environment]::NewLine +
        '  ${psSq(updateCmd)}')
}
$NodeExe = $node.Source

$tar = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tar) {
  Fail 'tar.exe was not found - Windows 10 1803+ or Server 2019+ is required (it provides the built-in tar used to unpack the agent).'
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('blueeye-update-' + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
  # Signed release first - see the note in the installer. On an update this also
  # verifies against the key THIS host pinned at install time, not one fetched
  # from the server now.
  $Tarball = Join-Path $Tmp 'agent-release.tgz'
  if (-not (Get-AgentRelease $Tarball $Tmp $StateDir 'update')) {
    Info 'no signed release published on this server - using the source bundle'
    $Tarball = Join-Path $Tmp 'agent-source.tgz'
    Get-AgentSource $Tarball 'update'
  }

  # Inspection/test mode: verified, nothing on the host has been touched yet.
  if ($env:BLUEEYE_DRY_RUN) { Info 'dry-run: verified, stopping before the update'; exit 0 }

  ${PS_STOP_RUNNING.split('\n').join('\n  ')}

  # The launcher .cmd carries the environment the scheduled task starts the agent
  # with, and it lives in the install dir we are about to replace - keep the exact
  # one this host was installed with, so the update changes the CODE and nothing else.
  $launcher = Join-Path $InstallDir 'run-agent.cmd'
  $launcherBackup = $null
  if (Test-Path $launcher) {
    $launcherBackup = Join-Path $Tmp 'run-agent.cmd'
    Copy-Item -Path $launcher -Destination $launcherBackup -Force
  }

  # Replace the code only. $StateDir (token + config) is a separate directory and
  # is deliberately left alone - that is what keeps this the SAME agent.
  New-Item -ItemType Directory -Force -Path $InstallDir, $LogDir | Out-Null
  ${PS_CLEAR_INSTALL_DIR.split('\n').join('\n  ')}

  Info "extracting the new agent source to $InstallDir"
  & $tar.Source -xzf $Tarball -C $InstallDir
  if ($LASTEXITCODE -ne 0) { Fail 'could not extract the agent source (tar)' }

  $version = $AgentVersion
  if (-not $version) {
    try { $version = (Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json).version } catch { $version = 'unknown' }
  }

  Info "installing dependencies (npm) for v$version ..."
  Push-Location $InstallDir
  try {
    # Via cmd.exe with cmd's own 2>&1 merge: npm writes notices to stderr, and
    # piping that back into PowerShell under $ErrorActionPreference='Stop' turns the
    # first notice into a terminating NativeCommandError even on success.
    $npmOut = & cmd /c 'npm ci --omit=dev 2>&1'
    if ($LASTEXITCODE -ne 0) { $npmOut = & cmd /c 'npm install --omit=dev 2>&1' }
    if ($LASTEXITCODE -ne 0) {
      Info 'npm failed - last lines of its output:'
      $npmOut | Select-Object -Last 25 | ForEach-Object { Write-Host "  $_" }
      Fail 'dependency install failed (npm) - see the npm output above'
    }
  } finally { Pop-Location }

  $AgentLog = Join-Path $LogDir 'agent.log'
  if ($launcherBackup) {
    Copy-Item -Path $launcherBackup -Destination $launcher -Force
  } else {
    # No launcher to preserve (a hand-rolled install): write the standard one so the
    # scheduled task below has something to start, with the same environment the
    # installer bakes in. The token/config paths still point at the existing state.
    $launcherLines = @(
      '@echo off',
      "set ""BLUEEYE_SERVER_URL=$ServerUrl""",
      "set ""BLUEEYE_SERVER_CERT_FINGERPRINT=$CertFingerprint""",
      "set ""BLUEEYE_TOKEN_PATH=$TokenPath""",
      "set ""BLUEEYE_AGENT_CONFIG=$ConfigPath""",
      "set ""BLUEEYE_ACTION_LOG=$(Join-Path $LogDir 'actions.log')""",
      'set "BLUEEYE_RUNTIME=unmanaged"',
      "cd /d ""$InstallDir""",
      "echo [%DATE% %TIME%] starting blueeye-agent >> ""$AgentLog""",
      """$NodeExe"" ""$(Join-Path $InstallDir 'src\\index.js')"" >> ""$AgentLog"" 2>&1"
    )
    Set-Content -Path $launcher -Value $launcherLines -Encoding ASCII
  }

  # The scheduled task normally already exists and points at the launcher - only
  # (re)register it when it is missing, so an update never rewrites a task an
  # operator has tuned.
  $task = Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
  if (-not $task) {
    Info "scheduled task '$ServiceName' was missing - registering it again (runs at boot as SYSTEM) ..."
    $action    = New-ScheduledTaskAction -Execute $launcher
    $trigger   = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    try {
      Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
    } catch {
      Fail "could not register scheduled task '$ServiceName': $($_.Exception.Message)"
    }
  }

  Info "starting '$ServiceName' on the new code ..."
  # -ErrorAction Stop is explicit (CDXML module, own $ErrorActionPreference).
  try {
    Start-ScheduledTask -TaskName $ServiceName -ErrorAction Stop
  } catch {
    Fail "could not start scheduled task '$ServiceName': $($_.Exception.Message)"
  }

  # Start-ScheduledTask reports success for a task the scheduler then IGNORES
  # (MultipleInstances = IgnoreNew) and for an action that dies on the first
  # line. Neither is an error it raises, so "updated" has to be something this
  # script SEES rather than something it assumes: wait for the new process to
  # actually appear.
  $upDeadline = (Get-Date).AddSeconds(20)
  $running = $false
  while ((Get-Date) -lt $upDeadline) {
    if (@(Get-AgentProcs).Count -gt 0) { $running = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $running) {
    Info "the agent has not come up within 20s of starting '$ServiceName'."
    if (Test-Path $AgentLog) {
      Info 'last lines of the agent log:'
      Get-Content $AgentLog -Tail 20 | ForEach-Object { Write-Host "  $_" }
    }
    Fail ("the new code is installed but the agent is not running." + [Environment]::NewLine +
      "Check:  Get-ScheduledTask '$ServiceName' | Get-ScheduledTaskInfo   (LastTaskResult tells you why)" + [Environment]::NewLine +
      "Log:    Get-Content '$AgentLog' -Tail 50")
  }

  # Show what the agent logged right after the restart, so the operator sees it
  # come back up instead of a bare "updated OK".
  Start-Sleep -Seconds 2
  if (Test-Path $AgentLog) {
    Info 'latest lines from the agent log:'
    Get-Content $AgentLog -Tail 20 | ForEach-Object { Write-Host "  $_" }
  } else {
    Info "the agent has not written a log yet - check $AgentLog in a moment."
  }

  Info "done - updated from v$Before to v$version (same agent, same enrollment)."
  Info 'the dashboard shows the new version as soon as the agent reconnects.'
  Info "live log:  Get-Content '$AgentLog' -Wait -Tail 30"
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
`);
}

// The Windows uninstaller (PowerShell), served at GET /enroll/uninstall.ps1 — the
// analogue of the Linux uninstall.sh, so a Windows host is never sent a bash
// `curl … | sudo sh` to remove the agent. No enrollment code needed. Idempotent
// and best-effort (never throws on a missing task/dir). Honours the same
// BLUEEYE_INSTALL_DIR / _STATE_DIR / _LOG_DIR overrides as the installer.
function renderUninstallPs1({ serviceName = 'blueeye-agent' } = {}) {
  return psAscii(`#Requires -Version 5.1
# BlueEyes agent uninstaller (Windows) - generated by blueeye-server.
# Run from an ELEVATED PowerShell (Administrator):
#   Invoke-WebRequest -UseBasicParsing -Uri '<server>/enroll/uninstall.ps1' -OutFile "$env:TEMP\\blueeye-uninstall.ps1"; Set-ExecutionPolicy Bypass -Scope Process -Force; & "$env:TEMP\\blueeye-uninstall.ps1"
$ErrorActionPreference = 'Continue'

$ServiceName = '${psSq(serviceName)}'
$InstallDir = if ($env:BLUEEYE_INSTALL_DIR) { $env:BLUEEYE_INSTALL_DIR } else { Join-Path $env:ProgramData 'BlueEyes\\agent' }
$StateDir   = if ($env:BLUEEYE_STATE_DIR)   { $env:BLUEEYE_STATE_DIR }   else { Join-Path $env:ProgramData 'BlueEyes\\state' }
$LogDir     = if ($env:BLUEEYE_LOG_DIR)     { $env:BLUEEYE_LOG_DIR }     else { Join-Path $env:ProgramData 'BlueEyes\\logs' }

function Info([string]$m) { Write-Host "[blueeye] $m" }

# Unregistering the SYSTEM task and removing ProgramData dirs needs elevation;
# every step below is best-effort, so without this check a plain window would
# "finish" having removed nothing.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  [Console]::Error.WriteLine("[blueeye] ERROR: this script must run from an ELEVATED PowerShell (Administrator). Right-click PowerShell, choose 'Run as administrator', then re-run it.")
  exit 1
}

Info "stopping and removing scheduled task '$ServiceName' ..."
Stop-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue | Out-Null
Unregister-ScheduledTask -TaskName $ServiceName -Confirm:\$false -ErrorAction SilentlyContinue | Out-Null

# Stop any agent node.exe still holding the install dir open (the service AND any
# foreground diagnosis run) - otherwise Remove-Item fails with "in use". Match on
# the BlueEyes path so a foreground 'node ...\\index.js doctor' is caught too, then
# wait a moment for the file handles to release.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like '*BlueEyes*') } |
  ForEach-Object { Info "stopping agent process $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# Remove the folders, retrying briefly in case a handle is still releasing.
foreach ($d in @($InstallDir, $StateDir, $LogDir)) {
  for ($i = 0; ($i -lt 3) -and (Test-Path $d); $i++) {
    Info "removing $d"
    Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
    if (Test-Path $d) { Start-Sleep -Seconds 2 }
  }
}

$leftover = @($InstallDir, $StateDir, $LogDir) | Where-Object { Test-Path $_ }
if ($leftover) {
  Info "could not fully remove: $($leftover -join ', '). Close any window running the agent (a foreground 'node' or a live-log tail), then re-run this uninstaller."
} else {
  Info 'BlueEyes agent removed from this host. (Node.js itself was left installed.)'
}
`);
}

module.exports = { renderInstallPs1, renderUpdatePs1, winSecurityPrelude, winRunSteps, renderUninstallPs1 };
