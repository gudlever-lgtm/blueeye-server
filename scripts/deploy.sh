#!/usr/bin/env bash
#
# Deploys the customer BlueEyes stack on this host:
#   1) updates blueeye-server + blueeye-agent (the agent is served as source) on
#      the deploy branch,
#   2) rebuilds + (re)starts the server (and demo agent) in the compose stack, and
#   3) restarts the server so it re-packages the on-disk agent bundle — that's
#      what makes the dashboard flag out-of-date agents and offer the new version.
#      Done on EVERY deploy (not just when the agent moved this run), because a
#      server that's already running keeps serving the bundle it cached at its
#      last boot, even if the agent was bumped in an earlier deploy.
#   4) rebuilds the Service Assurance worker WHEN THIS HOST RUNS ONE — see below.
#
# The Service Assurance worker sits behind the "service-assurance" compose profile,
# so it is not part of the default stack: a deployment that does not use the
# feature should never build a Debian+Chromium image it will not run. But a host
# that HAS one must not be left with a worker running last week's code while the
# server updates, so this script starts it whenever it finds one already there.
# The first time, ask for it explicitly:
#
#   BLUEEYE_SERVICE_ASSURANCE=1 ./scripts/deploy.sh          # start one worker
#   BLUEEYE_ASSURANCE_WORKERS=3 ./scripts/deploy.sh          # start three
#   BLUEEYE_ASSURANCE_WORKERS=0 ./scripts/deploy.sh          # stop and skip them
#
# After that the count is remembered — it is read back off the running containers,
# so a stack scaled to three stays at three.
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
#   BLUEEYE_SERVICE_ASSURANCE=1 ./scripts/deploy.sh       # also run the Service
#       Assurance worker (see above; remembered on later deploys)
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
# The Service Assurance worker, handled separately: it lives behind a compose
# profile and is deployed only on hosts that actually run it (see the header).
ASSURANCE_SERVICE=service-assurance-worker
ASSURANCE_PROFILE=service-assurance
# `name: blueeye` at the top of docker-compose.yml, unless the environment
# overrides it. Used to find this stack's worker containers by label.
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-blueeye}"

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

# Pre-flight every repo BEFORE pulling any of them. Checking inside the loop meant
# dirty edits in blueeye-agent aborted the deploy only after blueeye-server had
# already been pulled — a half-updated checkout, and a server that then serves a
# stale agent bundle. Either the whole deploy runs, or nothing moves.
for d in "${REPOS[@]}"; do
  dir="$ROOT_DIR/$d"
  [ -d "$dir/.git" ] || die "Repo not found: $dir (expected the repos as siblings)."
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    die "$d has uncommitted local changes; resolve them before deploying (nothing has been pulled)."
  fi
done

# Where each repo stood BEFORE the pull. This is the rollback target printed if
# the deploy fails its health check — without it, "go back to what worked" means
# reading the reflog on a host nobody is logged into.
declare -A SHA_BEFORE=()
for d in "${REPOS[@]}"; do
  SHA_BEFORE[$d]="$(git -C "$ROOT_DIR/$d" rev-parse HEAD 2>/dev/null || echo none)"
done

for d in "${REPOS[@]}"; do
  dir="$ROOT_DIR/$d"

  log "Updating $d ($BRANCH)"
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

# --- Pre-migration dump ----------------------------------------------------
# The server container runs `migrate && server`, so the moment the next line
# starts it, pending migrations run. MySQL commits DDL as it goes: there is no
# transaction to roll back, and the only honest recovery from a schema change
# that goes wrong is a dump taken before it. Taking one is cheap; needing one
# you did not take is not.
#
# Skipped when the db service is not part of this stack (an external MySQL), or
# with BLUEEYE_SKIP_DB_DUMP=1.
DUMP_DIR="${BLUEEYE_DUMP_DIR:-$SERVER_DIR/backups}"
DUMP_FILE=""
if [ "${BLUEEYE_SKIP_DB_DUMP:-0}" = "1" ]; then
  warn "BLUEEYE_SKIP_DB_DUMP=1 — no pre-migration dump. A failed schema change will have nothing to restore."
