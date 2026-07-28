'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const silentLogger = { info() {}, warn() {}, error() {} };

// Runs the host's update/deploy script when an admin asks for it from
// Settings → Updates ("update ready to deploy" → run it).
//
// Security model — the important part:
//   * The command comes ONLY from the environment (SERVER_UPDATE_COMMAND, set by
//     whoever installed this server). Nothing from an HTTP request ever reaches
//     the command line, so this endpoint can start exactly one pre-approved
//     script and nothing else. There is no shell: the script is exec'd directly.
//   * It is disabled unless that variable is set. Out of the box the dashboard
//     only SHOWS the command to run by hand.
//   * Triggering it is admin-only and audit-logged by the route.
//
// Practical detail: the update script typically restarts this very server (the
// stack's deploy.sh rebuilds and recreates the container), so the child is
// spawned DETACHED with its output redirected to a log file, and the run state
// is persisted to disk. That way the outcome survives the restart that kills the
// process observing it.
function createServerUpdateService({
  command = '',
  args = [],
  logPath,
  statePath,
  cwd = process.cwd(),
  // A run older than this with no recorded exit is reported as 'unknown' rather
  // than "still running" forever (e.g. the server was restarted mid-update).
  staleAfterMinutes = 60,
  spawnImpl = spawn,
  logger = silentLogger,
  now = () => Date.now(),
} = {}) {
  const staleAfterMs = Math.max(1, staleAfterMinutes) * 60 * 1000;
  let child = null;

  function isConfigured() {
    return typeof command === 'string' && command.trim() !== '';
  }

  function readState() {
    try {
      if (!statePath || !fs.existsSync(statePath)) return null;
      const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  function writeState(state) {
    if (!statePath) return;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      // Losing the state file only costs us the status display — never the run.
      logger.warn(`Server update: could not write run state (${err.message}).`);
    }
  }

  // Is the recorded run still going? A detached child survives us, so liveness is
  // checked by signal-0 rather than by holding a handle.
  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM = it exists but belongs to another user — still alive.
      return err && err.code === 'EPERM';
    }
  }

  // The recorded run, with "is it still running?" resolved against reality.
  function currentRun() {
    const state = readState();
    if (!state || !state.startedAt) return null;
    if (state.finishedAt) return { ...state, running: false };
    const startedMs = Date.parse(state.startedAt);
    const alive = pidAlive(state.pid);
    if (alive) return { ...state, running: true };
    // No exit recorded and the process is gone: either the update restarted this
    // server before the exit could be written, or the child died unobserved.
    const stale = Number.isFinite(startedMs) && now() - startedMs > staleAfterMs;
    return {
      ...state,
      running: false,
      exitCode: state.exitCode ?? null,
      outcome: stale ? 'unknown' : 'ended',
      note: 'The update process is no longer running and recorded no exit code — '
        + 'this is expected when the update restarts the server. Check the log below.',
    };
  }

  function isRunning() {
    const run = currentRun();
    return Boolean(run && run.running);
  }

  // Last `lines` lines of the update log. Reads at most the tail of the file so a
  // long-running deploy log never gets pulled into memory whole.
  function tail(lines = 200) {
    if (!logPath) return '';
    try {
      const stat = fs.statSync(logPath);
      const maxBytes = 256 * 1024;
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(logPath, 'r');
      try {
        const length = stat.size - start;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, start);
        return buf.toString('utf8').split('\n').slice(-lines).join('\n');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  function status() {
    const run = currentRun();
    return {
      configured: isConfigured(),
      command: isConfigured() ? [command, ...args].join(' ') : null,
      logPath: logPath || null,
      running: Boolean(run && run.running),
      lastRun: run
        ? {
          startedAt: run.startedAt,
          finishedAt: run.finishedAt || null,
          exitCode: run.exitCode ?? null,
          requestedBy: run.requestedBy || null,
          targetVersion: run.targetVersion || null,
          outcome: run.running ? 'running' : run.outcome || (run.exitCode === 0 ? 'success' : 'failed'),
          note: run.note || null,
        }
        : null,
    };
  }

  // Starts the configured command. Returns { started: true, ... } or
  // { started: false, reason } — the caller maps the reason to an HTTP status.
  function start({ requestedBy = null, targetVersion = null } = {}) {
    if (!isConfigured()) return { started: false, reason: 'not_configured' };
    if (isRunning()) return { started: false, reason: 'already_running' };

    let out;
    try {
      if (logPath) {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        // Truncate per run: the previous run's log is superseded, and an
        // ever-growing deploy log on a customer's disk is nobody's friend.
        out = fs.openSync(logPath, 'w');
      }
    } catch (err) {
      return { started: false, reason: 'log_unwritable', detail: err.message };
    }

    const startedAt = new Date(now()).toISOString();
    try {
      child = spawnImpl(command, args, {
        cwd,
        detached: true,
        stdio: ['ignore', out ?? 'ignore', out ?? 'ignore'],
        // The target version is informational for the script (it can log it);
        // it is a signed value from the license proof, never request input.
        env: { ...process.env, BLUEEYE_UPDATE_TARGET_VERSION: targetVersion || '' },
      });
    } catch (err) {
      if (out !== undefined) fs.closeSync(out);
      return { started: false, reason: 'spawn_failed', detail: err.message };
    }
    // The parent's copy of the log fd is no longer needed once the child owns it.
    if (out !== undefined) {
      try { fs.closeSync(out); } catch { /* the child holds its own copy */ }
    }

    const run = { startedAt, finishedAt: null, exitCode: null, pid: child.pid ?? null, requestedBy, targetVersion, command };
    writeState(run);

    // Record the exit if we are still alive to see it — an update that restarts
    // this server never gets here, which is what currentRun() reconciles.
    child.on('exit', (code, signal) => {
      writeState({ ...run, finishedAt: new Date(now()).toISOString(), exitCode: code ?? null, signal: signal || null });
      logger.info(`Server update: script exited with code ${code} (signal ${signal || 'none'}).`);
      child = null;
    });
    child.on('error', (err) => {
      writeState({ ...run, finishedAt: new Date(now()).toISOString(), exitCode: null, error: err.message });
      logger.error(`Server update: script failed to run (${err.message}).`);
      child = null;
    });
    if (typeof child.unref === 'function') child.unref();

    logger.info(`Server update: started "${command}" (pid ${child.pid}) by ${requestedBy || 'unknown'}.`);
    return { started: true, startedAt, pid: child.pid ?? null };
  }

  return { isConfigured, isRunning, start, status, tail };
}

module.exports = { createServerUpdateService };
