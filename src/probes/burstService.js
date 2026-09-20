'use strict';

const { analyseBurst } = require('./burstAnalysis');

// Dispatches a burst and records what comes back.
//
// A burst is measured by the AGENT, so this is a two-part story: a row written
// when the command goes out, and the samples arriving over the WebSocket a
// minute or two later. Both halves live here so the route stays a route.
//
// THE RUN ID IS THE COMMAND ID. The row is created first and its id is what
// travels to the agent, so a result can always be matched back to the run that
// asked for it — no correlation table, and no window in which samples arrive
// for a run that does not exist yet.
// A burst can last at most 120 seconds, so anything still `running` after this
// is a run whose agent went away between the command and the result. Left
// alone it reads as live forever.
const STALE_AFTER_MS = 5 * 60 * 1000;

function createBurstService({
  burstRunsRepo,
  agentCommander,
  logger = null,
  now = () => new Date(),
}) {
  // Sends a burst to an agent. Returns { run } on success, or a coded refusal
  // the route turns into a status.
  async function start({ agentId, target, seconds, hz, probe, port, size, df, createdBy = null }) {
    if (!agentCommander || typeof agentCommander.sendCommand !== 'function') {
      return { error: 'no_channel' };
    }
    // Reconcile the abandoned ones first. There is no sweeper for this and
    // there does not need to be: the only person who cares is the one about to
    // look at the list, and they are here.
    if (typeof burstRunsRepo.expireStale === 'function') {
      try {
        await burstRunsRepo.expireStale(new Date(now().getTime() - STALE_AFTER_MS));
      } catch (err) {
        // Housekeeping must never cost the measurement somebody is waiting for.
        if (logger) logger.warn(`burst: could not expire stale runs: ${err && err.message}`);
      }
    }

    const run = await burstRunsRepo.start({
      agentId,
      target,
      probe: probe || 'ping',
      // What was ASKED for, kept beside what will run: the agent clamps beyond
      // its caps, and a run that looks short should be explainable rather than
      // suspicious.
      requestedSeconds: seconds,
      seconds,
      hz: hz || 1,
      createdBy,
      at: now(),
    });

    const delivered = agentCommander.sendCommand(agentId, {
      name: 'burst',
      id: run.id,
      target,
      seconds,
      hz,
      probe: probe || 'ping',
      port: port || undefined,
      size: size || undefined,
      df: df || undefined,
    });

    if (!delivered) {
      // The row already exists, so the refusal is recorded rather than leaving
      // a `running` row nobody will ever complete.
      await burstRunsRepo.complete(run.id, {
        samples: null, analysis: null, status: 'failed',
        error: 'the agent was not connected', endedAt: now(),
      });
      return { error: 'not_connected', runId: run.id };
    }
    return { run };
  }

  // Records a finished burst. Called from the WebSocket hub when the agent's
  // command-result arrives.
  //
  // The agent id is checked against the row: a result may only complete a run
  // that was dispatched to THAT agent, so one agent cannot write another's
  // measurement — the same ownership rule the SNMP ingest applies.
  async function recordResult(agentId, runId, result) {
    const id = Number(runId);
    if (!Number.isInteger(id) || id < 1) return null;

    const run = await burstRunsRepo.findById(id);
    if (!run) {
      if (logger) logger.warn(`burst: result for unknown run ${id} from agent ${agentId}`);
      return null;
    }
    if (Number(run.agentId) !== Number(agentId)) {
      if (logger) logger.warn(`burst: agent ${agentId} tried to complete run ${id}, which belongs to agent ${run.agentId}`);
      return null;
    }
    if (run.status !== 'running') {
      // A duplicate result — a reconnect replaying a frame, say. The first
      // answer stands: re-analysing would overwrite a stored verdict with an
      // identical one at best, and a truncated one at worst.
      return run;
    }

    if (!result || result.ok !== true) {
      return burstRunsRepo.complete(id, {
        samples: null, analysis: null, status: 'failed',
        error: (result && result.error) || 'the burst did not run', endedAt: now(),
      });
    }

    const samples = Array.isArray(result.samples) ? result.samples : [];
    const hz = (result.plan && Number(result.plan.hz)) || run.hz || 1;
    // Analysed ONCE, here, and stored — so the row reads the same in a report
    // six weeks later as it did on the screen.
    const analysis = analyseBurst(samples, { hz });

    return burstRunsRepo.complete(id, {
      samples,
      analysis,
      status: result.cancelled ? 'cancelled' : 'complete',
      endedAt: now(),
    });
  }

  // Asks an agent to stop a burst early. The technician watching the chart saw
  // what they needed; finishing the remaining ninety seconds serves nobody.
  function stop(agentId) {
    if (!agentCommander || typeof agentCommander.sendCommand !== 'function') return false;
    return !!agentCommander.sendCommand(agentId, { name: 'stop-burst' });
  }

  return { start, recordResult, stop };
}

module.exports = { createBurstService, STALE_AFTER_MS };
