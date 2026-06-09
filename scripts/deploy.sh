#!/usr/bin/env bash
#
# Deploys the customer BlueEye stack on this host:
#   1) updates blueeye-server + blueeye-agent (the agent is served as source) on
#      the deploy branch,
#   2) rebuilds + (re)starts the server (and demo agent) in the compose stack, and
#   3) when the agent source moved, restarts the server so it re-packages the new
#      agent bundle — that's what makes the dashboard flag out-of-date agents and
#      offer the new version (otherwise the running server keeps serving the old
#      cached bundle).
#
# The license server (blueeye-licens) is NOT deployed here — it is vendor-managed.
# Use scripts/deploy-licens.sh for that. (If a licens container is already running
# it's left running as the server's dependency; this script never rebuilds it.)
#
# Usage:
#   ./scripts/deploy.sh                          # deploys 'main' (the default)
#   BLUEEYE_BRANCH=some-branch ./scripts/deploy.sh   # deploy another branch
#   BLUEEYE_API_TOKEN=<viewer+ JWT> ./scripts/deploy.sh   # also verify the
#       offered agent version via /system/version after deploy (optional)
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
# Track the agent checkout's HEAD: the server packages + serves the agent SOURCE,
# so if it moved we must make the server re-read it (see the re-package step below).
AGENT_DIR="$ROOT_DIR/blueeye-agent"
AGENT_SHA_BEFORE="$(git -C "$AGENT_DIR" rev-parse HEAD 2>/dev/null || echo none)"

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

AGENT_SHA_AFTER="$(git -C "$AGENT_DIR" rev-parse HEAD 2>/dev/null || echo none)"
# Agent version string, parsed from package.json (no node needed on the host).
AGENT_VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$AGENT_DIR/package.json" 2>/dev/null | head -1)"

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

# --- Re-package the served agent bundle ------------------------------------
# The server tars + caches the agent SOURCE (bind-mounted from ../blueeye-agent)
# at boot, and the dashboard's "update available" badge compares a deployed
# agent's version against THAT cached bundle. When only the agent changed, the
# server image is unchanged so `up -d` leaves the old container running with the
# stale bundle — the new agent version is never offered. Restart the server so it
# re-packages the freshly-pulled source. (No-op when the agent didn't move.)
if [ "$AGENT_SHA_BEFORE" != "$AGENT_SHA_AFTER" ]; then
  log "Agent source changed → restarting server to serve agent v${AGENT_VER:-?}"
  "${DC[@]}" restart server
else
  log "Agent source unchanged (v${AGENT_VER:-?}) — no re-package needed"
fi

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

# --- Confirm the offered agent version (optional) --------------------------
# Verifies the server now actually offers the bundled agent version, closing the
# "I deployed but the dashboard still shows no update" loop. /system/version is
# auth-gated (viewer+), so this runs only when a token is provided in
# BLUEEYE_API_TOKEN; otherwise it's skipped. Non-fatal either way.
if [ -n "${BLUEEYE_API_TOKEN:-}" ] && command -v curl >/dev/null 2>&1; then
  offered="$(curl -s --max-time 3 -H "Authorization: Bearer ${BLUEEYE_API_TOKEN}" \
    "http://localhost:${SERVER_PORT}/system/version" 2>/dev/null \
    | sed -n 's/.*"agent"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ -z "$offered" ]; then
    warn "Could not read /system/version (bad token, or older server) — skipping version check."
  elif [ "$offered" = "${AGENT_VER:-}" ]; then
    log "Server offers agent v${offered} ✓ (out-of-date agents will now show an update)"
  else
    warn "Server offers agent v${offered} but the source is v${AGENT_VER:-?}."
    warn "Force a re-package: ${DC[*]} restart server   (or POST /system/agent-source/reload as admin)."
  fi
fi

log "Done."