elif ! "${DC[@]}" ps --services 2>/dev/null | grep -qx db; then
  warn "No 'db' service in this stack (external MySQL?) — skipping the pre-migration dump."
  warn "Take your own dump before deploying a release that migrates."
else
  mkdir -p "$DUMP_DIR"
  DUMP_FILE="$DUMP_DIR/blueeye-$(date +%Y%m%d-%H%M%S).sql.gz"
  log "Dumping the database before migrations → $DUMP_FILE"
  if "${DC[@]}" exec -T db sh -c \
      'exec mysqldump --single-transaction --routines --triggers --events \
         -u root -p"$MYSQL_ROOT_PASSWORD" "${MYSQL_DATABASE:-blueeye}"' 2>/dev/null | gzip > "$DUMP_FILE"; then
    # An empty or truncated dump is worse than none, because it looks like a
    # backup. 4 KiB is well under any real schema and well over a gzip header.
    DUMP_SIZE="$(wc -c < "$DUMP_FILE" 2>/dev/null || echo 0)"
    if [ "$DUMP_SIZE" -lt 4096 ]; then
      rm -f "$DUMP_FILE"
      die "The pre-migration dump came out at ${DUMP_SIZE} bytes — that is not a backup. Nothing has been deployed. Check the db credentials, or set BLUEEYE_SKIP_DB_DUMP=1 to deploy without one."
    fi
    log "Dump written ($((DUMP_SIZE / 1024)) KiB)"
  else
    rm -f "$DUMP_FILE"
    die "Could not dump the database; nothing has been deployed. Fix it, or set BLUEEYE_SKIP_DB_DUMP=1 to deploy without a backup."
  fi
fi

log "Building and starting: ${SERVICES[*]} (licens is left to deploy-licens.sh)"
"${DC[@]}" up -d --build "${SERVICES[@]}"

# --- Service Assurance worker ---------------------------------------------
# How many workers this host should end up with:
#   BLUEEYE_ASSURANCE_WORKERS  — an explicit number, including 0 to stop them
#   otherwise                  — however many containers are already there, so a
#                                stack scaled to three stays at three
#   otherwise                  — 1 when opted in for the first time, else none
#
# Counting existing containers by compose label rather than asking compose keeps
# this correct without activating the profile, and includes STOPPED workers: a
# host whose worker died is a host that still wants one.
existing_workers() {
  command -v docker >/dev/null 2>&1 || { echo 0; return; }
  docker ps -a -q \
    --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
    --filter "label=com.docker.compose.service=${ASSURANCE_SERVICE}" 2>/dev/null \
    | wc -l | tr -d ' '
}

# Asked for by hand: the env flag, or a COMPOSE_PROFILES that already names the
# profile (someone who exports it means it).
assurance_opted_in() {
  [ "${BLUEEYE_SERVICE_ASSURANCE:-0}" = "1" ] && return 0
  case "${COMPOSE_PROFILES:-}" in *"$ASSURANCE_PROFILE"*) return 0 ;; esac
  return 1
}

HAVE_WORKERS="$(existing_workers)"
WANT_WORKERS=0
if [ -n "${BLUEEYE_ASSURANCE_WORKERS:-}" ]; then
  case "$BLUEEYE_ASSURANCE_WORKERS" in
    ''|*[!0-9]*) die "BLUEEYE_ASSURANCE_WORKERS must be a whole number (got '$BLUEEYE_ASSURANCE_WORKERS')." ;;
    *) WANT_WORKERS="$BLUEEYE_ASSURANCE_WORKERS" ;;
  esac
elif [ "$HAVE_WORKERS" -gt 0 ]; then
  WANT_WORKERS="$HAVE_WORKERS"
elif assurance_opted_in; then
  WANT_WORKERS=1
fi

