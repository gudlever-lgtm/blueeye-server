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
   SHA-256, then **auto-detects a runtime**:
   - **Docker** (preferred): `docker build` + `docker run` (host networking); the
     container enrolls itself from the embedded code and persists its token on a
     named volume.
   - else **Node ≥18**: installs deps, runs `blueeye-agent enroll --code …`, and
     installs a systemd service.
   - else it prints how to install Docker or Node and stops — it never dead-ends.
4. The agent connects; the enrollment screen flips **”Waiting for agent…” →
   “Connected ✓”** live (over the dashboard WebSocket).

**No pre-built binaries are published or required.** The agent is plain Node, so
the installer ships its *source* and builds/runs it on the target.

## Endpoints

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /enroll/config` | none | `{ serverUrl, certFingerprint }` for the agent to self-configure |
| `GET /enroll/agent-source.tgz` | none | the agent **source bundle** (+ `X-Content-SHA256`); 404 if `AGENT_SOURCE_DIR` is unset/empty |
| `GET /enroll/agent/:platform` | none | *legacy/optional* pre-built binary, only if one was dropped in the artifacts dir; 404 otherwise |
| `GET /enroll/:code/install.sh` | none | the self-contained installer for that code; 404 if unknown/expired/exhausted |
| `GET /enroll/uninstall.sh` | none | the agent uninstaller — `curl … \| sudo sh` removes the agent from a host (warns + confirms first); 404 if no agent source is configured |
| `GET /api/enroll/command` | operator+ | builds the one-liner + manual/checksum variants (mints or reuses a code) |

`GET /api/enroll/command` query params: `codeId` (reuse an existing active code),
`maxUses` + `ttlMinutes` (mint a bulk code), `locationId`. It returns:

```json
{
  "oneLiner": "curl -sSL https://<server>/enroll/<CODE>/install.sh | sh",
  "manual": { "downloadUrl": "https://<server>/enroll/agent-source.tgz",
              "checksum": "<sha256>", "command": "curl -sSL https://<server>/enroll/<CODE>/install.sh | sh" },
  "code": "<CODE>", "platforms": [],
  "certFingerprint": "<fp|null>", "maxUses": 1, "usesRemaining": 1, "expiresAt": "<ISO>"
}
```

`serverUrl` comes from `BLUEEYE_PUBLIC_URL` (recommended behind a proxy) or is
derived from the request; `checksum` is the server's cached hash of the bundle.

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
as long as the agent machine can reach BlueEye. (The Docker path still needs its
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
    - name: Install BlueEye agent
      ansible.builtin.shell: "curl -sSL https://blueeye.example.dk/enroll/<CODE>/install.sh | sh"
      args:
        creates: /opt/blueeye-agent/src/index.js   # idempotent
```

## Security

- **Short-lived codes** — default 1 hour (`ENROLLMENT_CODE_TTL_MINUTES`),
  configurable per code; bulk codes are bounded by count *and* time.
- **Checksum always verified** — the installer aborts before building or running
  anything if the downloaded source bundle's SHA-256 doesn't match the embedded
  value. The manual variant shows the URL + checksum so cautious users can inspect
  the bundle first.
- **Certificate pinning** — when the server runs behind TLS, set
  `AGENT_CERT_FINGERPRINT` to its leaf-cert SHA-256. It's embedded into the
  install script and `/enroll/config`; the agent pins it on first contact and
  refuses a mismatching certificate. On plain HTTP (dev) there is nothing to pin.
```
