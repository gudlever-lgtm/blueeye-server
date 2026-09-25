'use strict';

const crypto = require('crypto');
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateResults } = require('../validation/resultsValidation');
const { validateCapabilities } = require('../validation/agentValidation');
const { capabilitiesForStorage } = require('../lib/agentCapabilities');
const { validateProbeResults } = require('../validation/probeValidation');
const { normalizeReportedArp } = require('../identity/arpTable');
const { validateDeviceEventBatch } = require('../validation/deviceEventValidation');
const { validateSnmpTopologyBatch, validateSnmpCounterBatch } = require('../validation/snmpDeviceValidation');
const { withoutSflowDetail } = require('../devices/sflowCounterIngest');

// Endpoints agents call themselves, authenticated with their opaque token
// (NOT a user JWT). `agentAuth` is the agent-token middleware. The agent id is
// taken from the token (req.agent.agentId), so an agent can only ever read/write
// its OWN config/capabilities/results — never another agent's.
//
// Paths use the `/me/...` prefix so they don't collide with the user-JWT agents
// router's `/:id` routes mounted under the same /agents path.
function createAgentReportsRouter({ agentAuth, resultsRepo, resultsTsdbRepo = null, probeResultsTsdbRepo = null, agentsRepo, auditEventsRepo = null, analysisPipeline = null, flowPipeline = null, probeResultsRepo = null, probePipeline = null, probeOutageService = null, installToolService = null, lldpNeighborsRepo = null, topologyChangeService = null, hostConnectionsRepo = null, arpEntriesRepo = null, deviceEventIngest = null, snmpDevicesRepo = null, snmpTopologyIngest = null, snmpCounterIngest = null, sflowCounterIngest = null, interfaceStateService = null, discoveredDevicesRepo = null, snmpProfilesRepo = null, auditLogger = null, notifyDashboard = null,
  // The agent version this server offers, and the auto-update policy that says
  // whether an agent may act on it. Both optional: without them /me/config omits
  // the `updates` key and behaves exactly as it did.
  updateService = null, settingsService = null,
  logger = null }) {
  const router = express.Router();

  // Each probe-results POST re-reads the agent's recent rows for probe-finding
  // and event derivation. Agents normally post about once a minute, so this
  // only collapses rapid bursts (e.g. catch-up replays after a reconnect) where
  // re-scanning per batch is pure waste — the next non-debounced run sees the
  // same rows. Kept short so normal analysis/alert latency is unchanged.
  const PIPELINE_DEBOUNCE_MS = 10000;
  const lastAnalyzed = new Map(); // agentId -> ms
  function shouldAnalyze(agentId) {
    const now = Date.now();
    if (now - (lastAnalyzed.get(agentId) || 0) < PIPELINE_DEBOUNCE_MS) return false;
    lastAnalyzed.set(agentId, now);
    return true;
  }

  // Records what an agent actually performed in the unified audit trail. Recurring
  // activity (continuous traffic reporting, scheduled probes) collapses onto a
  // single row via a dedup key — only the first run is a distinct audit entry,
  // every repeat just bumps it ("Repeats …"). Best-effort: never breaks ingest.
  async function auditAgentActivity(agentId, fn) {
    if (!auditEventsRepo) return;
    try { await fn(agentId); } catch { /* audit is non-fatal */ }
  }

  // A run-test triggered on demand (commanded) carries the command name; the
  // agent's own continuous reporting uses 'auto-report'. Only the latter repeats.
  function isAutoReport(r) {
    return !r || !r.name || r.name === 'auto-report';
  }

  // Builds a bounded dedup key for probe activity. A probe target may be up to
  // 255 chars (validateProbeResults), so the raw `type:target` tail can overflow
  // the audit_events.dedup_key VARCHAR(255) column once prefixed — hash the tail
  // to a fixed length so the key stays well within bounds (and never truncates
  // two distinct long targets onto the same row).
  function probeDedupKey(agentId, kind, type, target) {
    const hash = crypto.createHash('sha1').update(`${type}\0${target}`).digest('hex');
    return `agent:${agentId}:${kind}:${hash}`;
  }

  // POST /agents/probe-results { results: [...] } — stores active-probe results
  // (ping/tcp/dns/traceroute/http) for the agent identified by the token.
  router.post(
    '/probe-results',
    agentAuth,
    asyncHandler(async (req, res) => {
      if (!probeResultsRepo) return res.status(404).json({ error: 'Probes not enabled' });
      const { value, errors } = validateProbeResults(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const inserted = await probeResultsRepo.createMany(req.agent.agentId, value.results);

      // Storage split: mirror into the TSDB best-effort, exactly like the
      // results mirror below — MySQL is the source of truth during rollout.
      if (probeResultsTsdbRepo) {
        try {
          await probeResultsTsdbRepo.createMany(req.agent.agentId, value.results);
        } catch (err) {
          if (logger) logger.warn(`tsdb: probe_results mirror write failed (${err.message}); MySQL is source of truth`);
        }
      }

      // A finished trace tells the dashboard straight away, so a path the
      // operator is waiting on draws the moment it lands instead of on the
      // next poll — or never, when the trace outlived the poll window.
      if (typeof notifyDashboard === 'function') {
        for (const r of value.results) {
          if (r.type !== 'traceroute' && r.type !== 'tcptraceroute') continue;
          try {
            notifyDashboard({ type: 'probe-result', payload: { agentId: req.agent.agentId, type: r.type, target: r.target, ok: !!r.ok } });
          } catch { /* live view is a courtesy */ }
        }
      }

      // Audit what the agent probed. Each (type → target) collapses to one row;
      // repeats (scheduled probes) bump it rather than spamming the trail. A
      // probe the agent could not EXECUTE at all (e.g. "traceroute not
      // installed") carries an explicit execError — audited distinctly as
      // 'agent.probe-failed' with the reason, so the trail shows the failure
      // (and why) instead of looking like a normal probe.
      await auditAgentActivity(req.agent.agentId, async (agentId) => {
        const seen = new Set();
        for (const r of value.results) {
          const type = r && r.type ? String(r.type) : 'probe';
          const target = r && r.target ? String(r.target) : '';
          const key = `${type}:${target}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (r && r.execError) {
            await auditEventsRepo.recordRecurring({
              actorType: 'agent', actorId: agentId,
              action: 'agent.probe-failed', targetType: type, targetLabel: target || null,
              detail: { reason: r.execError },
              dedupKey: probeDedupKey(agentId, 'probe-failed', type, target),
            });
          } else {
            await auditEventsRepo.recordRecurring({
              actorType: 'agent', actorId: agentId,
              action: 'agent.probe', targetType: type, targetLabel: target || null,
              dedupKey: probeDedupKey(agentId, 'probe', type, target),
            });
          }
        }
      });

      // If a probe failed because a tool is missing (e.g. traceroute) and the
      // operator opted into auto-install, push the install to this agent.
      // Best-effort + opt-in + throttled; must never break ingestion.
      if (installToolService && typeof installToolService.maybeAutoInstall === 'function') {
        try {
          await installToolService.maybeAutoInstall(req.agent.agentId, value.results);
        } catch {
          /* auto-install is best-effort; ingestion already succeeded */
        }
      }

      // After persistence, derive probe-based findings (reachability/loss/latency/
      // jitter/cert) and alert, then derive events. Both re-scan recent rows,
      // so a rapid burst is collapsed (see shouldAnalyze). Resilient: must never
      // break ingestion. The ORDER matters: the outage service holds back the
      // alert of an outage whose target the pipeline has just raised (one
      // fault, one alert — see probeOutageService), so the pipeline runs first.
      if ((probePipeline || probeOutageService) && shouldAnalyze(req.agent.agentId)) {
        if (probePipeline) {
          try {
            await probePipeline.processAgent(req.agent.agentId);
          } catch {
            /* probe analysis is best-effort; ingestion already succeeded */
          }
        }
        if (probeOutageService) {
          try {
            await probeOutageService.processAgent(req.agent.agentId);
          } catch {
            /* event derivation is best-effort; ingestion already succeeded */
          }
        }
      }

      res.status(201).json({ inserted });
    })
  );

  // POST /agents/results { results: [...] } — stores results for the agent
  // identified by the token.
  router.post(
    '/results',
    agentAuth,
    asyncHandler(async (req, res) => {
      const { value, errors } = validateResults(req.body);
      if (errors) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      // What is stored omits the raw sFlow counters/exporter list: they land in
      // their own tables (the sFlow ingest below reads them from value.results,
      // which keeps them), and were ~24 KB per row here. Both stores get the
      // same stripped payload.
      const stored = withoutSflowDetail(value.results);
      const inserted = await resultsRepo.createMany(req.agent.agentId, stored);

      // Storage split (docs/storage-split-audit.md): when TimescaleDB is
      // enabled, mirror results into the TSDB best-effort. MySQL is the source
      // of truth during rollout, so a TSDB failure must never break ingest.
      if (resultsTsdbRepo) {
        try {
          await resultsTsdbRepo.createMany(req.agent.agentId, stored);
        } catch (err) {
          if (logger) logger.warn(`tsdb: results mirror write failed (${err.message}); MySQL is source of truth`);
        }
      }

      // Audit what the agent measured. Continuous reporting ('auto-report')
      // collapses onto a single recurring row ("Repeats …"); an on-demand
      // (commanded) run-test is recorded as a distinct event.
      await auditAgentActivity(req.agent.agentId, async (agentId) => {
        if (value.results.some((r) => isAutoReport(r))) {
          await auditEventsRepo.recordRecurring({
            actorType: 'agent', actorId: agentId,
            action: 'agent.traffic-report', targetType: 'traffic',
            dedupKey: `agent:${agentId}:traffic-report`,
          });
        }
        if (value.results.some((r) => !isAutoReport(r))) {
          await auditEventsRepo.record({
            actorType: 'agent', actorId: agentId,
            action: 'agent.run-test', targetType: 'traffic',
          });
        }
      });

      // After persistence, run analysis (behind its own feature flag). It is
      // resilient and must never break ingestion, so failures are swallowed.
      // Interface state transitions (Fase 2b) — recorded HERE, where every
      // observation lands, rather than reconstructed by polling current state.
      // Best-effort: the results report is the agent's lifeline.
      if (interfaceStateService) {
        try {
          await interfaceStateService.processResults(req.agent.agentId, value.results);
        } catch (err) {
          if (logger) logger.warn(`interface-state ingest failed for agent ${req.agent.agentId}: ${err && err.message}`);
        }
      }

      if (analysisPipeline) {
        try {
          await analysisPipeline.processResults(req.agent.agentId, value.results);
        } catch {
          /* analysis is best-effort; ingestion already succeeded */
        }
      }

      // Likewise, geo-enrich + store flow records (behind the geo flag).
      if (flowPipeline) {
        try {
          await flowPipeline.processResults(req.agent.agentId, value.results);
        } catch {
          /* flow enrichment is best-effort; ingestion already succeeded */
        }
      }

      // sFlow COUNTER samples (the exporter's own interface + Ethernet error
      // counters) into the device counter series, for exporters that are
      // registered devices (src/devices/sflowCounterIngest.js). Optional on
      // the wire — an older agent sends none — and best-effort like the rest.
      if (sflowCounterIngest) {
        try {
          await sflowCounterIngest.processResults(req.agent.agentId, value.results);
        } catch (err) {
          if (logger) logger.warn(`sflow-counters ingest failed for agent ${req.agent.agentId}: ${err && err.message}`);
        }
      }

      res.status(201).json({ inserted });
    })
  );

  // The agent's OWN traffic source, when that source is an SNMP device it polls
  // itself. `monitor_config.snmp` may name a credential (`profileId`) instead of
  // carrying a community string, and this is the one hop that turns the name
  // into the secret — exactly as the device targets below already do.
  //
  // The grant is checked, not assumed: `resolveForAgent` refuses a profile this
  // agent is not granted, and a refused one sends no community at all rather
  // than falling back to something nobody chose. The stored config is never
  // mutated; the resolved copy exists only in this response.
  async function withResolvedSnmpCredential(agent) {
    const mc = agent.monitor_config || { source: 'proc' };
    const profileId = mc.source === 'snmp' && mc.snmp ? mc.snmp.profileId : null;
    if (!profileId || !snmpProfilesRepo) return mc;
    const out = { ...mc, snmp: { ...mc.snmp } };
    try {
      const { profileId: allowed, blocked } = await snmpProfilesRepo.resolveForAgent({
        profileId, agentId: agent.id,
      });
      const cred = allowed ? await snmpProfilesRepo.resolveWithSecret(allowed) : null;
      if (!cred) {
        // WHY there is no credential, so the agent reports "no SNMP credential"
        // instead of polling with a default nobody configured.
        out.snmp.noCredential = true;
        if (blocked) out.snmp.credentialBlocked = true;
        if (logger) {
          logger.warn(`agent ${agent.id}: SNMP credential ${profileId} is ${blocked ? 'not granted to this agent' : 'unavailable'}`);
        }
        return out;
      }
      out.snmp.version = cred.version || out.snmp.version;
      if (cred.community) out.snmp.community = cred.community;
      if (cred.v3User) {
        out.snmp.v3 = {
          user: cred.v3User,
          authProto: cred.v3AuthProto,
          authKey: cred.v3AuthKey,
          privProto: cred.v3PrivProto,
          privKey: cred.v3PrivKey,
          context: cred.v3Context,
          level: cred.securityLevel,
        };
      }
    } catch (err) {
      // The config's first job is telling an agent how to measure itself; a
      // credential lookup that fails must not take that away.
      out.snmp.noCredential = true;
      if (logger) logger.warn(`agent ${agent.id}: SNMP credential lookup failed (${err && err.message})`);
    }
    return out;
  }

  // GET /agents/me/config — the agent fetches its server-assigned monitoring
  // config. Defaults to the local /proc source when nothing is set.
  router.get(
    '/me/config',
    agentAuth,
    asyncHandler(async (req, res) => {
      const agent = await agentsRepo.findById(req.agent.agentId);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      const body = {
        agentId: agent.id,
        monitorConfig: await withResolvedSnmpCredential(agent),
      };
      // The switches THIS agent polls, with their community strings decrypted
      // for the one hop that needs them. Best-effort: a device inventory that
      // cannot be read must not stop an agent from learning how to measure
      // itself, which is the config's original and more important job.
      //
      // The key is omitted entirely when there is nothing to poll, so an agent
      // too old to understand it sees exactly what it saw before.
      if (snmpDevicesRepo) {
        try {
          const devices = await snmpDevicesRepo.listForAgentWithSecret(agent.id);
          if (devices.length) {
            body.snmpTargets = devices.map((d) => ({
              deviceId: d.id,
              host: d.host,
              port: d.port,
              // The credential the server RESOLVED (migrations 112 and 113):
              // the device's own, else the community it names, else its site's
              // communities in the site's order, else the global default — and
              // every named one filtered by what THIS AGENT is granted. Its
              // version wins over the device row's, because a v3 community
              // against a row still saying 2c would otherwise authenticate
              // with a community string that does not exist.
              //
              // The agent gets ONE credential per device and never learns that
              // named communities exist — the secret surface on the agent
              // stays exactly the size it already was.
              version: (d.credential && d.credential.version) || d.version,
              community: d.community,
              v3: d.credential && d.credential.v3User ? {
                user: d.credential.v3User,
                authProto: d.credential.v3AuthProto,
                authKey: d.credential.v3AuthKey,
                privProto: d.credential.v3PrivProto,
                privKey: d.credential.v3PrivKey,
                context: d.credential.v3Context,
                level: d.credential.securityLevel,
              } : undefined,
              collect: d.collect,
              intervalSec: d.intervalSec,
              // The counter cadence, when the device asked for counters at all.
              // Its own setting because a counter series' interval IS its
              // resolution, while a forwarding-table sweep every five minutes
              // is generous.
              counterIntervalSec: d.counterIntervalSec,
              // WHY there is no credential, when there is none. The target is
              // still sent: the agent refuses to poll it and reports the
              // reason, which is how "sw-lager-1: no SNMP credential" reaches
              // the dashboard instead of a switch silently never appearing.
              // An agent too old to read this key falls back to refusing on the
              // missing community alone, which is the same outcome.
              noCredential: d.credential ? undefined : true,
              credentialBlocked: d.credentialBlockedByGrant ? true : undefined,
            }));
          }
        } catch (err) {
          if (logger) logger.warn(`snmp targets unavailable for agent ${agent.id}: ${err && err.message}`);
        }
      }
      // What version this server offers, and whether this agent may go and get
      // it. Until now an update was pure push: the agent never knew it was
      // behind, so an agent that is online for ten minutes a day could only be
      // updated by someone timing a click to the connection. With this it can
      // ask, on its own, on the config read it already makes.
      //
      // The flag is a PERMISSION, not an instruction. The agent asks; the server
      // re-checks the policy before it sends anything, because a flag that has
      // travelled to a host and back is not a decision this server made.
      //
      // Omitted entirely when nothing is offered, so an agent too old to read it
      // sees exactly the body it saw before.
      if (updateService) {
        try {
          const offered = updateService.offeredVersion();
          if (offered) {
            const policy = settingsService && typeof settingsService.getAgents === 'function'
              ? await settingsService.getAgents()
              : { autoUpdate: false, autoUpdateWindow: '' };
            body.updates = {
              agentVersion: offered,
              auto: !!policy.autoUpdate,
              // Evaluated by the AGENT, in its own local time — a fleet across
              // three time zones cannot have '02:00' decided here.
              window: policy.autoUpdateWindow || '',
            };
          }
        } catch (err) {
          if (logger) logger.warn(`update offer unavailable for agent ${agent.id}: ${err && err.message}`);
        }
      }
      res.json(body);
    })
  );

  // POST /agents/me/capabilities { capabilities } — the agent reports what it
  // can do (e.g. { sources: ['proc','snmp'] }).
  router.post(
    '/me/capabilities',
    agentAuth,
    asyncHandler(async (req, res) => {
      const errors = {};
      const capabilities = validateCapabilities(req.body && req.body.capabilities, errors);
      if (errors.capabilities) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const updated = await agentsRepo.setCapabilities(req.agent.agentId, capabilitiesForStorage(capabilities));
      if (!updated) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      // Fase 4: persist any LLDP neighbors the agent reported alongside its
      // capabilities — this is the "collection cycle" upsert (reusing the existing
      // report path, no new SNMP polling). Best-effort: never breaks the report.
      if (lldpNeighborsRepo && Array.isArray(capabilities.lldp)) {
        try {
          // Detect topology changes FIRST (diff the reported set against the
          // agent's previous snapshot), then persist the new state. Order matters:
          // the diff must see the old rows before upsert overwrites them.
          if (topologyChangeService && typeof topologyChangeService.processReport === 'function') {
            await topologyChangeService.processReport(req.agent.agentId, capabilities.lldp);
          }
          if (capabilities.lldp.length) {
            await lldpNeighborsRepo.upsertMany(req.agent.agentId, capabilities.lldp, { localChassisId: capabilities.lldpChassisId || null });
          }
        } catch (err) {
          if (logger) logger.warn(`lldp ingest failed for agent ${req.agent.agentId}: ${err && err.message}`);
        }
      }
      // Connection-table edges (metadata only) → host_connections, a second
      // source for the service dependency graph so a proc/snmp-only host still
      // contributes. Kept out of the agents JSON blob (capabilitiesForStorage).
      // Best-effort: never breaks the capabilities report.
      const reportedConns = capabilities.connections;
      if (hostConnectionsRepo && Array.isArray(reportedConns)) {
        try {
          await hostConnectionsRepo.replaceForAgent(req.agent.agentId, reportedConns);
        } catch (err) {
          if (logger) logger.warn(`connection-table ingest failed for agent ${req.agent.agentId}: ${err && err.message}`);
        }
      }
      // ARP/neighbour entries → arp_entries, the IP↔MAC identity source behind
      // the universal search field. Kept out of the agents JSON blob like the
      // connection table, and normalised (dropping incomplete/broadcast/multicast rows)
      // before storage. Best-effort: never breaks the capabilities report.
      const reportedArp = capabilities.arp;
      if (arpEntriesRepo && Array.isArray(reportedArp)) {
        try {
          const { entries } = normalizeReportedArp(reportedArp);
          if (entries.length) {
            await arpEntriesRepo.upsertMany(req.agent.agentId, entries, { source: 'capabilities' });
          }
        } catch (err) {
          if (logger) logger.warn(`arp ingest failed for agent ${req.agent.agentId}: ${err && err.message}`);
        }
      }
      res.json({ agentId: updated.id, capabilities: updated.capabilities });
    })
  );

  // POST /agents/me/device-events { events } — syslog (and, from stage 03, SNMP
  // traps) this agent RECEIVED from the network devices pointing at it.
  //
  // 202, not 201: the rows are accepted for ingest, and what comes back is a
  // COUNT OF WHAT HAPPENED — inserted, folded onto an existing row, skipped as
  // malformed, and how many senders could not be resolved to a device. An agent
  // operator staring at "202 accepted" with nothing new on screen needs to be
  // able to tell a repeat batch from a broken pipeline.
  //
  // The agent is authenticated but its INPUT IS NOT TRUSTED: every field
  // originated on a network device that anyone on the customer's LAN can send
  // UDP to. Validation is a real boundary here — see
  // src/validation/deviceEventValidation.js.
  router.post(
    '/me/device-events',
    agentAuth,
    asyncHandler(async (req, res) => {
      const errors = {};
      const batch = validateDeviceEventBatch(req.body && req.body.events, errors);
      if (!batch) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      // Nothing configured to receive them: say so plainly rather than
      // answering 202 to a write that went nowhere.
      if (!deviceEventIngest) {
        return res.status(503).json({ error: 'Device-event ingest is not configured' });
      }
      if (!batch.events.length) {
        return res.status(202).json({ inserted: 0, folded: 0, skipped: batch.skipped, resolved: 0, unresolved: 0 });
      }
      const result = await deviceEventIngest.ingest(req.agent.agentId, batch.events);
      if (logger && batch.skipped) {
        logger.warn(`device-events: skipped ${batch.skipped} malformed row(s) from agent ${req.agent.agentId}`);
      }
      return res.status(202).json({ ...result, skipped: batch.skipped });
    })
  );

  // POST /agents/me/snmp-topology { devices, errors } — one poll cycle of the
  // switches assigned to this agent: forwarding tables, LLDP neighbours, VLAN
  // names, plus a per-device error for the ones that did not answer.
  //
  // The ownership check lives in the ingest, not here: an agent may only write
  // the devices the server assigned to IT, and a mismatch is counted and
  // dropped rather than failing the batch (an assignment that changed
  // mid-cycle is a normal race). The response reports the count either way.
  router.post(
    '/me/snmp-topology',
    agentAuth,
    asyncHandler(async (req, res) => {
      const errors = {};
      const batch = validateSnmpTopologyBatch(req.body, errors);
      if (!batch) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      if (!snmpTopologyIngest) {
        return res.status(503).json({ error: 'SNMP topology ingest is not configured' });
      }
      if (!batch.devices.length && !batch.failures.length) {
        return res.status(202).json({ stored: 0, fdbRows: 0, neighbourRows: 0, interfaceRows: 0, renumbered: [], loops: 0, refused: 0, failuresRecorded: 0, skipped: batch.skipped });
      }
      const result = await snmpTopologyIngest.ingest(req.agent.agentId, batch);
      return res.status(202).json({ ...result, skipped: batch.skipped });
    })
  );

  // POST /agents/me/snmp-counters { devices, errors } — one counter cycle of
  // the switches assigned to this agent: a snapshot of every interface counter,
  // turned into rates against the previous snapshot.
  //
  // Its own endpoint rather than folded into the topology POST, because the two
  // run at different cadences (a counter series' interval IS its resolution)
  // and a counter batch is an order of magnitude larger.
  //
  // The ownership check lives in the ingest, like the topology path's.
  router.post(
    '/me/snmp-counters',
    agentAuth,
    asyncHandler(async (req, res) => {
      const errors = {};
      const batch = validateSnmpCounterBatch(req.body, errors);
      if (!batch) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      if (!snmpCounterIngest) {
        return res.status(503).json({ error: 'SNMP counter ingest is not configured' });
      }
      if (!batch.devices.length && !batch.failures.length) {
        return res.status(202).json({
          stored: 0, samples: 0, findings: 0, unresolved: 0, refused: 0, failuresRecorded: 0,
          discontinuities: {}, skipped: batch.skipped,
        });
      }
      const result = await snmpCounterIngest.ingest(req.agent.agentId, batch);
      return res.status(202).json({ ...result, skipped: batch.skipped });
    })
  );

  // POST /agents/discovery-results — candidates found by THIS agent's sweep
  // (agent-executed discovery). Upserts them as 'discovered' candidates tagged
  // with the finding agent (never auto-enrolled), and audits the sweep. A scope
  // refusal is audited too. Agent-authed; best-effort ingest.
  router.post(
    '/discovery-results',
    agentAuth,
    asyncHandler(async (req, res) => {
      if (!discoveredDevicesRepo) return res.status(503).json({ error: 'Discovery not available' });
      const agentId = req.agent.agentId;
      const b = req.body || {};
      const scopeStr = (Array.isArray(b.scope) ? b.scope : []).join(',') || (b.derivedFromSelf ? '(self)' : '(none)');

      if (b.refused) {
        if (auditLogger && typeof auditLogger.record === 'function') {
          await auditLogger.record(null, { category: 'discovery', action: 'discovery_sweep_refused', actorRole: 'system', target: `agent:${agentId}`, detail: `reason=${String(b.reason || 'unknown').slice(0, 64)} scope=${scopeStr}` });
        }
        return res.status(202).json({ ok: true, refused: true });
      }

      const candidates = Array.isArray(b.candidates) ? b.candidates : [];
      let ingested = 0;
      for (const c of candidates) {
        if (!c || typeof c.ip !== 'string' || !c.ip.trim()) continue;
        const openPorts = Array.isArray(c.openPorts) ? c.openPorts.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 65535) : [];
        try {
          await discoveredDevicesRepo.upsertCandidate({ ip: c.ip.trim(), hostname: typeof c.hostname === 'string' ? c.hostname.slice(0, 255) : null, openPorts, icmp: !!c.icmp, foundByAgentId: agentId }); // eslint-disable-line no-await-in-loop
          ingested += 1;
        } catch (err) {
          if (logger) logger.warn(`discovery-results ingest failed for agent ${agentId}: ${err && err.message}`);
        }
      }
      if (auditLogger && typeof auditLogger.record === 'function') {
        await auditLogger.record(null, { category: 'discovery', action: 'discovery_sweep', actorRole: 'system', target: `agent:${agentId}`, detail: `agent-executed addresses=${b.addresses ?? '?'} probed=${b.probed ?? '?'} found=${ingested} scope=${scopeStr}` });
      }
      res.status(202).json({ ok: true, ingested });
    })
  );

  return router;
}

module.exports = { createAgentReportsRouter };
