# Frictionless agent enrollment

Goal: adding an agent should be **one command**, where the only thing the user
touches is the enrollment code. Server URL, certificate fingerprint and the
source-bundle checksum are all supplied by the server — never typed by hand.

This builds on the existing enrollment-code → opaque-token flow (it does **not**
replace it):

- `enrollment_codes` (short-lived, now optionally multi-use) → `POST /agents/enroll`
  exchanges a code for an opaque agent token (hash stored, plaintext returned once).
- The agent then connects over the existing `/ws/agent` WebSocket and reports in.

## The flow

1. Operator opens **Enrollment → Add agent** and clicks *Generate code & command*.
   The UI calls `GET /api/enroll/command`.
2. The operator copies the one-liner and runs it on the target machine.
3. The script downloads the agent **source bundle from this server**, verifies its
   SHA-256, then installs it — **native Node + systemd by default**, Docker opt-in:
   - **Node ≥18** (default): lays the agent out under `/opt/blueeye-agent/releases/<v>`
     with a `current` symlink (state in `/var/lib/blueeye-agent`, logs in
     `/var/log/blueeye-agent`), fetches + pins the release public key, runs
     `blueeye-agent enroll --code …`, and installs a systemd service running from
     `current`. Enrollment runs *before* the service starts, so a bad/expired code
     fails the install cleanly instead of leaving a crash-looping service.
   - **Docker** (opt-in, `BLUEEYE_RUNTIME=docker`): `docker build` + `docker run`
     (host networking); the container enrolls itself from the embedded code and
     persists its token on a named volume. (Docker agents don't self-update — the
     host rebuilds them.)
   - else (no Node, and Docker not requested) it prints how to install a runtime
     and stops — it never dead-ends.
4. The agent connects; the enrollment screen flips **”Waiting for agent…” →
   “Connected ✓”** live (over the dashboard WebSocket).

**No pre-built binaries are published or required.** The agent is plain Node, so
the installer ships its *source* and runs it on the target. The Node path produces
the **same versioned `releases/<v>` + `current` layout** as
`scripts/install-systemd.sh`, so install / upgrade / uninstall behave identically
however the agent was installed.

## Agent signing key (set this first)

The server signs agent releases with an Ed25519 **signing key** that an admin
generates once under **Settings → Agent key**. It is the trust anchor for secure
agent management:

- It is generated **on the server**; the private key **never leaves it** (encrypted
  at rest via `secretBox`) and is **never shown or downloadable** — the page reports
  only that a key exists (+ a non-secret fingerprint). The server signs the agent
  source bundle into a signed release automatically (`publishSignedReleaseFromSource`),
  and agents verify that signature before installing — no external build host needed.
- **You cannot add agents until it is set**: `GET /api/enroll/command` returns `409
  NO_RELEASE_KEY`, and the Enrollment page shows a banner pointing to Settings. So on
  a new server an admin generates the key first.
- It is **write-once** (a second `POST` returns `409 EXISTS`) and **deletable** with a
  confirmation. After deletion no new agents can be onboarded and existing agents can
  no longer be upgraded from the server until a new key is generated — agents already
  enrolled keep running (and can still be pinged/deleted).
- The public key is published at `GET /enroll/agent-release-key`; the installers fetch
  + pin it so signed self-updates verify with no manual provisioning. When no managed
  key exists the server falls back to the env key (`AGENT_RELEASE_PUBLIC_KEY`), so
  existing deployments keep working.

Routes (admin): `GET/POST/DELETE /api/settings/agent-release-key` — status / generate
/ delete. The status is also included in `GET /api/settings` as `agentReleaseKey`.

