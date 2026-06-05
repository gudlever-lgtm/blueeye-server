#!/usr/bin/env bash
#
# Deploys the customer BlueEye stack on this host:
#   1) updates blueeye-server + blueeye-agent (the agent is served as source) on
#      the deploy branch, and
#   2) rebuilds + (re)starts the server (and demo agent) in the compose stack.
#
# The license server (blueeye-licens) is NOT deployed here — it is vendor-managed.
# Use scripts/deploy-licens.sh for that. (If a licens container is already running
# it's left running as the server's dependency; this script never rebuilds it.)
#
# Usage:
#   ./scripts/deploy.sh                          # deploys 'main' (the default)
#   BLUEEYE_BRANCH=some-branch ./scripts/deploy.sh   # deploy another branch
#
# Expects the repos cloned as siblings, e.g.:
#   /var/www/blueeye.gnf.dk/{blueeye-server,blueeye-agent}
set -euo pipefail

# --- Config ----------------------------------------------------------------
# Deploy from main by default; override per-run with BLUEEYE_BRANCH.
BRANCH="${BLUEEYE_BRANCH:-main}"
REPOS=(blueeye-server blueeye-agent)
# Compose services this script (re)builds. licens is intentionally excluded.
SERVICES=(server agent)

# Resolve paths from the script's own location so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # blueeye-server (has docker-compose.yml)
ROOT_DIR="$(cd "$SERVER_DIR/.." && pwd)"     # parent holding all three repos

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# git pull with retry/backoff for transient network failures.
git_pull_retry() {
  local dir="$1" delay=2 attempt
  for attempt in 1 2 3 4 5; do
    if git -C "$dir" pull --ff-only origin "$BRANCH"; then
      return 0
    fi
    if [ "$attempt" -lt 5 ]; then
      warn "git pull failed in $(basename "$dir") (attempt $attempt); retrying in ${delay}s..."
      sleep "$delay"; delay=$((delay * 2))
    fi
  done
  return 1
}

# --- Pick a docker compose command ----------------------------------------
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  die "Neither 'docker compose' nor 'docker-compose' is available."
fi

# --- Update repos ----------------------------------------------------------
for d in "${REPOS[@]}"; do
  dir="$ROOT_DIR/$d"
  [ -d "$dir/.git" ] || die "Repo not found: $dir (expected the three repos as siblings)."

  log "Updating $d ($BRANCH)"
  # Refuse to clobber local edits — surface them rather than losing them.
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    die "$d has uncommitted local changes; resolve them before deploying."
  fi

  cur="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
  if [ "$cur" != "$BRANCH" ]; then
    log "Switching $d to $BRANCH (was $cur)"
    git -C "$dir" fetch origin "$BRANCH"
    git -C "$dir" checkout "$BRANCH"
  fi
  git_pull_retry "$dir" || die "Could not pull $d after retries."
done

# --- Build + (re)start -----------------------------------------------------
cd "$SERVER_DIR"
if [ ! -f .env ]; then
  warn ".env not found in $SERVER_DIR."
  warn "For the demo run: node scripts/dev-bootstrap.js   (generates keys + .env)"
fi

log "Building and starting: ${SERVICES[*]} (licens is left to deploy-licens.sh)"
"${DC[@]}" up -d --build "${SERVICES[@]}"

log "Stack status"
"${DC[@]}" ps

# --- Health check (non-fatal) ---------------------------------------------
SERVER_PORT="${SERVER_HOST_PORT:-3000}"

http_ok() {
  # $1=url — returns 0 if it answers HTTP 200 within the timeout.
  if command -v curl >/dev/null 2>&1; then
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null)" = "200" ]
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O /dev/null "$1" 2>/dev/null
  else
    return 2  # no http client available
  fi
}

wait_health() {
  local name="$1" url="$2" i
  for i in $(seq 1 30); do
    if http_ok "$url"; then log "$name healthy ($url)"; return 0; fi
    local rc=$?
    [ "$rc" = "2" ] && { warn "No curl/wget; skipping $name health check."; return 0; }
    sleep 2
  done
  warn "$name did not report healthy at $url (check: ${DC[*]} logs $name)."
  return 1
}

log "Waiting for the server to become healthy"
wait_health server "http://localhost:${SERVER_PORT}/health" || true

log "Done."
