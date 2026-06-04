# Agent artifacts

Drop the built agent binaries here. The server scans this directory at startup,
caches each file's SHA-256, and serves them at `GET /enroll/agent/:platform` for
frictionless, **air-gap-friendly** enrollment (the binary comes from the BlueEye
server itself — no Internet needed).

## Naming

Files must be named `blueeye-agent-<platform>` (add `.exe` for Windows), where
`<platform>` is two-or-more lowercase-alphanumeric segments joined by `-`:

```
blueeye-agent-linux-amd64
blueeye-agent-linux-arm64
blueeye-agent-windows-amd64.exe
blueeye-agent-darwin-arm64
```

The `<platform>` slug is exactly what the install script's `uname` detection and
the `/enroll/agent/:platform` URL use, so keep them consistent
(`linux`/`darwin`/`windows` + `amd64`/`arm64`/`armv7`).

## Producing a binary

The agent (`blueeye-agent`) is plain Node.js. It's packaged into self-contained
**Node SEA** (Single Executable Application) binaries — one file per platform,
no Node/npm needed on the target — by the agent repo:

```bash
# in a blueeye-agent checkout
npm ci
npm run build:sea            # -> dist/blueeye-agent-linux-amd64, -linux-arm64
```

In CI this is automated: pushing a tag `v*` builds the binaries and attaches them
to a GitHub Release (`blueeye-agent/.github/workflows/release-agent.yml`).

## Publishing here

Don't copy files by hand — use the helper, which downloads a release (or copies
from a local dir for air-gapped installs), verifies SHA-256, and drops the
binaries in:

```bash
# in the blueeye-server checkout, on the server host
scripts/fetch-agent-binaries.sh                 # latest release
scripts/fetch-agent-binaries.sh --tag v0.1.0
scripts/fetch-agent-binaries.sh --from /mnt/usb/blueeye-binaries   # air-gapped
```

Then re-run the server (binaries are scanned + checksummed at startup; or call
the store's `reload()`). Override the location with `AGENT_ARTIFACTS_DIR`.

> SEA binaries target **glibc** Linux (most distros). For musl/Alpine hosts, use
> the agent's Docker install path instead.

This directory is otherwise empty in git (see `.gitkeep`); binaries are
deployment artifacts, not source.
