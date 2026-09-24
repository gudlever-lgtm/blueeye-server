-- 124 — transaction phase timings + test-scoped header captures.
--
-- THE QUESTION THIS ANSWERS. "The system is slow" becomes, every single time,
-- "is that the network or the application?" — and until now nothing in this
-- schema could answer it. A transaction result carried ONE number per step: the
-- wall time from just before the request to the end of the response body. A
-- 4200 ms step could be a slow name server, a slow handshake, a slow
-- application or a slow download, and the row read identically in all four
-- cases.
--
-- Two columns of new evidence, at two levels of cost.
--
-- 1. step_phases — free, and where most answers are
--
-- The agent already had this in its hand: a Node socket emits `lookup`,
-- `connect` and `secureConnect`, and the response callback fires on the first
-- response byte. The split is dns / tcp / tls / ttfb / transfer, and `tcp` on
-- its own IS the network round-trip time, because a TCP handshake is exactly
-- one. No privileges, no capture, every platform.
--
-- It is a SEPARATE column from step_timings rather than a replacement. The
-- baselines (transaction_baselines) and the deviation detector index on
-- step_timings; a second definition of "how long the step took" would be a
-- second thing to keep in step with the first.
--
-- NULL inside a phase record is not zero. It means the moment never happened —
-- no TLS on a plain http step, no handshake at all on a step that reused a
-- keep-alive socket. A dashboard that renders a missing handshake as an instant
-- one is lying about the most interesting case.
--
-- 2. transaction_captures — the layer below, for what timings cannot see
--
-- Retransmissions, duplicate ACKs, resets, zero windows, MSS mismatch. A 900 ms
-- handshake looks the same whether the SYN was sent three times or the server
-- was slow to accept, and those are different faults with different owners.
--
-- WHY THIS TABLE IS NOT A PRIVACY PROBLEM, and what enforces it:
--   * The agent's filter is DERIVED FROM THE TEST, never typed by anyone. It
--     can only ever name an endpoint the test itself is about to talk to.
--   * snaplen is 96 bytes and fixed. Headers, not bodies.
--   * `packets` holds decoded header FIELDS — addresses, ports, flags, seq/ack,
--     window, ttl, mss — and a payload byte COUNT. Never payload bytes, never a
--     DNS question name, never a TLS SNI, never an HTTP host or path.
--   * Under the default `on_fault` mode the capture is discarded on the agent
--     for every run that passed. Rows here exist because something went wrong.
--
-- WHY packets IS A JSON COLUMN AND NOT A TABLE. Same argument as burst_runs
-- (migration 107): a capture is at most 2000 records, bounded by the agent,
-- written once and read as a whole. It is never queried across captures, never
-- aggregated and never grows after the run ends. That is a FIELD. A row-per-
-- packet table would add a hot-path insert loop, a second retention dimension
-- and a join to every read, for nothing.
--
-- NO FOREIGN KEYS, and the key is (test_id, agent_id, time) — the same three
-- columns transaction_results carries. The result and the capture arrive as two
-- separate WebSocket frames, so neither may depend on the other having been
-- written first; matching on a natural key rather than an id means either order
-- works, and a capture whose result was dropped is still readable evidence.

ALTER TABLE transaction_results
  ADD COLUMN step_phases JSON DEFAULT NULL AFTER step_timings;

-- `capture` on the test says whether the agent captures around its runs at all.
-- 'off' is the default, and it is the value that means tcpdump is never spawned
-- — not "spawned and thrown away".
ALTER TABLE transaction_tests
  ADD COLUMN capture ENUM('off','on_fault','always') NOT NULL DEFAULT 'off' AFTER interval_sec;

CREATE TABLE IF NOT EXISTS transaction_captures (
  time        DATETIME(3) NOT NULL,
  test_id     INT         NOT NULL,
  agent_id    INT         NOT NULL,
  -- Why this capture was kept: 'requested' (somebody asked for this run),
  -- 'always', 'status:timeout', 'latency:4200ms>1000ms'. A row that cannot say
  -- why it exists is a row nobody can justify keeping.
  reason      VARCHAR(64)     DEFAULT NULL,
  iface       VARCHAR(32)     DEFAULT NULL,
  -- The exact expression tcpdump ran. Stored so the scope of what was collected
  -- is auditable after the fact, not merely asserted.
  filter      VARCHAR(512)    DEFAULT NULL,
  snaplen     SMALLINT UNSIGNED DEFAULT NULL,
  duration_ms INT             DEFAULT NULL,
  -- observed: how many packets matched the filter. packet_count: how many were
  -- kept after narrowing to the run's own local ports. foreign_count: the
  -- difference — another local conversation with the same far end, discarded on
  -- the agent. Reported rather than hidden: it is the honest measure of how
  -- sharply the capture was scoped.
  observed      INT UNSIGNED  DEFAULT NULL,
  packet_count  INT UNSIGNED  NOT NULL DEFAULT 0,
  foreign_count INT UNSIGNED  DEFAULT NULL,
  -- The capture hit its 2000-packet ceiling, so the series is a prefix of what
  -- happened rather than all of it. A verdict computed on a truncated capture
  -- says so.
  truncated   TINYINT(1)  NOT NULL DEFAULT 0,
  packets     JSON            DEFAULT NULL,
  -- The verdict, computed once from the packets (src/analysis/captureAnalysis.js)
  -- and kept, so the row reads the same in a report six weeks later as it did on
  -- the screen. Same rule every finding in this product follows.
  pattern          VARCHAR(32)  DEFAULT NULL,
  explanation      VARCHAR(512) DEFAULT NULL,
  retransmits      INT UNSIGNED DEFAULT NULL,
  dup_acks         INT UNSIGNED DEFAULT NULL,
  resets           INT UNSIGNED DEFAULT NULL,
  zero_windows     INT UNSIGNED DEFAULT NULL,
  syn_unanswered   INT UNSIGNED DEFAULT NULL,
  handshake_rtt_ms DECIMAL(10, 3) DEFAULT NULL,
  mss              SMALLINT UNSIGNED DEFAULT NULL,
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (test_id, agent_id, time),
  INDEX idx_txc_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
