'use strict';

const { WebSocketServer } = require('ws');
const { createAgentAuthenticator } = require('../auth/agentAuth');
const { extractToken, pathnameOf, safeSend, startHeartbeat } = require('./wsCommon');
const { PROTOCOL_VERSION } = require('../protocol');
const { validateResultIngest } = require('../validation/transactionValidation');
const { evaluateTransactionAlert } = require('../analysis/transactionAlerts');

const silentLogger = { info() {}, warn() {}, error() {} };

// The hsflowd exporter states an agent may report (mirrors the agent's vocabulary).
const HSFLOWD_STATES = ['active', 'inactive', 'failed', 'not_installed', 'install_failed', 'permission_denied', 'unknown'];

// Best source IP for a connecting agent: first X-Forwarded-For hop when present
// (proxied deployments), else the socket peer. Bounded for the audit row.
function clientIp(req) {
  const xff = req && req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim().slice(0, 64);
  const ip = (req && req.socket && req.socket.remoteAddress) || '';
  return ip ? ip.slice(0, 64) : null;
}

// Attaches the agent WebSocket endpoint to an existing HTTP server. Agent-token
// auth is enforced during the upgrade handshake — a connection without a valid
// token is rejected hard (no WebSocket is ever established).
function attachAgentWebSocket({
  server,
  agentTokensRepo,
  agentsRepo,
  // Optional: completes the audit row for a server-initiated action when the
  // agent reports its result (upgrade/delete/install-tool).
  auditRepo = null,
  // Optional: the unified audit trail — records the OUTCOME of an install-tool
  // and agent-reported operational errors (`agent.error`) so operators see them
  // (and why) under Reporting → Audit.
  auditEventsRepo = null,
  logger = silentLogger,
  path = '/ws/agent',
  heartbeatMs = 30000,
  // Capacity/licence gate. Receives the current connection count and returns
  // whether a new agent connection may be accepted. Defaults to always-allow.
  licenseGuard = () => true,
  // Optional: pushes live agent online/offline events to the dashboard channel.
  notifyDashboard = null,
  // Optional transaction-test channel: the repo (config push + result ingest),
  // the alerting dispatcher, and whether alerting is on (bool or live getter).
  // All null/off by default so the socket works unchanged without them.
  transactionsRepo = null,
  alertDispatcher = null,
  alertingEnabled = false,
}) {
  const authenticator = createAgentAuthenticator({ agentTokensRepo });
  // Cap inbound frames at 1 MB (aligns with the Express body limit). ws defaults
  // to 100 MB, which any token holder could use to pressure memory on JSON.parse.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  // Liveness UPDATEs are throttled per socket: agents heartbeat every ~15s, so
  // writing last_seen on every pong/frame is mostly redundant churn on a row the
  // dashboard reads. One write per minute is enough to drive online/offline.
  const TOUCH_THROTTLE_MS = 60000;
  function maybeTouchLastSeen(ws, agentId) {
    const now = Date.now();
    if (ws._lastSeenAt && now - ws._lastSeenAt < TOUCH_THROTTLE_MS) return;
    ws._lastSeenAt = now;
    agentsRepo.touchLastSeen(agentId).catch(() => {});
  }

  // Audits an agent connect/disconnect transition (agent.online / agent.offline)
  // in the unified trail, so operators have a timeline of agent availability — not
  // just the live status flag. Discrete rows (the sequence is the point), so a
  // server restart or a flapping link reads as the transitions it actually was.
  // Best-effort: a recording failure must never affect the connection lifecycle.
  function recordAgentAudit(action, agentId, ip) {
    if (!auditEventsRepo || typeof auditEventsRepo.record !== 'function') return;
    Promise.resolve(auditEventsRepo.record({ actorType: 'agent', actorId: agentId, action, ip: ip || null }))
      .catch((err) => logger.error(`Failed to record ${action} audit event:`, err));
  }

  // Correlated server -> agent requests: sendCommandAndWait() stores a waiter
  // keyed by a command id; the agent echoes that id back in an 'ack' frame and
  // we resolve it. Powers the dashboard "Ping" (liveness) and "Update" buttons.
  const pending = new Map(); // id -> { resolve, timer, delivered }
  let seq = 0;

  // Latest hsflowd exporter state each agent has reported. In-memory: agents
  // re-report on every reconnect (their reconcile runs on WS open), so this
  // repopulates after a server restart without needing a DB column.
  const sflowStatus = new Map(); // agentId -> { state, detail, at }

  server.on('upgrade', (req, socket, head) => {
    // Cooperative: only claim our path and ignore the rest, so sibling WS
    // servers on the same HTTP server (e.g. the dashboard socket) can handle
    // theirs. Truly unknown paths are rejected by a fallback in server.js.
    if (pathnameOf(req) !== path) return;

    authenticator
      .verifyToken(extractToken(req))
      .then((agent) => {
        if (!agent) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        // License/capacity gate (token is valid; this is a separate concern).
        if (!licenseGuard(wss.clients.size)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          logger.warn('Rejected agent connection: license invalid or agent limit reached.');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, agent);
        });
      })
      .catch((err) => {
        logger.error('Agent WS auth failed:', err);
        try {
          socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
        } catch {
          /* socket may already be gone */
        }
        socket.destroy();
      });
  });

  wss.on('connection', (ws, req, agent) => {
    ws.agentId = agent.agentId;
    ws.isAlive = true;
    ws._remoteIp = clientIp(req); // captured here so the offline row can reuse it

    agentsRepo
      .setStatus(agent.agentId, 'online')
      .catch((err) => logger.error('Failed to mark agent online:', err));
    if (typeof notifyDashboard === 'function') {
      try { notifyDashboard({ type: 'agent-status', payload: { agentId: agent.agentId, status: 'online' } }); } catch { /* best-effort */ }
    }
    recordAgentAudit('agent.online', agent.agentId, ws._remoteIp);

    // Protocol-version handshake. The agent declares its wire-contract version in
    // the upgrade header; absent means a pre-versioning agent (→ v1). A mismatch
    // is logged but NEVER fatal (agents update on their own schedule; the server
    // stays backward-compatible). The server echoes its own version below.
    const declared = Number(req && req.headers && req.headers['x-blueeye-protocol']);
    const agentProtocol = Number.isInteger(declared) && declared > 0 ? declared : 1;
    if (agentProtocol !== PROTOCOL_VERSION) {
      logger.warn(`Agent ${agent.agentId} protocol v${agentProtocol} != server v${PROTOCOL_VERSION}; continuing (backward-compatible).`);
    }

    // Initial server -> agent message (also demonstrates the push channel).
    safeSend(ws, { type: 'connected', agentId: agent.agentId, protocolVersion: PROTOCOL_VERSION });

    // Push the agent's currently-assigned transaction tests so it starts running
    // them immediately (and reloads on every reconnect). Best-effort.
    pushTransactionConfig(agent.agentId).catch((err) => logger.error('transaction_config push on connect failed:', err));

    ws.on('pong', () => {
      ws.isAlive = true;
      maybeTouchLastSeen(ws, agent.agentId);
    });

    ws.on('message', (data) => {
      // Any inbound frame counts as a sign of life (throttled to ~1/min).
      maybeTouchLastSeen(ws, agent.agentId);
      // Resolve a correlated request: the agent echoes the command id in an
      // 'ack' (or 'command-result') frame. Heartbeats and other frames are
      // ignored here. Parsing is defensive — a bad frame must not crash the hub.
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if ((msg.type === 'ack' || msg.type === 'command-result') && msg.id != null) {
        const waiter = pending.get(msg.id);
        if (waiter) {
          pending.delete(msg.id);
          clearTimeout(waiter.timer);
          waiter.resolve({ delivered: waiter.delivered, acked: true, reply: msg });
        }
      }
      // agent -> server: hsflowd exporter status (the enable/disable feedback loop).
      if (msg.type === 'sflow.status') {
        const state = HSFLOWD_STATES.includes(msg.state) ? msg.state : 'unknown';
        const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, 300) : null;
        sflowStatus.set(ws.agentId, { state, detail, at: new Date().toISOString() });
        if (typeof notifyDashboard === 'function') {
          try { notifyDashboard({ type: 'sflow-status', payload: { agentId: ws.agentId, state, detail } }); } catch { /* best-effort */ }
        }
      }
      // agent -> server: a non-fatal operational error the agent hit (couldn't
      // submit a measurement, fetch its config, run a scheduled probe, …).
      // Recorded in the unified audit trail (Reporting → Audit) as 'agent.error',
      // collapsed per (agent, category[, code]) via the dedup key so a recurring
      // failure is one annotated row, not a flood. Metadata only — `message` is
      // the agent's Error text, never measured payload. Best-effort: a bad frame
      // or a repo error must never break the hub.
      if (msg.type === 'agent.error' && auditEventsRepo && typeof auditEventsRepo.recordRecurring === 'function') {
        const category = (typeof msg.category === 'string' && msg.category.trim() ? msg.category.trim() : 'general').slice(0, 48);
        const code = typeof msg.code === 'string' && msg.code ? msg.code.slice(0, 48) : null;
        const reason = typeof msg.message === 'string' ? msg.message.slice(0, 300) : null;
        auditEventsRepo.recordRecurring({
          actorType: 'agent', actorId: ws.agentId,
          action: 'agent.error', targetType: category, targetLabel: code,
          detail: { reason, code },
          dedupKey: `agent:${ws.agentId}:error:${category}${code ? `:${code}` : ''}`,
        }).catch((err) => logger.error('Failed to record agent.error audit event:', err));
        if (typeof notifyDashboard === 'function') {
          try { notifyDashboard({ type: 'agent-error', payload: { agentId: ws.agentId, category, code, reason } }); } catch { /* best-effort */ }
        }
      }
      // agent -> server: result of a server-initiated action (upgrade/delete).
      // Completes the audit row, and on a CONFIRMED self-delete drops the agent
      // record (its tokens cascade) so the fleet list reflects reality.
      if (msg.type === 'action-result' && msg.auditId != null) {
        const ok = !!msg.ok;
        const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, 300)
          : (msg.version ? `version ${msg.version}` : null);
        if (auditRepo && typeof auditRepo.complete === 'function') {
          auditRepo.complete(msg.auditId, { state: ok ? 'completed' : 'failed', resultDetail: detail })
            .catch((err) => logger.error('Failed to complete audit row:', err));
        }
        // Surface an install-tool outcome in the unified audit trail (the
        // request was already audited when the operator/auto-trigger sent it).
        if (msg.action === 'install-tool' && auditEventsRepo && typeof auditEventsRepo.record === 'function') {
          const tool = typeof msg.tool === 'string' ? msg.tool : null;
          auditEventsRepo.record({
            actorType: 'agent', actorId: ws.agentId,
            action: 'agent.install-tool', targetType: 'tool', targetLabel: tool,
            detail: { ok, tool, reason: detail, package: msg.package || null },
          }).catch((err) => logger.error('Failed to record install-tool audit event:', err));
        }
        if (msg.action === 'delete' && ok && agentsRepo && typeof agentsRepo.remove === 'function') {
          agentsRepo.remove(ws.agentId)
            .then(() => {
              if (typeof notifyDashboard === 'function') {
                try { notifyDashboard({ type: 'agent-status', payload: { agentId: ws.agentId, status: 'deleted' } }); } catch { /* best-effort */ }
              }
            })
            .catch((err) => logger.error('Failed to remove self-deleted agent:', err));
        }
      }
      // agent -> server: a buffer-flush of transaction-test results. Validated,
      // authorised against the agent's assignments, batch-inserted, then run
      // through the threshold alert-hook. Fully best-effort — a bad frame or a
      // repo error must never break the hub.
      if (msg.type === 'transaction_result' && transactionsRepo && typeof transactionsRepo.insertResults === 'function') {
        handleTransactionResult(ws.agentId, msg).catch((err) => logger.error('transaction_result handling failed:', err));
      }
    });

    ws.on('close', () => {
      agentsRepo
        .setStatus(agent.agentId, 'offline')
        .catch((err) => logger.error('Failed to mark agent offline:', err));
      if (typeof notifyDashboard === 'function') {
        try { notifyDashboard({ type: 'agent-status', payload: { agentId: agent.agentId, status: 'offline' } }); } catch { /* best-effort */ }
      }
      recordAgentAudit('agent.offline', agent.agentId, ws._remoteIp);
    });

    ws.on('error', (err) => logger.error('Agent WS connection error:', err));
  });

  // Heartbeat: ping every client; drop any that didn't answer the last ping.
  const interval = startHeartbeat(wss, heartbeatMs);

  // server -> agent: send a command to every live connection of an agent.
  // Returns how many sockets received it.
  function sendCommand(agentId, command) {
    let sent = 0;
    for (const ws of wss.clients) {
      if (ws.agentId === agentId && ws.readyState === ws.OPEN) {
        safeSend(ws, { type: 'command', command });
        sent += 1;
      }
    }
    return sent;
  }

  // server -> agent request/response: sends a command carrying a correlation id
  // and resolves when the agent echoes it back (or on timeout / if the agent is
  // not connected). Resolves with { delivered, acked, reply, timedOut? } — never
  // rejects, so callers can branch on the shape.
  function sendCommandAndWait(agentId, command, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve) => {
      const id = `s${Date.now().toString(36)}-${(seq += 1)}`;
      const delivered = sendCommand(agentId, { ...command, id });
      if (delivered === 0) {
        resolve({ delivered: 0, acked: false, reply: null });
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ delivered, acked: false, reply: null, timedOut: true });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pending.set(id, { resolve, timer, delivered });
    });
  }

  // server -> agent: push an agent's currently-assigned (enabled) transaction
  // tests to each of its live sockets, so it (re)loads its run schedule. Returns
  // how many sockets received it. Safe no-op when no transactionsRepo is wired.
  async function pushTransactionConfig(agentId) {
    if (!transactionsRepo || typeof transactionsRepo.testsForAgent !== 'function') return 0;
    let tests = [];
    try {
      tests = await transactionsRepo.testsForAgent(agentId);
    } catch (err) {
      logger.error(`Failed to load transaction config for agent ${agentId}:`, err);
      return 0;
    }
    let sent = 0;
    const target = String(agentId);
    for (const ws of wss.clients) {
      if (String(ws.agentId) === target && ws.readyState === ws.OPEN) {
        safeSend(ws, { type: 'transaction_config', tests });
        sent += 1;
      }
    }
    return sent;
  }

  // agent -> server: validate a transaction_result batch, drop results for tests
  // the agent isn't assigned (logged as a warning), batch-insert the rest, then
  // evaluate alert thresholds.
  async function handleTransactionResult(agentId, msg) {
    const { value, errors } = validateResultIngest(msg);
    if (errors) {
      logger.warn(`transaction_result from agent ${agentId} rejected: ${JSON.stringify(errors)}`);
      return;
    }
    const assigned = await transactionsRepo.assignedTestIds(agentId);
    const accepted = [];
    for (const r of value.results) {
      if (!assigned.has(r.test_id)) {
        logger.warn(`agent ${agentId} reported a result for unassigned test ${r.test_id}; dropping`);
        continue;
      }
      accepted.push({ ...r, agent_id: agentId, ran_at: r.ran_at || new Date() });
    }
    if (!accepted.length) return;
    await transactionsRepo.insertResults(accepted);
    await maybeAlertTransaction(agentId, accepted);
  }

  // Threshold alert-hook: after insert, evaluate the latest result per test
  // against its thresholds and dispatch a finding. The dispatcher's own cooldown
  // (keyed by hostId|metric|kind|severity) provides the debounce.
  async function maybeAlertTransaction(agentId, accepted) {
    const alertOn = typeof alertingEnabled === 'function' ? alertingEnabled() : alertingEnabled;
    if (!alertDispatcher || typeof alertDispatcher.dispatch !== 'function' || !alertOn) return;
    const latestPerTest = new Map(); // test_id -> latest result in this batch
    for (const r of accepted) latestPerTest.set(r.test_id, r);
    for (const [testId, result] of latestPerTest) {
      try {
        const test = await transactionsRepo.findById(testId);
        if (!test || !test.thresholds) continue;
        const need = Math.max(1, Number(test.thresholds.consecutive_fails) || 1);
        const recentStatuses = await transactionsRepo.recentStatuses(testId, agentId, need);
        const finding = evaluateTransactionAlert({ test, agentId, result, recentStatuses });
        if (finding) await alertDispatcher.dispatch(finding, null);
      } catch (err) {
        logger.warn(`transaction alert evaluation failed for test ${testId}: ${err.message}`);
      }
    }
  }

  function close() {
    clearInterval(interval);
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  // Current number of connected agents (used for license reporting/enforcement).
  function connectionCount() {
    return wss.clients.size;
  }

  // Pushes a message to the connections of one host (e.g. an analysis 'finding'
  // event). Uses the SAME WebSocket server — not a new channel. Returns how many
  // sockets received it. (UI clients that connect for a host receive these; the
  // dashboard also reads findings over REST.)
  function broadcast(hostId, message) {
    let sent = 0;
    const target = String(hostId);
    for (const ws of wss.clients) {
      if (String(ws.agentId) === target && ws.readyState === ws.OPEN) {
        safeSend(ws, message);
        sent += 1;
      }
    }
    return sent;
  }

  // Latest hsflowd exporter status an agent reported, or null. Read by the
  // agents list so the dashboard can show the result of an enable/disable.
  function getSflowStatus(agentId) {
    return sflowStatus.get(agentId) || null;
  }

  return { wss, sendCommand, sendCommandAndWait, broadcast, close, connectionCount, getSflowStatus, pushTransactionConfig };
}

module.exports = { attachAgentWebSocket };
