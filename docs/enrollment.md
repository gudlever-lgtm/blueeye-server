# Frictionless agent enrollment

Goal: adding an agent should be **one command**, where the only thing the user
touches is the enrollment code. Server URL, certificate fingerprint and the
binary checksum are all supplied by the server — never typed by hand.

This builds on the existing enrollment-code → opaque-token flow (it does **not**
replace it):

- `enrollment_codes` (short-lived, now optionally multi-use) → `POST /agents/enroll`
  exchanges a code for an opaque agent token (hash stored, plaintext returned once).
- The agent then connects over the existing `/ws/agent` WebSocket and reports in.

## The flow

1. Operator opens **Enrollment → Tilføj agent**, picks a platform and clicks
   *Generér kode & kommando*. The UI calls `GET /api/enroll/command`.
2. The operator copies the one-liner and runs it on the target machine.
3. The script downloads the agent **from this server**, verifies its SHA-256,
   runs `blueeye-agent enroll --code …`, and installs a systemd service.
4. The agent connects; the enrollment screen flips **“Venter på agent…” →
   “Tilsluttet ✓”** live (over the dashboard WebSocket).

## Endpoints

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /enroll/config` | none | `{ serverUrl, certFingerprint }` for the binary to self-configure |
| `GET /enroll/agent/:platform` | none | the agent binary from the local artifacts dir (+ `X-Content-SHA256`); 404 if unpublished |
| `GET /enroll/:code/install.sh` | none | the self-contained installer for that code; 404 if unknown/expired/exhausted |
| `GET /api/enroll/command` | operator+ | builds the one-liner + manual/checksum variants (mints or reuses a code) |

`GET /api/enroll/command` query params: `platform`, `codeId` (reuse an existing
active code), `maxUses` + `ttlMinutes` (mint a bulk code), `locationId`. It
returns:

```json
{
  "oneLiner": "curl -sSL https://<server>/enroll/<CODE>/install.sh | sh",
  "manual": { "downloadUrl": "https://<server>/enroll/agent/<platform>",
              "checksum": "<sha256>", "command": "blueeye-agent enroll --code <CODE> --server <server>" },
  "code": "<CODE>", "platform": "linux-amd64", "platforms": ["linux-amd64", …],
  "certFingerprint": "<fp|null>", "maxUses": 1, "usesRemaining": 1, "expiresAt": "<ISO>"
}
```

`serverUrl` comes from `BLUEEYE_PUBLIC_URL` (recommended behind a proxy) or is
derived from the request; `checksum` always comes from the server's cached hash.

## Publishing binaries

Drop built binaries into the artifacts dir (`AGENT_ARTIFACTS_DIR`, default
`./artifacts`) named `blueeye-agent-<platform>[.exe]`. SHA-256 is computed and
cached at startup. See [`../artifacts/README.md`](../artifacts/README.md).

## Air-gapped networks

`curl … | sh` only needs to reach **this** server, and the binary is served by
this server (not an external mirror). So the whole flow works on isolated
networks with no Internet access, as long as the agent machine can reach BlueEye.

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
        creates: /opt/blueeye-agent/blueeye-agent   # idempotent
```

## Security

- **Short-lived codes** — default 1 hour (`ENROLLMENT_CODE_TTL_MINUTES`),
  configurable per code; bulk codes are bounded by count *and* time.
- **Checksum always verified** — the installer aborts before running anything if
  the downloaded binary's SHA-256 doesn't match the embedded value. The manual
  variant shows the URL + checksum + command so cautious users can inspect first.
- **Certificate pinning** — when the server runs behind TLS, set
  `AGENT_CERT_FINGERPRINT` to its leaf-cert SHA-256. It's embedded into the
  install script and `/enroll/config`; the agent pins it on first contact and
  refuses a mismatching certificate. On plain HTTP (dev) there is nothing to pin.
