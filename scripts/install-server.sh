#!/usr/bin/env bash
#
# Installs a NEW BlueEyes server on a customer host.
#
#   ./scripts/install-server.sh
#
# What it does, in order:
#   1) checks the prerequisites (docker + compose, the blueeye-agent sibling),
#   2) asks for the handful of values a customer install actually needs — the
#      licence key above all — and generates the rest (DB passwords, JWT secret),
#   3) writes .env next to docker-compose.yml, mode 0600,
#   4) builds and starts the stack (db + server; migrations run in the server's
#      own start command), and
#   5) smoke-tests the HTTP surface: /health must answer 200, an unknown path
#      404, and an unauthenticated API call 401 — a server that answers 500 to
#      any of those is not installed, it is broken, and this says so.
#
# It is NOT scripts/dev-bootstrap.js. That one writes the vendor's PRIVATE
# licence signing key and demo seeds into .env, neither of which may ever exist
# on a customer host. This writes neither: SEED_DEMO stays 0, no signing key,
# no LICENSE_PUBLIC_KEY (the real install verifies against the key embedded in
# src/license/publicKey.js), no TRUST_ANCHOR_OVERRIDE_ACK.
#
# It is not scripts/deploy.sh either — that UPDATES an install that already
# exists. This one creates it. Run install-server.sh once, deploy.sh forever
# after.
#
# Non-interactive (provisioning, re-runs, CI):
#   BLUEEYE_LICENSE_KEY=ABCD-... ./scripts/install-server.sh --non-interactive
#
# Every prompt has an env override, so any subset can be pre-answered:
#   BLUEEYE_LICENSE_KEY         the licence key issued in blueeye-licens (required)
#   BLUEEYE_PUBLIC_URL          outside URL, e.g. https://blueeye.kunde.dk (recommended)
#   BLUEEYE_TRUST_PROXY         1 when a trusted reverse proxy terminates TLS
#   BLUEEYE_ADMIN_EMAIL         first admin login (default admin@blueeye.local)
#   BLUEEYE_ADMIN_PASSWORD      blank -> the server generates one and prints it once
#   BLUEEYE_SERVER_PORT         host port for the server (default 3000)
#   BLUEEYE_DB_PORT             host port for MySQL, loopback-only (default 3307)
#   BLUEEYE_LICENSE_SERVER_URL  blank -> the vendor's hosted licens
#   BLUEEYE_UPDATE_BUTTON       1 (default) wires Settings -> Updates to deploy.sh
#
# Flags:
#   --non-interactive   never prompt; fail on a missing required value
#   --dry-run           write the .env and stop (no docker, no smoke test)
#   --env-file PATH     write somewhere other than ./.env (testing)
#   --force             overwrite an existing .env (it is backed up first)
#   -h | --help         this header
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$SERVER_DIR/.." && pwd)"
AGENT_DIR="$ROOT_DIR/blueeye-agent"

ENV_PATH="$SERVER_DIR/.env"
INTERACTIVE=1
DRY_RUN=0
FORCE=0

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//; $d'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) INTERACTIVE=0 ;;
    --dry-run)         DRY_RUN=1 ;;
    --force)           FORCE=1 ;;
    --env-file)        shift; [ $# -gt 0 ] || die "--env-file needs a path."; ENV_PATH="$1" ;;
    -h|--help)         usage; exit 0 ;;
    *)                 die "Unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# A pipe or a cron job has no one to answer the questions.
[ -t 0 ] || INTERACTIVE=0

# --- Helpers ---------------------------------------------------------------

# A random URL-safe secret of roughly $1 bytes of entropy. openssl is on almost
# every host; /dev/urandom covers the rest, and node is the last resort so this
# still works on a box that only has docker + node.
rand() {
  local bytes="${1:-24}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$bytes" | tr -d '\n=+/' | cut -c "1-$bytes"
  elif [ -r /dev/urandom ]; then
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$bytes"
  elif command -v node >/dev/null 2>&1; then
    node -e "process.stdout.write(require('crypto').randomBytes($bytes).toString('base64url').slice(0,$bytes))"
  else
    die "No openssl, /dev/urandom or node to generate secrets with."
  fi
}

