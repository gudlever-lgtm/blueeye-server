'use strict';

// Runs a test package: resolves its target agents from the selector and pushes
// each item to them over the live WebSocket (reusing the agent's existing
// run-probe / run-test command handlers). Agents execute and report results
// through the normal endpoints, so nothing new is needed agent-side.
//
// Only agents that are currently CONNECTED receive a command — sendCommand
// returns 0 for an offline agent, which is counted as "not reached".

// Resolves the target agent ids for a package, given the full agent list.
//
// `overrideIds` is the OTHER direction through the same machinery: "run this
// test on these agents, now" — a one-off choice made at the Run button, which
// never touches the package's saved targets. Ids that name no agent are
// dropped rather than counted, so `targeted` stays the number of agents a
// command was actually addressed to.
function resolveTargetIds(pkg, agents, overrideIds = null) {
  if (Array.isArray(overrideIds)) {
    const want = new Set(overrideIds.map(Number));
    return agents.filter((a) => want.has(Number(a.id))).map((a) => a.id);
  }
  const t = (pkg && pkg.targets) || { mode: 'all' };
  if (t.mode === 'agents') {
    const want = new Set((t.agentIds || []).map(Number));
    return agents.filter((a) => want.has(Number(a.id))).map((a) => a.id);
  }
  if (t.mode === 'location') {
    const want = new Set((t.locationIds || []).map(Number));
    return agents.filter((a) => a.location_id != null && want.has(Number(a.location_id))).map((a) => a.id);
  }
  return agents.map((a) => a.id); // 'all'
}

// Turns a package item into a server -> agent command.
function itemToCommand(item) {
  if (item && item.type === 'probe') return { name: 'run-probe', probe: item.probe };
  if (item && item.type === 'speedtest') {
    const cmd = { name: 'speedtest' };
    if (item.bytes) cmd.bytes = item.bytes;
    return cmd;
  }
  const cmd = { name: 'run-test' };
  if (item && item.intervalMs) cmd.intervalMs = item.intervalMs;
  return cmd;
}

function createTestPackageRunner({ agentsRepo, agentCommander, repo, logger = console }) {
  // Pushes every item to every resolved, connected target. Records the run on
  // the package (best-effort) and returns a summary.
  async function run(pkg, opts = {}) {
    const adhocIds = Array.isArray(opts.agentIds) ? opts.agentIds : null;
    const agents = await agentsRepo.findAll();
    const ids = resolveTargetIds(pkg, agents, adhocIds);
    const commands = (pkg.items || []).map(itemToCommand);

    let delivered = 0;
    const reached = new Set();
    for (const id of ids) {
      for (const cmd of commands) {
        const n = agentCommander ? agentCommander.sendCommand(id, cmd) : 0;
        if (n > 0) { delivered += n; reached.add(id); }
      }
    }

    const summary = {
      at: new Date().toISOString(),
      targeted: ids.length,
      reached: reached.size,
      delivered,
      items: commands.length,
    };
    // An ad-hoc run went to agents the package does not target, so the row it
    // leaves behind says which kind of run it was. Without it "last run: 1/1
    // reached" on a package aimed at forty agents reads as a broken schedule.
    if (adhocIds) summary.adhoc = true;

    if (repo && typeof repo.setLastRun === 'function') {
      try { await repo.setLastRun(pkg.id, summary); }
      catch (err) { logger.warn(`test-package: could not record last run for ${pkg.id} (${err.message})`); }
    }
    logger.info(`test-package "${pkg.name}" run: ${reached.size}/${ids.length} agents reached, ${delivered} command(s) delivered.`);
    return summary;
  }

  return { run, resolveTargetIds };
}

module.exports = { createTestPackageRunner, resolveTargetIds, itemToCommand };
