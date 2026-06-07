#!/bin/bash
# SessionStart hook (Claude Code on the web). Two jobs, both idempotent and
# best-effort so they never block session startup:
#  1. Activate the tracked git hooks (git config is not cloned) so the package
#     version auto-bumps on every commit (.githooks/pre-commit).
#  2. Install dependencies — fresh web containers are cloned without
#     node_modules, so `npm test` (node --test) otherwise fails every suite that
#     needs a devDependency (e.g. supertest). Installing here makes the test
#     suite runnable from the first prompt of every session.
set -uo pipefail

# Resolve this repo's root from the script's own location, so it runs in
# blueeye-server regardless of the session's working directory.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"

# Make the tracked hooks active for this fresh clone (git config is not cloned).
git config core.hooksPath "$repo_dir/.githooks" 2>/dev/null || true

# `npm install` (not `npm ci`) so the container's cache is reused on later
# sessions; dev deps included for the tests.
if [ -f "$repo_dir/package.json" ] && command -v npm >/dev/null 2>&1; then
  echo "[session-start] installing npm dependencies in $repo_dir"
  ( cd "$repo_dir" && npm install --no-audit --no-fund ) || echo "session-start: npm install skipped"
  echo "[session-start] dependencies ready — \`npm test\` is runnable"
fi