# ask <var-name> <prompt> <default> — env override wins, then the prompt, then
# the default. Never prompts when non-interactive.
ANSWER=''
ask() {
  local override="$1" prompt="$2" default="${3:-}" reply=''
  if [ -n "$override" ]; then ANSWER="$override"; return 0; fi
  if [ "$INTERACTIVE" = "0" ]; then ANSWER="$default"; return 0; fi
  if [ -n "$default" ]; then
    read -r -p "  $prompt [$default]: " reply || true
  else
    read -r -p "  $prompt: " reply || true
  fi
  ANSWER="${reply:-$default}"
}

# Quote a value for a .env file compose can read: single quotes, with any
# embedded single quote closed and re-opened. A password with a $ or a space in
# it silently breaks an unquoted .env, which then fails much later as a wrong
# DB password.
envq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# --- 1) Prerequisites ------------------------------------------------------

log "Checking prerequisites"

if [ "$DRY_RUN" = "0" ]; then
  if docker compose version >/dev/null 2>&1; then
    DC=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    DC=(docker-compose)
  else
    die "Neither 'docker compose' nor 'docker-compose' is available. Install Docker Engine + Compose v2 first."
  fi
  docker info >/dev/null 2>&1 || die "Docker is installed but not reachable (is the daemon running, and is this user in the 'docker' group?)."
  ok "docker + compose"

  # The server packages and serves the agent SOURCE from this bind mount; without
  # it the enrollment one-liner has nothing to hand an agent.
  if [ ! -d "$AGENT_DIR/.git" ]; then
    die "blueeye-agent not found at $AGENT_DIR.
    Clone the two repos as siblings:
      git clone <blueeye-server> $SERVER_DIR
      git clone <blueeye-agent>  $AGENT_DIR
    Do NOT clone blueeye-licens here — it holds the vendor's signing key."
  fi
  ok "blueeye-agent checkout at $AGENT_DIR"
else
  info "dry run — skipping the docker and checkout checks"
fi

if [ -e "$ENV_PATH" ]; then
  if [ "$FORCE" = "1" ]; then
    backup="$ENV_PATH.bak.$(date +%Y%m%d%H%M%S)"
    cp "$ENV_PATH" "$backup"
    warn "Existing $ENV_PATH backed up to $backup"
  else
    die "$ENV_PATH already exists. This host looks installed — use scripts/deploy.sh to update it, or pass --force to overwrite (the old file is backed up)."
  fi
fi

# --- 2) Answers ------------------------------------------------------------

log "Configuration"
if [ "$INTERACTIVE" = "1" ]; then
  info "Press Enter to accept the default shown in brackets."
fi

ask "${BLUEEYE_LICENSE_KEY:-}" "Licence key (from blueeye-licens)" ""
LICENSE_KEY="$ANSWER"
[ -n "$LICENSE_KEY" ] || die "A licence key is required. Create the customer + licence in blueeye-licens first, then re-run (or set BLUEEYE_LICENSE_KEY)."

ask "${BLUEEYE_PUBLIC_URL:-}" "Public URL clients reach this server on (blank = derive from the request)" ""
PUBLIC_URL="$ANSWER"
case "$PUBLIC_URL" in
  ''|http://*|https://*) ;;
  *) die "BLUEEYE_PUBLIC_URL must start with http:// or https:// (got '$PUBLIC_URL')." ;;
esac

# Behind a TLS-terminating proxy the scheme and client IP only come through the
# X-Forwarded-* headers, and Express ignores them until it is told to trust them.
TRUST_PROXY_DEFAULT=0
case "$PUBLIC_URL" in https://*) TRUST_PROXY_DEFAULT=1 ;; esac
ask "${BLUEEYE_TRUST_PROXY:-}" "Is a trusted reverse proxy in front? (1 = yes)" "$TRUST_PROXY_DEFAULT"
TRUST_PROXY="$ANSWER"

ask "${BLUEEYE_ADMIN_EMAIL:-}" "First admin login (email)" "admin@blueeye.local"
ADMIN_EMAIL="$ANSWER"

ask "${BLUEEYE_ADMIN_PASSWORD:-}" "Admin password (blank = generated and printed once)" ""
ADMIN_PASSWORD="$ANSWER"

ask "${BLUEEYE_SERVER_PORT:-}" "Host port for the dashboard/API" "3000"
SERVER_PORT="$ANSWER"

