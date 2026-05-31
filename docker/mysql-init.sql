-- Creates both application databases and grants the app user access to them.
-- Runs once on first MySQL container start (docker-entrypoint-initdb.d).
CREATE DATABASE IF NOT EXISTS blueeye CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS blueeye_licens CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON blueeye.* TO 'blueeye'@'%';
GRANT ALL PRIVILEGES ON blueeye_licens.* TO 'blueeye'@'%';
FLUSH PRIVILEGES;
