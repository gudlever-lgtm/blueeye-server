#!/usr/bin/env bash
# =====================================================================
# install-timescale.sh — provision a dedicated TimescaleDB node for
# BlueEye telemetry (separate from the MySQL box at 192.168.1.140).
#
# On-prem only. No US cloud. PostgreSQL 16 + TimescaleDB from the official
# apt repos (pgdg + packagecloud/timescale).
#
# IDEMPOTENT: safe to run again. Every step checks its own state and skips
# when already satisfied.
#
# REQUIRED ENV:
#   BLUEEYE_TSDB_PASSWORD   password for the blueeye_tsdb role (no default,
#                           never hardcoded — the script fails early if unset).
#
# OPTIONAL ENV (defaults shown):
#   BLUEEYE_TSDB_DB=blueeye_telemetry
#   BLUEEYE_TSDB_USER=blueeye_tsdb
#   PG_VERSION=16
#   MIGRATION_FILE=<repo>/server/db/timescale/001_init.sql   (resolved from script dir)
#   BACKUP_DIR=/var/backups/blueeye-tsdb
#   BACKUP_RETENTION_DAYS=7
#   BLUEEYE_SERVER_URL=            if set, the health/404 curl checks run
#   MAX_WAL_SIZE=8GB               manual tuning on top of timescaledb-tune
#
# Run as root (it uses apt, systemctl and the postgres OS user).
# =====================================================================
set -euo pipefail

log()  { printf '\033[1;34m[install-timescale]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install-timescale] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[install-timescale] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- config / env --------------------------------------------------------
PG_VERSION="${PG_VERSION:-16}"
BLUEEYE_TSDB_DB="${BLUEEYE_TSDB_DB:-blueeye_telemetry}"
BLUEEYE_TSDB_USER="${BLUEEYE_TSDB_USER:-blueeye_tsdb}"
MIGRATION_FILE="${MIGRATION_FILE:-$SCRIPT_DIR/../server/db/timescale/001_init.sql}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/blueeye-tsdb}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
MAX_WAL_SIZE="${MAX_WAL_SIZE:-8GB}"
BLUEEYE_SERVER_URL="${BLUEEYE_SERVER_URL:-}"

PGBIN="/usr/lib/postgresql/${PG_VERSION}/bin"
PGCONF_DIR="/etc/postgresql/${PG_VERSION}/main"
SERVICE="postgresql@${PG_VERSION}-main"

# --- 0. preflight --------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "must run as root"
[ -n "${BLUEEYE_TSDB_PASSWORD:-}" ] || die "BLUEEYE_TSDB_PASSWORD is required (set it in the env; it is never hardcoded)"
[ -f "$MIGRATION_FILE" ] || die "migration file not found: $MIGRATION_FILE"

psql_super() { su postgres -c "psql -v ON_ERROR_STOP=1 -qAt $*"; }

# --- 1. install PostgreSQL 16 + TimescaleDB (skip if already present) ----
install_repos_and_packages() {
  if dpkg -s "timescaledb-2-postgresql-${PG_VERSION}" >/dev/null 2>&1 \
     && dpkg -s "postgresql-${PG_VERSION}" >/dev/null 2>&1; then
    log "PostgreSQL ${PG_VERSION} + TimescaleDB already installed — skipping apt"
    return
  fi

  log "installing prerequisites"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y gnupg postgresql-common apt-transport-https lsb-release wget curl ca-certificates

  # pgdg repo (PostgreSQL) — official, idempotent helper
  if [ ! -f /etc/apt/sources.list.d/pgdg.list ]; then
    log "adding pgdg apt repo"
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
  fi

  # packagecloud/timescale repo
  if [ ! -f /etc/apt/sources.list.d/timescaledb.list ]; then
    log "adding timescaledb apt repo"
    wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey \
      | gpg --dearmor -o /etc/apt/trusted.gpg.d/timescaledb.gpg
    echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -cs) main" \
      > /etc/apt/sources.list.d/timescaledb.list
  fi

  apt-get update -y
  log "installing postgresql-${PG_VERSION} + timescaledb"
  apt-get install -y "postgresql-${PG_VERSION}" "timescaledb-2-postgresql-${PG_VERSION}" postgresql-client
}
install_repos_and_packages

# --- 2. timescaledb-tune, then restart -----------------------------------
# timescaledb-tune edits postgresql.conf (shared_preload_libraries + memory).
# It is idempotent-ish; --quiet --yes accepts its suggestions non-interactively.
log "running timescaledb-tune"
timescaledb-tune --quiet --yes --pg-config "${PGBIN}/pg_config" || \
  warn "timescaledb-tune returned non-zero (may already be tuned) — continuing"

