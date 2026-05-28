-- BlueEye server — canonical database schema (full snapshot).
--
-- Two ways to set up a database:
--   1) Run the migration runner (recommended):   npm run migrate
--      It applies the ordered files in migrations/ and records them in
--      schema_migrations, so it is safe to re-run.
--   2) Load this snapshot directly into a fresh DB:
--        mysql -u <user> -p <database> < schema.sql
--
-- migrations/ is the source of truth for incremental changes; this file is
-- kept in sync as a convenient full picture of the current schema.

SET NAMES utf8mb4;

-- Bookkeeping table used by the migration runner (src/migrate.js).
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  filename VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_schema_migrations_filename (filename)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Physical sites / offices, e.g. "Aarhus – Hovedkontor".
CREATE TABLE IF NOT EXISTS locations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
