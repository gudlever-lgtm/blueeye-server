# Agent artifacts (legacy / optional)

**You usually don't need this directory.** The default enrollment flow ships the
agent **source** and builds + runs it on the target (Docker/Node) — no pre-built
binaries. See [`../docs/enrollment.md`](../docs/enrollment.md) and
`AGENT_SOURCE_DIR`.

This directory only exists for the *optional* legacy path: if you drop a
pre-built single-file binary here, the server will also serve it at
`GET /enroll/agent/:platform`. Files must be named `blueeye-agent-<platform>`
(add `.exe` for Windows), e.g. `blueeye-agent-linux-amd64`. SHA-256 is computed
and cached at startup; override the location with `AGENT_ARTIFACTS_DIR`.

The default installer does **not** use these files, so an empty dir here is fine.
This directory is otherwise empty in git (see `.gitkeep`).