## Endpoints

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /enroll/config` | none | `{ serverUrl, certFingerprint, releasePublicKey }` for the agent to self-configure |
| `GET /enroll/agent-source.tgz` | none | the agent **source bundle** (+ `X-Content-SHA256`); 404 if `AGENT_SOURCE_DIR` is unset/empty |
| `GET /enroll/agent-release-key` | none | the release trust anchor (PEM) the agent pins to verify **signed self-updates**; 404 if no key is configured |
| `GET /enroll/agent/:platform` | none | *legacy/optional* pre-built binary, only if one was dropped in the artifacts dir; 404 otherwise |
| `GET /enroll/:code/install.sh` | none | the self-contained installer for that code (Linux + macOS); 404 if unknown/expired/exhausted |
| `GET /enroll/:code/install.ps1` | none | the self-contained **PowerShell** installer for that code (Windows); `?download=1` returns it as a saveable attachment; 404 if unknown/expired/exhausted |
| `GET /enroll/uninstall.sh` | none | the agent uninstaller (Linux/macOS) — `curl … \| sudo sh` removes the agent from a host (warns + confirms first); 404 if no agent source is configured |
| `GET /enroll/uninstall.ps1` | none | the **PowerShell** uninstaller (Windows) — stops+unregisters the scheduled task and removes the install/state/log dirs; `?download=1` for an attachment |
| `GET /enroll/update.ps1` | none | the **PowerShell** updater (Windows) — updates an already-enrolled agent **in place**; no enrollment code, aborts where no enrolled agent exists; `?download=1` for an attachment; 404 if no agent source is published |
| `GET /api/enroll/command` | operator+ | builds the one-liner + manual/checksum variants (mints or reuses a code) |
| `GET /api/enroll/update-command` | operator+ | builds the Windows **update** one-liner (no code in it); 400 for a non-Windows platform, 409 if no source is published |

`GET /api/enroll/command` query params: `codeId` (reuse an existing active code),
`maxUses` + `ttlMinutes` (mint a bulk code), `locationId`. It returns:

```json
{
  "oneLiner": "curl -sSL https://<server>/enroll/<CODE>/install.sh | sh",
  "manual": { "downloadUrl": "https://<server>/enroll/agent-source.tgz",
              "checksum": "<sha256>", "command": "curl -sSL https://<server>/enroll/<CODE>/install.sh | sh" },
  "steps": null,
  "code": "<CODE>", "platforms": [],
  "certFingerprint": "<fp|null>", "maxUses": 1, "usesRemaining": 1, "expiresAt": "<ISO>"
}
```

`serverUrl` comes from `BLUEEYE_PUBLIC_URL` (recommended behind a proxy) or is
derived from the request; `checksum` is the server's cached hash of the bundle.
An `os` field (`linux` | `macos` | `windows`) is derived from the requested
`platform` so the dashboard can label the command. `steps` is `null` for
Linux/macOS; for Windows it is the same command split in two —
`{ download, run, scriptUrl, scriptFile }` — which the dashboard shows under
"Run it in two steps".

### Per-OS install commands

The one-liner is tailored to the selected platform, because Windows PowerShell
cannot run `curl -sSL … | sh` (`curl` is an alias for `Invoke-WebRequest` with
different flags, and there is no `sh`):

- **Linux / macOS** — `curl -sSL https://<server>/enroll/<CODE>/install.sh | sh`.
  One installer serves both: it detects the kernel, picks a runtime (Linux:
  pre-built binary → Node+systemd → Docker; macOS: Node, service via **launchd**),
  and never mistakes a Linux binary for a macOS host.