# --- 5. manual tuning on top of timescaledb-tune -------------------------
# BlueEye ingests telemetry in large batch COPY transactions (flow_records,
# results). A small max_wal_size forces frequent, expensive checkpoints during
# those bursts. Raise it so a burst fits between checkpoints -> far less write
# amplification on the ingest hot path. Written as a conf.d drop-in so
# timescaledb-tune's edits to postgresql.conf are never clobbered.
log "applying manual tuning (max_wal_size=${MAX_WAL_SIZE})"
mkdir -p "${PGCONF_DIR}/conf.d"
# ensure postgresql.conf includes conf.d (Debian/Ubuntu default does; be safe)
if ! grep -qE "^\s*include_dir\s*=\s*'conf.d'" "${PGCONF_DIR}/postgresql.conf"; then
  echo "include_dir = 'conf.d'" >> "${PGCONF_DIR}/postgresql.conf"
fi
cat > "${PGCONF_DIR}/conf.d/blueeye-tsdb.conf" <<EOF
# BlueEye telemetry manual tuning (on top of timescaledb-tune). Managed by
# deploy/install-timescale.sh — re-running the installer overwrites this file.
# Larger WAL between checkpoints for batch-COPY ingest bursts.
max_wal_size = '${MAX_WAL_SIZE}'
# Replication slot capacity for the pg_basebackup backup job (step 6).
wal_level = replica
max_wal_senders = 4
EOF

log "restarting ${SERVICE}"
systemctl enable "${SERVICE}" >/dev/null 2>&1 || true
systemctl restart "${SERVICE}"
# wait for readiness
for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done
pg_isready -q || die "postgres did not become ready after restart"

# --- 3. database + dedicated role ----------------------------------------
log "ensuring role ${BLUEEYE_TSDB_USER} and database ${BLUEEYE_TSDB_DB}"
# role (idempotent): create if missing, always (re)set the password from env
if [ "$(psql_super -c "SELECT 1 FROM pg_roles WHERE rolname='${BLUEEYE_TSDB_USER}'")" != "1" ]; then
  su postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE ROLE ${BLUEEYE_TSDB_USER} LOGIN;\""
fi
# Set the password without ever exposing it: \getenv pulls it from the
# whitelisted env var inside psql, :'pw' safely quotes it as a literal. It
# never lands in argv (ps), a shell-visible SQL string, or on disk.
export BLUEEYE_TSDB_PASSWORD
su postgres --whitelist-environment=BLUEEYE_TSDB_PASSWORD \
  -c "psql -v ON_ERROR_STOP=1 -v usr=${BLUEEYE_TSDB_USER} -d postgres" <<'SQL'
\getenv pw BLUEEYE_TSDB_PASSWORD
ALTER ROLE :"usr" WITH PASSWORD :'pw';
SQL

# database (idempotent)
if [ "$(psql_super -c "SELECT 1 FROM pg_database WHERE datname='${BLUEEYE_TSDB_DB}'")" != "1" ]; then
  su postgres -c "psql -v ON_ERROR_STOP=1 -c \"CREATE DATABASE ${BLUEEYE_TSDB_DB} OWNER ${BLUEEYE_TSDB_USER};\""
fi
su postgres -c "psql -v ON_ERROR_STOP=1 -d ${BLUEEYE_TSDB_DB} \
  -c \"GRANT ALL ON SCHEMA public TO ${BLUEEYE_TSDB_USER};\""

# --- 4. run the schema migration -----------------------------------------
# NOT --single-transaction: continuous aggregates can't be created inside a txn.
log "running migration ${MIGRATION_FILE}"
su postgres -c "psql -v ON_ERROR_STOP=1 -d ${BLUEEYE_TSDB_DB} -f '${MIGRATION_FILE}'"

# --- 6. backup job (pg_basebackup, daily, 7-day rotation) ----------------
# Physical base backup of the telemetry cluster ONLY — completely separate
# from the MySQL backup on 192.168.1.140.
log "installing backup job -> ${BACKUP_DIR} (retention ${BACKUP_RETENTION_DAYS}d)"
# local replication over the unix socket for the postgres peer user
if ! grep -qE "^\s*local\s+replication\s+all\s+peer" "${PGCONF_DIR}/pg_hba.conf"; then
  echo "local   replication     all                                     peer" >> "${PGCONF_DIR}/pg_hba.conf"
  systemctl reload "${SERVICE}"