if [ "$WANT_WORKERS" -gt 0 ]; then
  log "Building and starting the Service Assurance worker (x$WANT_WORKERS)"
  # The profile is set for this command only — the rest of the deploy is the
  # ordinary stack. Building it takes a while the first time: it is a Debian
  # image with Chromium, which is why it is not in the default set.
  COMPOSE_PROFILES="$ASSURANCE_PROFILE" "${DC[@]}" up -d --build \
    --scale "${ASSURANCE_SERVICE}=${WANT_WORKERS}" "$ASSURANCE_SERVICE"
elif [ "$HAVE_WORKERS" -gt 0 ]; then
  log "Stopping the Service Assurance worker (BLUEEYE_ASSURANCE_WORKERS=0)"
  COMPOSE_PROFILES="$ASSURANCE_PROFILE" "${DC[@]}" rm -sf "$ASSURANCE_SERVICE" || true
else
  log "Service Assurance worker: not deployed on this host (BLUEEYE_SERVICE_ASSURANCE=1 to start one)"
fi

log "Stack status"
"${DC[@]}" ps

# --- Re-package the served agent bundle ------------------------------------
# The server tars + caches the agent SOURCE (bind-mounted from ../blueeye-agent)
# at boot, and the dashboard's "update available" badge compares a deployed
# agent's version against THAT cached bundle. `up -d --build` only recreates the
# server when its OWN image changed, so a server that's already running keeps
# serving whatever bundle it cached at its last boot — including a stale one from
# before the agent was bumped in an EARLIER deploy. In that case nothing is
# fetched this run, yet the dashboard still shows no update.
#
# So reconcile unconditionally: restart the server on every deploy so the served
# bundle always matches the on-disk agent source, regardless of whether anything
# moved this run. (A restart re-runs the startup packaging; the bind mount always
# reflects the current source, so this is the deterministic "make it match" step.)
if [ "$AGENT_SHA_BEFORE" != "$AGENT_SHA_AFTER" ]; then
  log "Agent source moved this deploy → restarting server to serve agent v${AGENT_VER:-?}"
else
  log "Reconciling served bundle with on-disk agent source (v${AGENT_VER:-?})"
fi
"${DC[@]}" restart server

# --- Health + smoke checks (FATAL) ----------------------------------------
# A deploy that cannot answer /health has not succeeded. This used to warn and
# print "Done.", exit 0 — so a broken deploy looked like a good one, and the next
# person to find out was a customer. It now fails, with the container's own log
# tail and the exact commands to go back.
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

# Echoes the status code for a URL, or empty when there is no curl. Used by the
# smoke checks, which care about WHICH code came back, not just "was it 200".
http_code() {
  command -v curl >/dev/null 2>&1 || return 2
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null
}

