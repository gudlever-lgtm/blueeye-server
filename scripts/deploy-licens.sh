#!/usr/bin/env bash
#
# VENDOR-ONLY: deploy / update the BlueEye license server (blueeye-licens).
#
# Customers do NOT run this. The general scripts/deploy.sh deploys blueeye-server
# + blueeye-agent only; the license server is operated by the vendor. This script
# updates the blueeye-licens repo on the deploy branch and rebuilds JUST the
# `licens` service in the compose stack (leaving server/db/agent untouched).
#
# Usage:
#   ./scripts/deploy-licens.sh                       # deploys 'main' (default)
#   BLUEEYE_BRANCH=some-branch ./scripts/deploy-licens.sh
#
# Expects blueeye-licens as a sibling of blueeye-server (which holds the compose
# file): /var/www/blueeye.gnf.dk/{blueeye-server,blueeye-licens}
set -euo pipefail

BRANCH="${BLUEEYE_BRANCH:-main}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # blueeye-server (has docker-compose.yml)
ROOT_DIR="$(cd "$SERVER_DIR/.." && pwd)"
LICENS_DIR="$ROOT_DIR/blueeye-licens"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$LICENS_DIR/.git" ] || die "blueeye-licens not found at $LICENS_DIR (expected as a sibling of blueeye-server)."

# Pick a docker compose command.
if docker compose version >/dev/null 2>&1; then DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then DC=(docker-compose)
else die "Neither 'docker compose' nor 'docker-compose' is available."; fi

# --- Update the licens repo (with retry/backoff) ---------------------------
log "Updating blueeye-licens ($BRANCH)"
[ -z "$(git -C "$LICENS_DIR" status --porcelain)" ] || die "blueeye-licens has uncommitted local changes; resolve them first."
cur="$(git -C "$LICENS_DIR" rev-parse --abbrev-ref HEAD)"
if [ "$cur" != "$BRANCH" ]; then
  log "Switching blueeye-licens to $BRANCH (was $cur)"
  git -C "$LICENS_DIR" fetch origin "$BRANCH"
  git -C "$LICENS_DIR" checkout "$BRANCH"
fi
delay=2
for attempt in 1 2 3 4 5; do
  if git -C "$LICENS_DIR" pull --ff-only origin "$BRANCH"; then break; fi
  [ "$attempt" -lt 5 ] || die "Could not pull blueeye-licens after retries."
  warn "git pull failed (attempt $attempt); retrying in ${delay}s..."; sleep "$delay"; delay=$((delay * 2))
done

# --- Rebuild + restart only the licens service -----------------------------
cd "$SERVER_DIR"
log "Building and restarting the licens service"
"${DC[@]}" up -d --build licens

log "Stack status"
"${DC[@]}" ps

# --- Health check (non-fatal) ---------------------------------------------
LICENS_PORT="${LICENS_HOST_PORT:-4000}"
URL="http://localhost:${LICENS_PORT}/health"
if command -v curl >/dev/null 2>&1; then
  log "Waiting for licens to become healthy"
  for i in $(seq 1 30); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$URL" 2>/dev/null)" = "200" ]; then
      log "licens healthy ($URL)"; break
    fi
    [ "$i" = 30 ] && warn "licens did not report healthy at $URL (check: ${DC[*]} logs licens)."
    sleep 2
  done
fi

log "Done."