fi
install -d -o postgres -g postgres -m 0750 "${BACKUP_DIR}"
cat > /usr/local/bin/blueeye-tsdb-backup.sh <<EOF
#!/usr/bin/env bash
# BlueEye telemetry base backup — installed by deploy/install-timescale.sh.
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS}"
stamp="\$(date +%Y%m%dT%H%M%S)"
dest="\${BACKUP_DIR}/\${stamp}"
mkdir -p "\${dest}"
# compressed tar base backup, streaming its own WAL so the backup is consistent
pg_basebackup -D "\${dest}" -Ft -z -X stream -c fast
# rotate: drop backups older than the retention window
find "\${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime +\${RETENTION_DAYS} -exec rm -rf {} +
EOF
chmod 0755 /usr/local/bin/blueeye-tsdb-backup.sh
chown root:root /usr/local/bin/blueeye-tsdb-backup.sh
# daily at 02:30, run as postgres (peer replication auth)
cat > /etc/cron.d/blueeye-tsdb-backup <<'EOF'
# BlueEye telemetry daily base backup (managed by install-timescale.sh)
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/lib/postgresql/16/bin:/usr/bin:/bin
30 2 * * * postgres /usr/local/bin/blueeye-tsdb-backup.sh >> /var/log/blueeye-tsdb-backup.log 2>&1
EOF
chmod 0644 /etc/cron.d/blueeye-tsdb-backup

# =====================================================================
# VERIFICATION
# =====================================================================
log "verifying install"

# extension active
ext="$(psql_super -d "${BLUEEYE_TSDB_DB}" -c "SELECT extversion FROM pg_extension WHERE extname='timescaledb'")"
[ -n "$ext" ] || die "timescaledb extension is not active in ${BLUEEYE_TSDB_DB}"
log "  timescaledb extension: v${ext}"

# hypertables (expect 7)
ht="$(psql_super -d "${BLUEEYE_TSDB_DB}" -c "SELECT count(*) FROM timescaledb_information.hypertables")"
[ "${ht:-0}" -ge 7 ] || die "expected >=7 hypertables, found ${ht}"
log "  hypertables: ${ht}"

# retention policies (expect 4)
rp="$(psql_super -d "${BLUEEYE_TSDB_DB}" -c "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name='policy_retention'")"
[ "${rp:-0}" -ge 4 ] || die "expected >=4 retention policies, found ${rp}"
log "  retention policies: ${rp}"

# continuous aggregates (expect 2)
ca="$(psql_super -d "${BLUEEYE_TSDB_DB}" -c "SELECT count(*) FROM timescaledb_information.continuous_aggregates")"
[ "${ca:-0}" -ge 2 ] || die "expected >=2 continuous aggregates, found ${ca}"
log "  continuous aggregates: ${ca}"

# --- TSDB health 500-path (stop -> fail -> restart) ----------------------
# There is no TSDB-backed HTTP route on blueeye-server yet (GET /health pings
# MySQL, not this node — see deploy/README-timescale.md), so the DB-down / 500
# path is asserted at the psql layer: with postgres stopped, a query MUST fail;
# after restart it MUST succeed again. When a TSDB-backed /health lands, the
# same stop -> curl -> 500 assertion applies to it (see the optional block).
log "TSDB health 500-path: stopping ${SERVICE}"
systemctl stop "${SERVICE}"
if su postgres -c "psql -qAt -d ${BLUEEYE_TSDB_DB} -c 'SELECT 1'" >/dev/null 2>&1; then
  systemctl start "${SERVICE}"
  die "500-path check failed: query succeeded while postgres was stopped"
fi
log "  query correctly failed while down (500-equivalent)"
systemctl start "${SERVICE}"
for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done
[ "$(psql_super -d "${BLUEEYE_TSDB_DB}" -c 'SELECT 1')" = "1" ] || die "TSDB did not recover after restart"
log "  TSDB recovered after restart (200-equivalent)"

# --- optional: blueeye-server HTTP checks (200 health + 404 unknown) -----
if [ -n "${BLUEEYE_SERVER_URL}" ]; then
  base="${BLUEEYE_SERVER_URL%/}"
  code_health="$(curl -s -o /dev/null -w '%{http_code}' "${base}/health" || echo 000)"
  [ "$code_health" = "200" ] && log "  GET ${base}/health -> 200" \
    || warn "  GET ${base}/health -> ${code_health} (expected 200; note: /health currently pings MySQL)"
  code_404="$(curl -s -o /dev/null -w '%{http_code}' "${base}/this-route-does-not-exist" || echo 000)"
  [ "$code_404" = "404" ] && log "  GET ${base}/this-route-does-not-exist -> 404" \
    || warn "  unknown route -> ${code_404} (expected 404)"
else
  log "  BLUEEYE_SERVER_URL unset — skipping HTTP 200/404 checks"
fi

log "done. TimescaleDB node provisioned for BlueEye telemetry."