# What to do about a deploy that came up broken. Code rollback only — the
# database is deliberately NOT rolled back: MySQL DDL does not undo in a
# transaction, and a half-reverted schema is worse than a stopped one. See
# docs/deploy-recovery.md.
abort_deploy() {
  local why="$1"
  printf '\n\033[1;31m===== DEPLOY FAILED: %s =====\033[0m\n' "$why" >&2
  if command -v docker >/dev/null 2>&1; then
    printf '\n--- last 60 lines of the server log ---\n' >&2
    "${DC[@]}" logs --tail 60 server 2>&1 >&2 || true
  fi
  printf '\n\033[1;33mTo go back to the previous code:\033[0m\n' >&2
  for d in "${REPOS[@]}"; do
    printf '  git -C %s checkout %s\n' "$ROOT_DIR/$d" "${SHA_BEFORE[$d]}" >&2
  done
  printf '  %s up -d --build %s && %s restart server\n' "${DC[*]}" "${SERVICES[*]}" "${DC[*]}" >&2
  if [ -n "${DUMP_FILE:-}" ] && [ -f "${DUMP_FILE:-}" ]; then
    printf '\nPre-deploy dump: %s\n' "$DUMP_FILE" >&2
    printf '  gunzip < %s | %s exec -T db sh -c \x27exec mysql -u root -p"$MYSQL_ROOT_PASSWORD" "${MYSQL_DATABASE:-blueeye}"\x27\n' "$DUMP_FILE" "${DC[*]}" >&2
  fi
  printf '\nThe DATABASE is not rolled back. Any migration this deploy applied is\n' >&2
  printf 'still applied — migrations are written to be safe for the previous\n' >&2
  printf 'server version (docs/deploy-recovery.md). If the failure IS the\n' >&2
  printf 'migration, restore the pre-deploy dump before starting the old code.\n' >&2
  exit 1
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
wait_health server "http://localhost:${SERVER_PORT}/health" \
  || abort_deploy "the server never answered 200 on /health"

# --- Smoke checks ----------------------------------------------------------
# Three questions /health cannot answer: does the app actually route, does it
# still refuse what it should, and is anything answering 5xx? A 500 anywhere
# here is a deploy that boots but does not work.
smoke() {
  local name="$1" url="$2" want="$3" got
  got="$(http_code "$url")" || { warn "No curl; skipping smoke check '$name'."; return 0; }
  if [ "$got" = "$want" ]; then
    log "smoke: $name → $got ✓"
    return 0
  fi
  warn "smoke: $name expected HTTP $want, got ${got:-no answer} ($url)"
  return 1
}

SMOKE_FAILED=0
BASE="http://localhost:${SERVER_PORT}"
# The dashboard shell is served, so the app is routing at all.
smoke "dashboard loads"        "$BASE/"                      200 || SMOKE_FAILED=1
# An unknown path is a 404 and not a 500 — the error handler is wired.
smoke "unknown path is 404"    "$BASE/no-such-endpoint-$$"   404 || SMOKE_FAILED=1
smoke "unknown api path is 404" "$BASE/api/no-such-thing-$$" 404 || SMOKE_FAILED=1
# An auth-gated endpoint still refuses an anonymous caller. A 500 here (or a
# 200!) is a broken auth chain, which no health probe would notice.
smoke "protected route is 401" "$BASE/system/version"        401 || SMOKE_FAILED=1
smoke "agents list is 401"     "$BASE/agents"                401 || SMOKE_FAILED=1
[ "$SMOKE_FAILED" = "0" ] || abort_deploy "the smoke checks did not pass"

# --- Confirm the offered agent version (optional) --------------------------
# Verifies the server now actually offers the bundled agent version, closing the
# "I deployed but the dashboard still shows no update" loop. /system/version is
# auth-gated (viewer+), so this runs only when a token is provided in
# BLUEEYE_API_TOKEN; otherwise it's skipped. Non-fatal either way.
# First, the check that needs no token at all: the server logs the version it
# packaged on every boot. This is the whole "I deployed but the dashboard still
# offers the old agent" loop, closed on every deploy rather than only when
# someone remembered to export a JWT.
PACKAGED=""
if command -v docker >/dev/null 2>&1; then
  PACKAGED="$("${DC[@]}" logs --tail 400 server 2>/dev/null \
    | sed -n 's/.*agent source packaged v\([^ ]*\) from.*/\1/p' | tail -1)"
fi
if [ -z "$PACKAGED" ]; then
  warn "Could not read the packaged agent version from the server log — check manually:"
  warn "  ${DC[*]} logs server | grep 'agent source packaged'"
elif [ "$PACKAGED" = "?" ]; then
  warn "The server packaged an agent bundle it could not read a version from."
  warn "Check that $AGENT_DIR/package.json is readable inside the container (AGENT_SOURCE_DIR)."
elif [ "$PACKAGED" != "${AGENT_VER:-}" ]; then
  warn "The server is serving agent v${PACKAGED}, but $AGENT_DIR is v${AGENT_VER:-?}."
  warn "The bind mount is not pointing at this checkout (AGENT_SOURCE_DIR in .env / docker-compose.yml),"
  warn "or the restart did not take. Until they match, Update pushes v${PACKAGED} to every agent."
else
  log "Server packaged agent v${PACKAGED} ✓ (this is what Update will push)"
fi

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
