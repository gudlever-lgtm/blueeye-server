-- 030 — the agent-release signing key, generated + managed from the dashboard
-- (Settings → Agent signing key). A single Ed25519 key pair created ON the server:
-- the PRIVATE key is stored ENCRYPTED at rest (AES-256-GCM via src/lib/secretBox.js)
-- in private_pem_encrypted and is NEVER returned by the API — it is decrypted only
-- in memory to sign agent releases. The PUBLIC key (not secret) is served to agents
-- so they can verify signed self-updates. Write-once + deletable: at most one row
-- (the UNIQUE singleton column is the backstop). Without a key the server can
-- neither onboard new agents nor sign upgrades.
CREATE TABLE IF NOT EXISTS agent_release_key (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  singleton TINYINT UNSIGNED NOT NULL DEFAULT 1,   -- enforces at most one key row
  public_pem TEXT NOT NULL,
  private_pem_encrypted TEXT NOT NULL,             -- secretBox token; never plaintext, never returned
  fingerprint CHAR(64) NOT NULL,                   -- sha256(public_pem), hex — a non-secret identifier
  created_by INT UNSIGNED NULL DEFAULT NULL,       -- user id that generated it
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_agent_release_key_singleton (singleton)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