# Which address the dashboard port is published on. Loopback means the only way
# in is the reverse proxy on this host — which is the point of having one. A
# proxy on ANOTHER host, or no proxy at all, needs a routable address.
BIND_DEFAULT=0.0.0.0
[ "$TRUST_PROXY" = "1" ] && BIND_DEFAULT=127.0.0.1
ask "${BLUEEYE_BIND_ADDR:-}" "Publish the dashboard on which address? (127.0.0.1 = only reachable through a proxy on this host)" "$BIND_DEFAULT"
BIND_ADDR="$ANSWER"

ask "${BLUEEYE_DB_PORT:-}" "Host port for MySQL (loopback only)" "3307"
DB_PORT="$ANSWER"

for p in "$SERVER_PORT" "$DB_PORT"; do
  case "$p" in ''|*[!0-9]*) die "Ports must be whole numbers (got '$p')." ;; esac
  [ "$p" -ge 1 ] && [ "$p" -le 65535 ] || die "Port out of range: $p"
done

ask "${BLUEEYE_LICENSE_SERVER_URL:-}" "Licence server URL (blank = the vendor's hosted licens)" ""
LICENSE_SERVER_URL="$ANSWER"
case "$LICENSE_SERVER_URL" in
  ''|http://*|https://*) ;;
  *) die "The licence server URL must start with http:// or https:// (got '$LICENSE_SERVER_URL')." ;;
esac

ask "${BLUEEYE_UPDATE_BUTTON:-}" "Wire Settings → Updates to scripts/deploy.sh? (1 = yes)" "1"
UPDATE_BUTTON="$ANSWER"

# --- 3) Write .env ---------------------------------------------------------

log "Writing $ENV_PATH"

MYSQL_ROOT_PASSWORD="$(rand 24)"
DB_PASSWORD="$(rand 24)"
SERVER_JWT_SECRET="$(rand 48)"

{
  printf '# BlueEyes server — generated by scripts/install-server.sh on %s.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '# Customer install. Contains secrets — do NOT commit. See .env.example for\n'
  printf '# everything else that can be set (alerting, retention, geo, LDAP, …).\n\n'

  printf '# MySQL (the password is generated; the database is published on loopback only)\n'
  printf 'MYSQL_ROOT_PASSWORD=%s\n' "$(envq "$MYSQL_ROOT_PASSWORD")"
  printf 'DB_USER=blueeye\n'
  printf 'DB_PASSWORD=%s\n' "$(envq "$DB_PASSWORD")"
  printf 'DB_HOST_PORT=%s\n\n' "$DB_PORT"

  printf '# Server\n'
  printf 'SERVER_HOST_PORT=%s\n' "$SERVER_PORT"
  printf 'SERVER_BIND_ADDR=%s\n' "$BIND_ADDR"
  printf 'SERVER_JWT_SECRET=%s\n' "$(envq "$SERVER_JWT_SECRET")"
  printf 'BLUEEYE_PUBLIC_URL=%s\n' "$(envq "$PUBLIC_URL")"
  printf 'TRUST_PROXY=%s\n\n' "$( [ "$TRUST_PROXY" = "1" ] && printf 1 )"

  printf '# First admin (seeded on the first migration; blank password = generated once)\n'
  printf 'ADMIN_EMAIL=%s\n' "$(envq "$ADMIN_EMAIL")"
  printf 'ADMIN_PASSWORD=%s\n\n' "$(envq "$ADMIN_PASSWORD")"

  printf '# Licensing. LICENSE_SERVER_ID is deliberately left unset: the server derives\n'
  printf '# a stable host-specific id and licens binds it on first validation.\n'
  printf '# The trust anchor is the public key embedded in src/license/publicKey.js —\n'
  printf '# never LICENSE_PUBLIC_KEY/TRUST_ANCHOR_OVERRIDE_ACK on a customer host.\n'
  printf 'LICENSE_KEY=%s\n' "$(envq "$LICENSE_KEY")"
  if [ -n "$LICENSE_SERVER_URL" ]; then
    printf 'LICENSE_SERVER_URL=%s\n' "$(envq "$LICENSE_SERVER_URL")"
  else
    printf '#LICENSE_SERVER_URL=\n'
  fi
  printf '\n'

  printf '# No demo data on a customer host.\n'
  printf 'SEED_DEMO=0\n\n'

  if [ "$UPDATE_BUTTON" = "1" ]; then
    printf '# Settings → Updates "Run update" starts exactly this script (no shell).\n'
    printf 'SERVER_UPDATE_COMMAND=%s\n' "$(envq "$SERVER_DIR/scripts/deploy.sh")"
    printf 'SERVER_UPDATE_CWD=%s\n' "$(envq "$SERVER_DIR")"
  else
    printf '# Settings → Updates shows the command to run by hand.\n'
    printf '#SERVER_UPDATE_COMMAND=%s/scripts/deploy.sh\n' "$SERVER_DIR"
  fi
} > "$ENV_PATH"
chmod 600 "$ENV_PATH"
ok "$ENV_PATH (mode 0600)"

