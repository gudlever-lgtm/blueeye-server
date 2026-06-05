#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Fresh web-session containers are cloned without node_modules, so `npm test`
# (node --test) fails every suite that requires the `supertest` devDependency
# ("Cannot find module 'supertest'"). Installing dependencies here makes the
# test suite runnable from the first prompt of every session.
set -euo pipefail

# Only needed in the remote (web) environment; locally you already have deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Resolve this repo's root from the script's own location, so the install runs
# in blueeye-server regardless of the session's working directory.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"
cd "$repo_dir"

# Idempotent and safe to re-run. `npm install` (not `npm ci`) so the container's
# post-hook cache is reused on later sessions; dev deps included for the tests.
echo "[session-start] installing npm dependencies in $repo_dir"
npm install --no-audit --no-fund
echo "[session-start] dependencies ready — \`npm test\` is runnable"
