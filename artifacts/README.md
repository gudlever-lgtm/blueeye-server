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

The agent (`blueeye-agent`) is plain Node.js with no build step. Package it for a
target with your tool of choice (e.g. a single-file build, a `pkg`/`node-sea`
binary, or a self-extracting tarball with a shim) in CI, then copy the result
here under the name above. Re-run the server (or call the store's `reload()`)
after publishing new binaries.

Override the location with `AGENT_ARTIFACTS_DIR`. This directory is otherwise
empty in git (see `.gitkeep`); binaries are deployment artifacts, not source.
