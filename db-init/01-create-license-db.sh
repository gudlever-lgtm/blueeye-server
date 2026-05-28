#!/bin/sh
set -e

# Create the second database used by the License Server. Reuses the same
# postgres user, separate database for separation of concerns.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
SELECT 'CREATE DATABASE licenses'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'licenses')\gexec
EOSQL