if [ "$DRY_RUN" = "1" ]; then
  log "Dry run — stopping before docker."
  info "Start the stack with:  docker compose up -d --build"
  exit 0
fi

# --- 4) Build + start ------------------------------------------------------

log "Building and starting the stack (this takes a few minutes the first time)"
cd "$SERVER_DIR"
"${DC[@]}" up -d --build db server

log "Stack status"
"${DC[@]}" ps

# --- 5) Smoke test ---------------------------------------------------------
#
# Three HTTP codes decide whether this install is real. /health 200 says the
# server booted and reached MySQL; an unknown path 404 says routing is wired
# rather than everything falling into one handler; an unauthenticated API call
# 401 says auth is on. A 500 anywhere here is a failed install — it is reported
# as one, with the log tail, instead of a cheerful "Done".

code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || echo 000
}

BASE="http://localhost:${SERVER_PORT}"

log "Waiting for the server to answer on $BASE/health"
HEALTH=000
for _ in $(seq 1 60); do
  HEALTH="$(code "$BASE/health")"
  [ "$HEALTH" = "200" ] && break
  sleep 2
done

FAILED=0
if [ "$HEALTH" = "200" ]; then
  ok "GET /health -> 200"
else
  warn "GET /health -> $HEALTH (expected 200)"
  FAILED=1
fi

if [ "$HEALTH" = "200" ]; then
  NOT_FOUND="$(code "$BASE/this-route-does-not-exist")"
  if [ "$NOT_FOUND" = "404" ]; then
    ok "GET /this-route-does-not-exist -> 404"
  else
    warn "unknown path -> $NOT_FOUND (expected 404)"
    FAILED=1
  fi

  UNAUTH="$(code "$BASE/license/status")"
  if [ "$UNAUTH" = "401" ]; then
    ok "GET /license/status without a token -> 401"
  else
    warn "unauthenticated /license/status -> $UNAUTH (expected 401)"
    FAILED=1
  fi
fi

if [ "$FAILED" = "1" ]; then
  warn "The smoke test did not pass. Last 40 lines of the server log:"
  "${DC[@]}" logs --tail 40 server || true
  die "Install incomplete — fix the above, then re-run: ${DC[*]} up -d --build server"
fi

# --- Next steps ------------------------------------------------------------

log "Installed"
info "Dashboard:  ${PUBLIC_URL:-$BASE}"
info "Login:      $ADMIN_EMAIL"
if [ -n "$ADMIN_PASSWORD" ]; then
  info "Password:   (the one you entered)"
else
  GENERATED="$("${DC[@]}" logs server 2>/dev/null | sed -n 's/.*[Gg]enerated admin password: *\([^ ]*\).*/\1/p' | tail -1)"
  if [ -n "$GENERATED" ]; then
    info "Password:   $GENERATED   (printed once — save it now)"
  else
    info "Password:   generated at first migration — find it with:"
    info "              ${DC[*]} logs server | grep -i 'admin password'"
  fi
fi
printf '\n'
info "Next:"
info "  1. Open the dashboard and check License — it should read 'valid'."
info "  2. Agents → '+ New agent' for each machine to monitor; the code is one-time."
info "  3. Put TLS in front (reverse proxy) and set BLUEEYE_PUBLIC_URL if you have not."
info "  4. Later updates:  $SERVER_DIR/scripts/deploy.sh"
printf '\n'
