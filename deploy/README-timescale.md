# Deploying the BlueEye TimescaleDB telemetry node

`install-timescale.sh` provisions a **dedicated** Ubuntu node for BlueEye
telemetry, separate from the MySQL server (`192.168.1.140`). It installs
PostgreSQL 16 + TimescaleDB from the official apt repos, tunes it for
batch-COPY ingest, applies the schema, wires a daily backup, and verifies the
result. On-prem only — no US cloud.

The script is **idempotent**: re-running it re-checks every step and skips what
is already done.

## Prerequisites

- Ubuntu (uses `apt`, `systemd`, the `postgres` OS user), run as **root**.
- Outbound access to the pgdg and packagecloud/timescale apt repos.
- The schema migration at `server/db/timescale/001_init.sql` present in the
  repo checkout (the script resolves it relative to its own location).

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `BLUEEYE_TSDB_PASSWORD` | **yes** | — | Password for the `blueeye_tsdb` role. No default; the script **fails early** if unset. Never hardcode it. |
| `BLUEEYE_TSDB_DB` | no | `blueeye_telemetry` | Telemetry database name |
| `BLUEEYE_TSDB_USER` | no | `blueeye_tsdb` | Dedicated login role |
| `PG_VERSION` | no | `16` | PostgreSQL major version |
| `MIGRATION_FILE` | no | `<repo>/server/db/timescale/001_init.sql` | Schema migration to apply |
| `MAX_WAL_SIZE` | no | `8GB` | Manual tuning on top of `timescaledb-tune` |
| `BACKUP_DIR` | no | `/var/backups/blueeye-tsdb` | Base-backup target (separate from MySQL backups) |
| `BACKUP_RETENTION_DAYS` | no | `7` | Backup rotation window |
| `BLUEEYE_SERVER_URL` | no | — | If set, runs the HTTP `200 /health` + `404 unknown-route` checks |

## Run order

```bash
# 1. On the dedicated telemetry node, as root, from the repo checkout:
export BLUEEYE_TSDB_PASSWORD='…from your secret store…'   # required
sudo -E deploy/install-timescale.sh
```

What it does, in order:

1. Install PostgreSQL 16 + TimescaleDB (pgdg + packagecloud repos). Skipped if
   already installed.
2. `timescaledb-tune --quiet --yes`.
3. Manual tuning drop-in (`conf.d/blueeye-tsdb.conf`): `max_wal_size`,
   `wal_level=replica`, `max_wal_senders` — then restart.
4. Create role `blueeye_tsdb` (password from env, set via psql `\getenv` so it
   never appears in `ps`/logs/disk) and database `blueeye_telemetry`.
5. Apply `server/db/timescale/001_init.sql` (per-statement, **not**
   `--single-transaction` — continuous aggregates can't be created in a txn).
6. Install `/usr/local/bin/blueeye-tsdb-backup.sh` + `/etc/cron.d/blueeye-tsdb-backup`
   (daily 02:30, `pg_basebackup`, 7-day rotation).

## Verification (done automatically at the end of the run)

- `timescaledb` extension active in the telemetry DB.
- ≥ 7 hypertables present.
- ≥ 4 retention policies registered.
- ≥ 2 continuous aggregates present.
- **500-path:** stop PostgreSQL → a query **must fail** → restart → query
  succeeds again.
- **200 / 404 (optional):** if `BLUEEYE_SERVER_URL` is set, `GET /health` → 200
  and `GET /<unknown>` → 404.

### Note on the health 500-path

When the server runs with `TSDB_ENABLED=true`, `GET /health` now pings **both**
MySQL and this telemetry node and returns `503 {tsdb:"down"}` if the TSDB is
unreachable — so a *stop PostgreSQL → curl `/health` → expect 503* assertion is
now meaningful end-to-end. The installer still also asserts the DB-down path
directly at the psql layer (stop → query fails → restart → recovers), which
holds even when `BLUEEYE_SERVER_URL` is not provided or the server has TSDB
disabled. The optional HTTP block covers the 200 (healthy) and 404
(unknown-route) cases.

Re-run the checks by hand any time:

```bash
sudo -u postgres psql -d blueeye_telemetry -c \
  "SELECT count(*) FROM timescaledb_information.hypertables;"          # 7
sudo -u postgres psql -d blueeye_telemetry -c \
  "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name='policy_retention';"  # 4
sudo -u postgres psql -d blueeye_telemetry -c \
  "SELECT view_name FROM timescaledb_information.continuous_aggregates;"                    # flow_rollup, metric_rollup
```

## Backups & restore

Backups are compressed `pg_basebackup` tarballs under `BACKUP_DIR`, one
timestamped directory per day, pruned after `BACKUP_RETENTION_DAYS`. This is
independent of the MySQL backup on `192.168.1.140`.

Restore outline (telemetry data only — MySQL is untouched):

```bash
systemctl stop postgresql@16-main
rm -rf /var/lib/postgresql/16/main/*
tar -xzf /var/backups/blueeye-tsdb/<stamp>/base.tar.gz -C /var/lib/postgresql/16/main
tar -xzf /var/backups/blueeye-tsdb/<stamp>/pg_wal.tar.gz -C /var/lib/postgresql/16/main/pg_wal
chown -R postgres:postgres /var/lib/postgresql/16/main
systemctl start postgresql@16-main
```

## Rollback

The installer only **adds** to the telemetry node and never touches MySQL, so
rollback is local to this node:

- **Schema only:** see the rollback section in
  [`server/db/timescale/README.md`](../server/db/timescale/README.md).
- **Whole node:** `systemctl disable --now postgresql@16-main`, remove the cron
  file `/etc/cron.d/blueeye-tsdb-backup`, and (optionally)
  `apt-get purge 'postgresql-16' 'timescaledb-2-postgresql-16'`. BlueEye keeps
  writing telemetry to MySQL until the repository-split phase cuts over, so the
  application keeps working throughout.