- **Windows** — run from an **elevated PowerShell** (not `cmd.exe`):

  ```
  <TLS/pin prelude> Invoke-WebRequest -UseBasicParsing -Uri 'https://<server>/enroll/<CODE>/install.ps1' -OutFile "$env:TEMP\blueeye-install.ps1"; Set-ExecutionPolicy Bypass -Scope Process -Force; & "$env:TEMP\blueeye-install.ps1"
  ```

  It requires Node.js, verifies the source checksum, and registers a
  **Scheduled Task** (SYSTEM, at boot, restart-on-failure) as the service.
  The command downloads the script to a **file** and runs the file — see
  [Why not `irm … | iex`](#why-not-irm--iex) below. The served `.ps1` files start
  with a UTF-8 BOM and contain only ASCII: Windows PowerShell 5.1 reads a BOM-less
  script in the host's ANSI code page, and a stray UTF-8 em-dash decodes to a `”`
  that PowerShell treats as a quote — the whole file then fails to parse.

Windows/macOS agents don't self-update (that path is systemd-only).

### Why not `irm … | iex`

The Windows command used to be
`powershell -NoProfile -ExecutionPolicy Bypass -Command "irm <url> | iex"`. That
is a *download cradle*: fetch a script and pipe it straight into the interpreter,
behind flags that suppress the profile and the execution policy. Installers do it
because it is short — and so does every PowerShell stager, which is why security
tooling treats the pattern as hostile:

- **On the network.** Emerging Threats ships a rule that matches the flag
  combination in an HTTP response body — *ET ATTACK_RESPONSE PowerShell NoProfile
  Command Received In Powershell Stagers*. It fires on the command text itself, so
  it went off on the **dashboard page** that showed an operator the install
  command, not just on the installer. A customer running BlueEyes over plain HTTP
  saw an IPS alert accusing their own BlueEyes server of delivering a stager.
- **On the host.** Endpoint AV/EDR blocks or quarantines the same pattern, so the
  install dies half-way through with no useful message.

Both are false positives, and both are avoidable, so the generated commands (and
the comments inside the generated scripts) no longer contain the pattern at all:

- the script is downloaded to a **file** in `%TEMP%` and the file is executed, so
  AMSI and antivirus can scan it, an operator can read it before running it, and
  it can be allowlisted by path;
- the execution policy is relaxed with `Set-ExecutionPolicy Bypass -Scope Process`
  — this PowerShell process only, no admin rights, machine policy untouched —
  instead of the `-ExecutionPolicy Bypass` flag;
- `-NoProfile` is gone. It bought nothing in an elevated admin shell and it is the
  literal token the IPS rule matches on.

Nothing is encoded, hidden or obfuscated, and the integrity story is unchanged:
the download is pinned to the server's certificate fingerprint when one is
configured, and the agent bundle is still verified against the SHA-256 embedded in
the script.

Two things are worth doing on the customer side as well:

- **Serve the dashboard over HTTPS.** The alert above was only possible because
  the install command crossed the network in cleartext on `http://…:3000`, where
  the IPS could read it. Terminate TLS in front of the server and set
  `BLUEEYE_PUBLIC_URL` (and `AGENT_CERT_FINGERPRINT` for a self-signed cert).
- **If the host still cannot download the script**, open
  `https://<server>/enroll/<CODE>/install.ps1?download=1` in a browser, save the
  file, copy it to the host and run it there. The dashboard shows this fallback
  under "Run it in two steps".

### Updating a Windows agent (no re-install)

A Windows agent runs under a Scheduled Task, so the server's one-click Update is
declined on the host. When such an agent is behind, the **Update** button in
Agents hands the operator a copy-paste one-liner instead:

```
<TLS/pin prelude> Invoke-WebRequest -UseBasicParsing -Uri 'https://<server>/enroll/update.ps1' -OutFile "$env:TEMP\blueeye-update.ps1"; Set-ExecutionPolicy Bypass -Scope Process -Force; & "$env:TEMP\blueeye-update.ps1"
```

`GET /api/enroll/update-command?platform=windows-amd64` (operator+) builds it —
`{ oneLiner, steps, os, platform, version, certFingerprint, manual: { downloadUrl, checksum, command } }`.

`update.ps1` is an **update, not an install**:

- it carries **no enrollment code** and never runs `enroll`, so it cannot create a
  second agent on the server;
- it aborts unless the host already has an installed agent *and* a non-empty
  enrollment token — the message points at **Add agent** instead;
- it downloads the source bundle, verifies the embedded SHA-256, stops the
  scheduled task, replaces the code in the install dir, reinstalls production
  dependencies and starts the task again;
- the **state dir** (token + `config.json`) is never touched, so the host keeps its
  identity and reappears in the dashboard on the new version. The existing
  `run-agent.cmd` launcher is preserved across the swap (it lives in the install
  dir), and the scheduled task is only re-registered if it has gone missing.

It honours the same `BLUEEYE_INSTALL_DIR` / `_STATE_DIR` / `_LOG_DIR` overrides and
the same `BLUEEYE_DRY_RUN` (verify-then-stop) hook as the installer. macOS/Docker
agents still upgrade by re-running their installer on the host.

## Agent source (no binaries)

The installer needs the agent code, which the server serves as a gzipped tarball
packaged from `AGENT_SOURCE_DIR` at startup (SHA-256 computed + cached, embedded
into the install script for verification). Point it at the sibling checkout:

- **Docker Compose** (default): the `server` service already bind-mounts
  `../blueeye-agent` to `/agent-src` and sets `AGENT_SOURCE_DIR=/agent-src`. After
  pulling new agent code, repackage with a restart:

  ```bash
  git -C ../blueeye-agent pull         # update the agent source
  docker compose restart server         # re-packages + re-checksums on boot
  ```

- **Bare Node**: defaults to the sibling `../blueeye-agent`; override with
  `AGENT_SOURCE_DIR=/path/to/blueeye-agent`.

If no source is configured, `/enroll/agent-source.tgz` 404s and the installer
stops with a clear message (it won't half-install). `node_modules`, `.git`,
`dist`, `test*` and `.github` are excluded from the bundle; the Docker build /
Node path installs production deps on the target.

## Air-gapped networks

`curl … | sh` only needs to reach **this** server, and the source is served by
this server (not GitHub or a registry). So enrollment works on isolated networks,
as long as the agent machine can reach BlueEyes. (The Docker path still needs its
base image — pre-load `node:22-alpine` or use a local registry — and the Node
path needs `npm` reachable; on a fully offline host, pre-stage one of those.)

## Bulk enrollment

A code can be redeemed up to `maxUses` times within its TTL window (both bounded —
there is no unlimited/eternal code). Use it to roll out many machines from one
code, e.g. with Ansible:

```yaml
- hosts: all
  become: true
  tasks:
    - name: Install BlueEyes agent
      ansible.builtin.shell: "curl -sSL https://blueeye.example.dk/enroll/<CODE>/install.sh | sh"
      args:
        creates: /opt/blueeye-agent/current/src/index.js   # idempotent
```

## Security

- **Short-lived codes** — default 1 hour (`ENROLLMENT_CODE_TTL_MINUTES`),
  configurable per code; bulk codes are bounded by count *and* time.
- **Codes are not stored in cleartext** (migration 076) — a code is a credential,
  so the database holds only its SHA-256 (`code_hash`, what every lookup matches
  on) plus an AES-256-GCM copy (`code_enc`, via secretBox) that only the
  authenticated `GET /api/enroll/command?codeId=…` endpoint decrypts. A database
  read therefore yields no usable codes, matching how agent tokens have always
  been stored. A code minted *before* that migration still enrolls (its hash was
  backfilled), but its one-liner can no longer be re-displayed — that endpoint
  answers `409` and the operator generates a new code.
- **Checksum always verified** — the installer aborts before building or running
  anything if the downloaded source bundle's SHA-256 doesn't match the embedded
  value. The manual variant shows the URL + checksum so cautious users can inspect
  the bundle first.
- **Certificate pinning** — when the server runs behind TLS, set
  `AGENT_CERT_FINGERPRINT` to its leaf-cert SHA-256. It's embedded into the
  install script and `/enroll/config`; the agent pins it on first contact and
  refuses a mismatching certificate. On plain HTTP (dev) there is nothing to pin.
```
