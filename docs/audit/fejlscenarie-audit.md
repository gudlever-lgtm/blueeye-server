# BlueEye: audit af fejlsøgnings- og overbliksdækning

Dato: 2026-09-23. Audit af `blueeye-server` 0.187.1 (commit `c006bf0`) og `blueeye-agent` 0.38.2 (commit `9c04a0b`).
Read-only: ingen kodeændringer. Stier med præfikset `server/` og `agent/` er relative til hvert repo.

**Metode.** Hver påstand bygger på kode, der er åbnet og læst. Funktionsnavne, kommentarer og docs er
ikke brugt som bevis. Dataflowet er fulgt fra agent/collector til MySQL, analyse, API og UI. Et led, der
mangler, betyder, at funktionen ikke er dækket. "ikke fundet" betyder, at der blev søgt uden resultat.

Følgende fund er genverificeret særskilt, fordi de ændrer konklusionen:

- **Interface-transitioner registreres aldrig i drift.** Servicen læser `r.payload.traffic`
  (`server/src/health/interfaceStateService.js:37`). Agenten sender `traffic` øverst i hvert result
  (`agent/src/testRunner.js:23-31`), og resultatet gemmes uændret
  (`server/src/validation/resultsValidation.js:37`). Analysepipelinen læser korrekt `payload.traffic` på
  selve elementet (`server/src/analysis/ingest.js:28`). Testen fodrer den forkerte form
  (`server/test/interfaceState.test.js:47,217`) og skjuler derfor fejlen.
- **FLATLINE-fejl på fejltællere er genskabt med de rigtige moduler.** 250 nul-prøver efterfulgt af
  værdien 5 på `if.3.fcs.pps` gav FLATLINE/WARN for hver prøve fra nr. 200 til 250, inklusive den første
  rigtige fejl (nr. 250). Først nr. 251 gav ANOMALY/CRIT (`server/src/analysis/detector.js:67-77`,
  `server/src/analysis/baselines.js:181-190`).
- **Trap-hændelser sendes kun, hvis syslog er startet.** Flush-timeren oprettes kun i `startSyslog`
  (`agent/src/runtime.js:633-645`). `startTraps` opretter ingen timer (`agent/src/runtime.js:728-738`).
- **`clusterAlertGate` bliver sendt ind, men aldrig brugt.** `server/src/server.js:863` sender den til
  `createProbePipeline`, men den er ikke blandt funktionens parametre (`server/src/analysis/probePipeline.js:17-36`).
- **Søgningens rate-limiter når aldrig routeren.** Den sendes fra `server/src/server.js:1204`, men
  `app.js` modtager den ikke. Routeren får derfor `null` (`server/src/routes/index.js:243`).
- **Ingen OT-protokoller og ingen DHCP-probe.** Grep i begge repos (se fase 1).

**Testkørsel.** Afhængighederne blev installeret fra de eksisterende lockfiler med `npm ci`. `node_modules`
er gitignored, og der er ikke tilføjet nye afhængigheder.

- Server `npm test`: 5652 tests, 5651 bestået, 1 sprunget over (TSDB-integrationen kræver `TSDB_TEST_URL`), 0 fejlet.
- Agent `npm test`: 816 tests, 816 bestået.

---

## 1. Resumé

- **Virker:** Syslog-indsamling, agentprober, agent-heartbeat og MAC-flytninger fra switchenes FDB. Probeprøver
  giver findings med median+MAD-baseline, alarm og event case. Syslog-klassificering indeholder duplex, STP,
  DHCP og ACL. L2-loop-detektion fra FDB. Et 24-timers ændringsfeed.
- **Delvist:** SNMP-polling (IF-MIB, BRIDGE/Q-BRIDGE, LLDP og EtherLike) virker. Fejltællerne (CRC, duplex)
  er slået fra som standard pr. enhed, og duplex-status kasseres før lagring. sFlow gemmer kun flow-samples;
  counter-samples smides væk. Link down på switchporte vises kun i Device Log. Der er ingen alarm.
  Hændelser fra flere agenter samles på tid og site, ikke på mål.
- **Virker ikke i drift, selv om kode og UI findes:** interface-transitioner og flapping (payload-fejl),
  topologiændringer (agenten sender ikke den LLDP, serveren diff'er) og ECMP-detektion (traceroute beholder
  kun én IP pr. hop). Reverse-testen for asymmetrisk routing prober samme mål som forward-testen.
- **Mangler:** OT-protokolgenkendelse, DHCP-test, alarm ved ny enhed, rapport over dækningshuller, L2-sti
  mellem A og B, adskillelse af "agent død" og "net nede", visning af NIS2-frister i UI, CDP samt
  SNMP-ARP (IP-MIB).
- **Driftsrisiko:** Alerting er slået fra som standard (`server/src/analysis/alerting/config.js:21`).
  Retention-jobbet kører først 24 timer efter opstart. Probe-, transaktions-, speedtest- og audit-tabeller
  har ingen oprydning.

---

## 2. Fase 1: Datakilder

### 2.1 Oversigt

| Datakilde | Status | Indsamling (agent) | Lagring (server) | Opløsning | Retention |
|---|---|---|---|---|---|
| sFlow (hsflowd) | **Delvist** | `agent/src/sflow/collector.js:17-47`, `agent/src/sflow/parse.js:51-97` (kun flow-samples type 1/3 og raw header). Counter-samples tælles kun (`parse.js:53-55`). hsflowd: `agent/src/sflow/hsflowd.js:213-258` | `POST /agents/results` (`server/src/routes/agentReports.js:156`) → `results` (`server/src/repositories/resultsRepository.js:20-28`) og `flow_records` (`server/src/repositories/flowsRepository.js:37-41`, via `server/src/geo/flowPipeline.js:23-49`) | Aggregeret pr. rapport, ca. 60 s (`agent/src/config.js:78`). Top 200 5-tupler og top 50 talkers (`agent/src/netflow/aggregate.js:53-88`). Ingen VLAN, MAC eller ifIndex (`agent/src/sflow/decodePacket.js:32-35`) | Rå 7 d. Rollup 90 d, men kun eksterne, geolokerede flows (`server/src/analysis/retention/repo.js:29-37`). Interne flows slettes efter 7 d uden rollup (`repo.js:57-59`) |
| SNMP-polling | **Delvist** | Topologi: `agent/src/snmpTopology.js:147-211`. Tællere: `agent/src/snmp/counters.js:92-177`. 1:1-kilde: `agent/src/snmpMonitor.js:19-30`. OID'er i `agent/src/snmp/oids.js` | `POST /agents/me/snmp-topology` (`agentReports.js:467`) → `device_interfaces`, `fdb_entries`, `snmp_neighbors` (`server/src/devices/snmpTopologyIngest.js:84-108`). `POST /agents/me/snmp-counters` (`agentReports.js:496`) → `device_counter_samples` (`server/migrations/109_create_device_counter_samples.sql:53-108`) | Topologi pr. enhed hvert 300 s (`agent/src/snmpPoller.js:31`). Tællere hvert 60 s (`snmpPoller.js:53`). Ingen rollup | `device_counter_samples` 14 d (`server/src/analysis/retention/config.js:48`). `fdb_entries` og `snmp_neighbors` 30 d (`config.js:30`). `device_interfaces` 180 d (`config.js:41`) |
| SNMP-traps | **Delvist** | `agent/src/traps/receiver.js:49-112` (UDP 1162, kun afsendere der polles). Oversættelse: `agent/src/traps/translate.js:31-203`. Slået fra som standard (`agent/src/config.js:113`). **Sendes ikke, hvis syslog er slået fra** (`agent/src/runtime.js:633-645`) | `POST /agents/me/device-events` (`agentReports.js:434`) → `device_events` (`server/src/devices/deviceEventIngest.js:110-138`, `server/migrations/103_create_device_events.sql:43`) | Én række pr. hændelse, foldet pr. 5 min (`deviceEventIngest.js:35`) | 30 d (`config.js:25`) |
| Syslog | **Virker** (slået fra som standard) | `agent/src/syslog/receiver.js:166-233` (UDP/TCP 1514). Parser: `agent/src/syslog/parse.js:77-169`. Klassificering: `agent/src/syslog/classify.js:46-106`. Maskering: `agent/src/syslog/mask.js:16-37`. Standard fra (`agent/src/config.js:98`) | Samme som traps → `device_events`. UI: Device Log (`server/public/app.js:6736`) | Flush hvert 30 s (`agent/src/config.js:105`). Fold pr. 5 min | 30 d |
| LLDP/CDP-naboer | **Delvist** | LLDP kun via SNMP `lldpRemTable` (`agent/src/snmpTopology.js:187-192,343-374`). Ingen lokal lldpd og ingen CDP (grep: ikke fundet) | `snmp_neighbors` (`server/migrations/106_create_snmp_neighbors.sql:21`). Stien `capabilities.lldp` → `lldp_neighbors` (`agentReports.js:375-389`) **fodres aldrig**, fordi agenten ikke sender `lldp` (`agent/src/runtime.js:429-464`) | Øjebliksbillede med `last_seen` | `snmp_neighbors` 30 d. `lldp_neighbors` 24 t (`server/src/topology/lldpGraphService.js:19`) |
| MAC- og ARP-tabeller | **Delvist** | FDB: `agent/src/snmpTopology.js:288-325` (Q-BRIDGE, fallback til BRIDGE). Lokal ARP: `agent/src/arpTable.js:183-211`, **kun ved start og genforbindelse** (`agent/src/runtime.js:828,1445`). SNMP-ARP (IP-MIB): ikke fundet | `fdb_entries` med `move_count` (`server/src/repositories/fdbEntriesRepository.js:91`). `arp_entries` (`agentReports.js:406-416`, `server/migrations/073_create_arp_entries.sql:39-58`) | Øjebliksbillede og `last_seen` | 30 d begge (`config.js:16,30`) |
| Agent-tests | **Virker** (med forbehold) | Dispatcher: `agent/src/probes/index.js:16-24`. Planlagt hvert 60 s (`agent/src/runtime.js:761-810`). Ping `probes/ping.js:167`, traceroute `probes/traceroute.js:22`, DNS `probes/dns.js:9`, HTTP `probes/http.js:14`, TLS `probes/tls.js:28`, TCP `probes/tcp.js:9`. Transaktioner: `agent/src/transactions/` (http/tcp/dns/icmp) | `POST /agents/probe-results` (`agentReports.js:64`) → `probe_results` (`server/src/repositories/probeResultsRepository.js:103`). Transaktioner via WS `transaction_result` (`server/src/ws/agentSocket.js:360,449-485`) → `transaction_results` | Pr. kørsel: rtt, min, max, jitter og loss% (`agent/src/probes/stats.js:60-76`) | **Ingen oprydning** af `probe_results`, `transaction_results` og `speedtest_results` (ikke fundet) |
| Interfacefejl (CRC, errors, discards, duplex) | **Delvist** | `ifIn/OutErrors`, `ifIn/OutDiscards`, `dot3StatsFCSErrors`, Alignment, LateCollisions, CarrierSense og DuplexStatus (`agent/src/snmp/counters.js:56-72,129-164`). Kræver `ifcounters` pr. enhed, som **ikke er standard** (`server/src/repositories/snmpDevicesRepository.js:51`). Lokal NIC: `/proc/net/dev` errs og drop, men ikke frame/carrier/colls (`agent/src/trafficMonitor.js:9-29`). Duplex læses ikke lokalt | `device_counter_samples` (fcs, errors, discards, late_collisions). **Duplex valideres, men gemmes ikke** (`server/src/validation/snmpDeviceValidation.js:443`; ingen kolonne i `server/src/repositories/deviceCounterSamplesRepository.js:22-27`) | 60 s rå | 14 d |
| Ændringshistorik | **Delvist** (topologi og interface: **Stub i drift**) | Agenten sender ingen diffs. Trap/syslog `config.changed` (`agent/src/syslog/classify.js:95-96`, `agent/src/traps/translate.js:62,74`) | `topology_changes`: kun fra agent-LLDP, som aldrig sendes (`server/src/topology/topologyChangeService.js:49-98`). `interface_state_transitions`: payload-fejl, se øverst. `config_snapshots`: kun manuel upload (`server/src/routes/deviceConfig.js:42-73`). `discovered_devices` (`agentReports.js:523-556`). Feed: `server/src/changes/changesService.js:149-161` | Pr. hændelse | `topology_changes` og `discovered_devices`: ingen oprydning. Transitioner 90 d (`config.js:19`). Config-snapshots 180 d |
| OT-protokolgenkendelse | **Mangler** | Ikke fundet (grep efter modbus, s7, dnp3, iec104, bacnet, opc, 502, 102, 2404, 20000, 44818, 47808, 4840). `PROTO_NAMES` = icmp/tcp/udp/gre/esp/icmpv6 (`agent/src/netflow/fields.js:23`) | Ingen OT-porte i `server/src/flows/services.js:16-36` eller `server/src/flows/categories.js:15-34`. En admin kan selv definere port-kategorier (`server/src/services/settings.js:222-261`) | – | – |
| Agent-heartbeat og status | **Virker** | WS-heartbeat hvert 15 s (`agent/src/config.js:68`, `agent/src/agentClient.js:49-60`). Backoff 1–30 s (`agent/src/backoff.js:5-9`). Systemmetrik med hver rapport (`agent/src/systemMetrics.js:55-87`) | `agents.status` og `last_seen` (`server/src/ws/agentSocket.js:210-212,235-241,366-384`). Server-ping hvert 30 s (`server/src/ws/wsCommon.js:39-56`). Stale-sweep **kun ved opstart** (`server/src/server.js:1232-1236`) | `last_seen` højst 1 skrivning/min | `audit_events` agent.online/offline: ingen oprydning |

### 2.2 SNMP: MIB'er der rent faktisk polles

| MIB | OID'er | Fil:linje | Standard |
|---|---|---|---|
| SNMPv2-MIB | sysUpTime, sysName, sysDescr (sysDescr kasseres i `buildTopology`, `agent/src/snmpTopology.js:412-428`) | `agent/src/snmp/oids.js:59-62` | Ja |
| IF-MIB | ifDescr, ifType, ifPhysAddress, ifAdminStatus, ifOperStatus, ifName, ifHighSpeed, ifAlias | `oids.js:22-53`, `snmpTopology.js:167-176` | Ja |
| IF-MIB-tællere | ifHC*Octets/Pkts (32-bit fallback), ifIn/OutErrors, ifIn/OutDiscards | `agent/src/snmp/counters.js:33-61` | **Nej** (`ifcounters`) |
| EtherLike-MIB | dot3StatsFCSErrors, AlignmentErrors, LateCollisions, CarrierSenseErrors, DuplexStatus | `counters.js:67-72,129-132` | **Nej** |
| BRIDGE-MIB | dot1dBasePortIfIndex, dot1dTpFdbPort/Status | `oids.js:93-95` | Ja |
| Q-BRIDGE-MIB | dot1qTpFdbPort/Status, dot1qVlanStaticName (VLAN-navne gemmes ikke, se 2.3) | `oids.js:108-110` | Ja |
| LLDP-MIB | lldpRemChassisId(+Subtype), lldpRemPortId(+Subtype), lldpRemPortDesc, lldpRemSysName | `oids.js:121-126` | Ja |
| Defineret, men aldrig læst | ifMtu, ifSpeed, sysObjectID, **sysLocation**, dot1dStpTopChanges, dot1dStpPortState | `oids.js:24-25,60,63,99-101` | – |
| Ikke fundet | ENTITY-MIB (kun som trap-OID), IP-MIB ipNetToMedia (ARP), HOST-RESOURCES, CISCO-CDP-MIB | – | – |

### 2.3 Data der indsamles, men ikke når frem

- VLAN-navne valideres (`server/src/validation/snmpDeviceValidation.js:302-307`), men bliver aldrig gemt (ikke fundet).
- Duplex-status valideres (`snmpDeviceValidation.js:443`), men har ingen kolonne.
- sysDescr bliver læst, men kasseres (`agent/src/snmpTopology.js:412-428`).
- sFlow counter-samples kasseres (`agent/src/sflow/parse.js:53-55`). hsflowd's 20 s-interfacepolling er dermed spildt.
- Trap-resolveren fra ifIndex til ifName fyldes kun af en tvungen `poll-snmp`. Den planlagte cyklus sender ingen `onResult` (`agent/src/snmpPoller.js:299-301` mod `agent/src/runtime.js:690`).
- Timescale: skemaet opretter `flow_records`, `probe_results` og `speedtest_results`, men intet repository skriver til dem (`server/db/timescale/001_init.sql:66,102,192`).

---

## 3. Fase 2: Fejlscenarier

| # | Scenarie | Opdages | Mekanisme (fil:linje) | Nødvendige data | Peger på rodårsag | Vises i UI/alarm | Test findes | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | Link down | Delvist | Trap `agent/src/traps/translate.js:35,193-196`. Syslog `agent/src/syslog/classify.js:48-59`. Probe-reachability `server/src/health/probeHealth.js:154-158` → `server/src/analysis/probeFindings.js:92` | Traps/syslog (switchport) eller prober (symptom) | Trap/syslog: ja, porten navngives. Probe: nej | Trap/syslog: kun Device Log (`server/public/app.js:6736`) og Changes. **Ingen finding, alarm eller case.** Probe: finding, alarm og case (`server/src/analysis/probePipeline.js:100,112`). Switchens `oper_status` overskrives uden historik (`server/src/repositories/deviceInterfacesRepository.js:114`) | `agent/test/traps.test.js:41`, `agent/test/syslogParse.test.js:119`. Syntetisk | **Delvist** |
| 2 | Flappende link | Nej (i drift) | `server/src/health/interfaceStateService.js:23,92-93` modtager aldrig data (payload-fejl, se øverst). LLDP-flap `server/src/topology/topologyChangeService.js:59-92` fodres aldrig. Switchport-link.down/up fra trap/syslog foldes kun i 5-min-buckets (`server/src/devices/deviceEventIngest.js:35`) | Agent-NIC-status, LLDP, traps | (Ja, hvis den kørte) | Changes-type `interface.flapping` (`server/src/changes/changeFeed.js:290`) og topologi-overlay (`server/public/app.js:6212-6215`) forbliver tomme. Ingen alarm | `server/test/interfaceState.test.js:172`, med forkert payload-form | **Ikke dækket** (kode og UI findes, modtager intet) |
| 3 | Duplex mismatch / CRC | Delvist | FCS-rate `server/src/devices/counterDelta.js:180` → detector (`server/src/analysis/deviceIngest.js:43`, `server/src/analysis/detector.js:87-105`). Syslog `duplex.mismatch` (`agent/src/syslog/classify.js:70-71`) | SNMP EtherLike (opt-in), syslog | Delvist: port ja (`detector.js:55-56`), men ikke årsagen (duplex eller kabel). Duplex-status kasseres. Late collisions analyseres ikke | Findings (`server/public/views/analysis.js:374`), alarm og case (`server/src/analysis/pipeline.js:143-177`). Switch-UI viser ikke FCS, late collisions eller duplex (`server/public/views/snmpDevice.js:143-153`). **FLATLINE-støj** på nul-tællere | `server/test/counterDelta.test.js:29`, `server/test/deviceFindings.test.js:119-135` (stubber `isFlat` og skjuler dermed fejlen). Syntetisk | **Delvist** |
| 4 | L2-loop | Delvist | `server/src/analysis/l2Loop.js:35-177`, `server/src/analysis/l2LoopService.js:157,183,223`, kaldt fra `server/src/devices/snmpTopologyIngest.js:141-143` | FDB (BRIDGE/Q-BRIDGE), broadcast-tællere, STP-events | Ja, portpar (`l2Loop.js:112`) | Finding og event case. **Ingen alarm-dispatcher koblet på** (`server/src/server.js:657-667`). `move_count` er kumulativ, men bruges som "i vinduet" (`l2LoopService.js:157`). STP-opslag bruger `snmp_devices.id` mod agent-id (`l2LoopService.js:126` mod `server/src/topology/hostResolver.js:40-49`) | `server/test/l2Loop.test.js:37-130`, `server/test/l2LoopService.test.js:100-118`. Syntetisk | **Delvist** |
| 5 | Asymmetrisk routing | Nej | Kun on demand i diagnose (`server/src/diagnose/facts.js:244-253`). Reverse-testen prober **samme mål** fra peer-agenten (`server/src/diagnose/plan.js:66-68`). Flow-"asymmetri" er et byte-forhold (`server/src/routes/flows.js:355-374`) | Traceroute fra to ender | Nej | Diagnose-view (`server/public/views/diagnose.js:188`), flow-banner. Ingen alarm | `server/test/diagnoseRules.test.js:31-32` (håndskrevne facts) | **Kun spec** |
| 6 | Én ECMP-sti dør | Nej | Parseren beholder kun den første IP pr. hop (`agent/src/probes/traceroute.js:148`). `countBranches` tæller inden for én kørsel og er derfor altid 1 (`server/src/routes/diagnose.js:351-363`). Sti-grafen ser forgreninger på tværs af kørsler, men en død sti vises som `*` (`server/src/analysis/pathGraph.js:217-285`) | Multi-run traceroute (ikke Paris) | Nej | ECMP-badge (`server/public/app.js:4947,5112`). Ingen finding eller alarm | `server/test/diagnoseRules.test.js:35-37` (injicerer `branch_count:2`) | **Kun UI** |
| 7 | DNS fejler | Ja (som symptom) | DNS-probe `agent/src/probes/dns.js:9-22` (OS-resolver, fejlkoden kasseres) → `probeHealth.js:128,158`. Transaktion `agent/src/transactions/executors/dns.js:21-24` (tjekker `ETIMEDOUT`, men Node bruger `ETIMEOUT`) | DNS-prober, transaktioner | Nej: "N/M targets not responding". NXDOMAIN, SERVFAIL og timeout skelnes ikke | Finding, alarm og case (probe). Transaktionsalarm dispatches uden finding eller case (`server/src/ws/agentSocket.js:527-550`) | `agent/test/transactions.test.js:165` (kun ENOTFOUND, stubbet) | **Delvist** |
| 8 | DHCP fejler | Delvist (passivt) | Kun syslog `dhcp.pool_exhausted` / `dhcp.conflict` (`agent/src/syslog/classify.js:82-84`). Aktiv DHCP-probe: ikke fundet | Syslog fra DHCP-server/router | Delvist (pool/konflikt, hvis det logges) | Kun Device Log og Changes (sev ≤4, `server/src/changes/changesService.js:134`). Ingen alarm eller case | Ingen DHCP-case i `agent/test/syslogParse.test.js:117-130` | **Delvist** |
| 9 | Høj latency/jitter på én sti | Ja | Median+MAD pr. `type\|target` (`server/src/health/probeHealth.js:83-100,128,165`). Jitter med fast tærskel 30/100 ms (`probeHealth.js:20,166`) → `probeFindings.js:37-41` → `probePipeline.js:83-112` | Ping/TCP-prober, traceroute | Delvist: målet navngives, ikke hoppet. Hop-vurdering kun i sti-grafen med faste tærskler 120/250 ms (`server/src/analysis/pathGraph.js:24,39-50`). Baselinen inkluderer den aktuelle prøve i et 6-timers vindue (`probeHealth.js:85`, `probePipeline.js:31`), så vedvarende forringelse bliver "normal" | Finding, alarm og case. Sti-graf `GET /api/probes/path` (`server/src/routes/probes.js:64`). Cooldown 30 min mod case-vindue 15 min giver et nyt case ca. hver 30. min (`probePipeline.js:32`, `server/src/eventCases/activityWindow.js:30`) | `server/test/probeFindings.test.js:251`, `server/test/probeLatencyFloor.test.js:41,70,78`. Syntetisk | **Delvist** |
| 10 | Ny ukendt enhed | Nej (kun liste) | ARP-upsert uden "ny"-signal (`server/src/repositories/arpEntriesRepository.js:57-67`). Discovery → `discovered_devices` (`server/src/discovery/discoverySweepJob.js:54-55`). LLDP `neighbour_added` = INFO (`server/src/topology/topologyDiff.js:24`), men fodres ikke | ARP, FDB, discovery | Nej. Ingen sammenligning med CMDB (`server/src/cmdb/connectors.js` er kun søgning) | Discovery-side (`server/public/app.js:6458`) og Troubleshooting-liste (`server/src/troubleshooting/overviewService.js:142`). Changes-feedet har ingen ARP-, FDB- eller discovery-kilde (`changesService.js:149-161`). Ingen alarm | `server/test/arpIngest.test.js`, `server/test/discovery*.test.js`. Ingen test af "ny enhed → alarm" | **Kun UI** |
| 11 | ACL/firewall blokerer én trafiktype | Delvist | TCP-probe på en konfigureret port → reachability-finding (`probeHealth.js:158`). TCP-proben skelner ikke refused fra timeout (`agent/src/probes/tcp.js`, `connectOnce` → `finish(false)`). Transaktioner beholder errno og fase (`agent/src/transactions/phase.js:13-15`) | TCP-prober/transaktioner pr. port, syslog `acl.denied` | Nej. Ingen regel af typen "ICMP ok + TCP fejler ⇒ filter" (ikke fundet). Flow-baseline scorer kun par, der findes (`server/src/analysis/flowPairBaselineJob.js:103,117`), så en port, der går til nul, bliver aldrig scoret | Probe-finding og alarm. Transaktionsalarm uden case. `acl.denied` kun i Device Log (`agent/src/syslog/classify.js:88`) | `server/test/probeFindings.test.js:11,268`. Ingen test af refused/timeout | **Delvist** |
| 12 | Agent offline: død eller net nede? | Offline: ja. Skelnen: nej | WS-close → `offline` (`server/src/ws/agentSocket.js:377-383`). Stale i feedet efter 15 min (`server/src/changes/changeFeed.js:426-446`). `server/src/ws/connectionDiagnosis.js` ser kun egen socket, licens og auth | Heartbeat. Andre agenters prober og SNMP-portstatus bruges **ikke** | Nej. Blast radius behandler den offline agent som fejlende node (`server/src/topology/blastRadius.js:105-124`) og overskriver online naboer til `unreachable_downstream` (`server/src/troubleshooting/overview.js:306-308`) | Fleet-badge, Changes, Troubleshooting-topologi. **Ingen alarm, finding eller case** | `server/test/troubleshootingTopologyState.test.js:39-49` låser den forkerte tilskrivning fast. Syntetisk | **Delvist** |
| 13 | Samme fejl fra flere agenter | Ja, grupperes | 5-min-bucket forankret i det tidligste medlem, derefter site → LLDP-komponent → metric → tid (`server/src/analysis/crossAgentCorrelator.js:30,60-76,153-197`). **Mål indgår ikke i nøglen.** Dedup ved overlap ≥1 finding (`server/src/analysis/crossAgentClusterService.js:92-95`) | Findings fra flere agenter, `location_id`, LLDP | Delvist: site-hint (`crossAgentCorrelator.js:110-134`) | Situations (`server/src/routes/eventClusters.js:74`, `server/public/app.js:4378`). Én cluster-alarm. NIS2-kladde ved CRIT (`server/src/analysis/clusterNotifier.js:139-145`). Event cases grupperes pr. host og kender ikke clusters (`server/src/eventCases/eventCaseService.js:95-113`). `clusterAlertGate` er ikke koblet i probe-pipelinen, så probe-findings alarmerer stadig enkeltvis | `server/src/analysis/__tests__/crossAgentCorrelator.test.js`, `server/test/crossAgentClusterService.test.js:57,148,163,323`. Syntetisk | **Delvist** |

### Tværgående for fase 2

- `ALERTING_ENABLED` er som standard `false` (`server/src/analysis/alerting/config.js:21`). Uden den
  ændring sendes ingen af alarmerne ovenfor.
- Probe- og analysepipelinen sender det oprindelige finding-objekt videre efter `save()`
  (`server/src/analysis/probePipeline.js:83-84`, `server/src/analysis/pipeline.js:122-123`).
  Severity-regler rammer kun den gemte kopi (`server/src/analysis/findings.js:221-266`). Alarmer og cases
  bruger derfor detektorens severity, ikke den regeljusterede.
- Event cases grupperes pr. `host_id`. For switch-findings er host den agent, der poller. Alle switches,
  som én agent poller, havner derfor i samme case (`eventCaseService.js:102`).
- Diagnose kører kun, når en operatør starter den (`POST /api/diagnose`, `server/public/app.js:6630-6637`).
- Probe-outages alarmerer aldrig (`server/src/probeOutages/probeOutageService.js`). Jitter er ikke
  en outage-metric (`server/src/probeOutages/detection.js:12`).

---

## 4. Fase 3: Overbliksspørgsmål

| # | Spørgsmål | Svar | Route | UI | Data |
|---|---|---|---|---|---|
| 1 | Hvilke enheder har jeg, og hvor sidder de? | **Delvist** | `/agents` (`server/src/routes/agents/`), `server/src/routes/snmpDevices.js:55`, `server/src/routes/discovery.js:153`, `server/src/routes/locations.js:21`, `server/src/routes/search.js:35` | `agents` (`server/public/app.js:1582`), `locations` (`app.js:10741`), `map` (`app.js:10053`), `discovery` (`app.js:6467`, kun admin), global søgning (`app.js:8392`) | `agents.location_id`, `snmp_devices.location_id`, `discovered_devices` (uden placering), `fdb_entries`. Placering kun på site-niveau (`server/migrations/001_create_locations.sql`, `008_add_location_coords.sql`). Rack, rum og etage: ikke fundet. `sysLocation` polles ikke. Ingen samlet enhedsliste, kun søgning samler (`server/src/search/searchService.js:25-34`). MAC → switchport via FDB (`searchService.js:162-185`) |
| 2 | Hvad taler med hvad (OT: PLC ↔ SCADA)? | **Delvist** (IP↔IP ja, OT-mærkning nej) | `server/src/routes/topology.js:153,196,208`, `server/src/routes/flows.js:155,323` | `topology` (`app.js:6329`, `server/public/views/topology.js:35`), `flows` (`app.js:9661`) | `flow_records` (kræver sFlow/NetFlow), `service_dependencies` (**kræver agent i begge ender**, `server/src/topology/hostResolver.js:1-15`, kun TCP). Flow-topologi uden port (`server/src/repositories/flowsRepository.js:297-303`). `/api/topology/graph` sender ingen switches med (`topology.js:202`). Ingen OT-protokoller |
| 3 | Hvad er normalt for dette link/denne enhed? | **Delvist** | `server/src/routes/topology.js:29` (flow-par, operator), `server/src/routes/baselines.js:50` (ingen UI kalder den), `server/src/routes/forecast.js:60` | Baseline-modal på agentsiden (`app.js:9254-9282`), `interfaces` og forecast (`app.js:7035`), findings | `flow_pair_baselines` (ugedag × time, median+MAD, `server/migrations/068_create_flow_pair_baselines.sql`). Værts-baseline kun i memory/fil (`server/src/analysis/baselines.js`) og vises kun som felt på findings. SNMP-portmetrikker (`server/src/analysis/deviceIngest.js:37-46`). Probe: rullende median (`probeHealth.js:83-96`). `BaselineMetric` indlæses, men bruges ikke af nogen view (`server/public/index.html:256`) |
| 4 | Hvad har ændret sig de seneste 24 timer? | **Ja** (med huller) | `server/src/routes/changes.js:34,81`, `server/src/routes/topology.js:58` | `changes` = landingsside (`app.js:8563`), `delta` (`app.js:6402`) | 11 kilder (`changesService.js:149-161`). Topologiændringer og interface-transitioner er tomme i drift (fase 1). SNMP-naboændringer diff'es ikke. Nye ARP/FDB-enheder er ikke med |
| 5 | Hvilke dele af netværket ser jeg IKKE? | **Nej** | `server/src/routes/setup.js:60`, `server/src/routes/troubleshooting.js:31` | Setup-tjekliste (`app.js:12836`), Troubleshooting (`app.js:7007`) | Tjeklisten tæller konfiguration (`server/src/services/setupChecklist.js:77-175`). Ikke-promoverede discovery-kandidater (`server/src/troubleshooting/overviewService.js:137-142`). Rapport over subnets uden agent, switches uden SNMP eller manglende sFlow-kilder: ikke fundet |
| 6 | Hvilken sti tager trafikken fra A til B lige nu? | **Delvist** (L3 fra agent, ingen L2) | `server/src/routes/probes.js:64,99` | `pathVisualization` (`app.js:5397`), brugt i probe-detalje, topologi, event og Destinations | `probe_results` (traceroute) og GeoIP/ASN. A skal være en agent. Kun én IP pr. hop. L2-sti mellem to punkter: ikke fundet (`server/src/topology/lldpGraph.js:64-83` returnerer kun antal hop) |
| 7 | Hvad skal jeg dokumentere til NIS2 art. 23? | **Delvist** | `server/src/routes/nis2/incidents.js:19,36,41`, `server/src/routes/reports.js:151` (ingen UI) | NIS2 → Incidents (`app.js:15856`), NIS2-udkast fra Investigate (`app.js:6523`) | `blueeye_nis2_incidents`. Frister 24 t / 72 t / 1 md. beregnes (`server/src/nis2/deadlines.js:17-55`), men **vises ikke i UI** (`app.js:15868-15880`). Felter for mistanke om ondsindet handling, grænseoverskridende virkning, CSIRT-reference og indsendelsestid: ikke fundet (`server/migrations/031_create_nis2.sql:61-84`). `event_cases` er ikke koblet til NIS2. Kun clusters er (`server/migrations/064_cluster_rollup_refs.sql:24`), og auto-udkastet får `notificationRequired=false` |

### Hardcoded-, mock- og seed-data i UI

Der er ikke fundet nogen view, der viser opdigtede enheder, topologi eller målinger i stedet for API-data. Hardcodet indhold:

- `server/public/kitchenSink.js:92,107,131-135,247`: faste eksempelrækker og værter (`oslo-edge-01`, `cph-core-02`). Kun på admin-siden `/ui-kitchen-sink`.
- `server/public/app.js:2302-2307`: forvalgte testpakker med `example.com` som mål (skabeloner).
- `server/public/app.js:16077-16097`: knappen "Seed starter controls" → `POST /api/nis2/seed` (`server/src/routes/nis2/audit.js:30`). Opretter startkontroller.
- `server/public/guides.js:39-49`: faste vægte til sundhedsscoren (låst til koden af en test).
- `server/public/app.js:9254` (ugedagsnavne), `app.js:16313-16321` (`TX_PHASE_LABELS`) og `app.js:11528-11536` (hjælpetekst ved agent offline): hardcodet engelsk uden om `t()`.
- `server/scripts/seed-demo.js:2-40`: opretter kun en demo-enrollment-kode, når `SEED_DEMO=1`. Ingen måledata.
- Seed-rækker i migrationer er konfiguration: `023_create_license_plans.sql`, `024_create_incident_thresholds.sql`, `113_snmp_community_assignments.sql`.

---

## 5. Fase 4: Verifikationsstatus

### 5.1 Tests pr. område

Server: 477 testfiler. Agent: 82 Node-testfiler og 17 Go-tests. Antallene er fordelt efter filnavn (±2).

| Område | Server | Agent | Datatype |
|---|---|---|---|
| SNMP (tællere, interfaces, profiler, topologi) | 12 | 6 | Syntetisk: håndbyggede payloads (`server/test/snmpCountersApi.test.js:66`) og falske net-snmp-tabeller (`agent/test/snmpTopology.test.js:5-11`). Ingen rigtige SNMP-walks |
| sFlow, NetFlow, flows og geo | 27 | 10 | Syntetisk: datagrammer bygget i kode (`agent/test/sflow.test.js:10-27`, `agent/test/netflow.test.js:10-29`). Ingen pcap-filer |
| Syslog, traps og device events | 3 | 4 | Håndskrevne linjer i leverandørformat (`agent/test/syslogParse.test.js:21-24`) og håndbyggede varbinds (`agent/test/traps.test.js:11-38`) |
| Prober, transaktioner og path-MTU | 26 | 12 | Mest falske `exec`-kald. Eneste fixture-mappe: `agent/test/fixtures/pathmtu/` (28 værktøjsudskrifter, dokumentations-IP'er) |
| Topologi, LLDP, L2, discovery og ARP | 30 | 5 | Syntetisk (`server/test-support/fakes.js`) |
| Alerting og integrationer | 23 | 0 | Syntetisk, mockede kanaler |
| Event cases, clusters, diagnose og troubleshooting | 58 | 1 | Syntetisk, scriptede pools |
| Analyse, baselines, findings og ændringer | 41 | 0 | Syntetisk, fake mysql2-pool |
| NIS2, rapporter, audit og evidens | 24 | 4 | Syntetisk |
| Auth, sikkerhed, licens og brugere | 48 | 9 | Syntetisk. Rigtige Ed25519-nøgler genereres ved kørsel |
| Agent-livscyklus (enroll, release, update, runtime) | 33 | 26 | Syntetisk (`agent/test-support/fakeServer.js`) |
| Service Assurance | 78 | – | Syntetisk, in-memory repos |
| UI, dashboard og i18n | 43 | – | jsdom med scriptet fetch |
| Gate-suiter | 5 | 5 | Sweep over alle routes med fakes |

- **Rigtig MySQL:** ingen `npm test`-fil. CI kører `verify-schema` og `verify-repositories` mod MySQL 8.4
  (`server/.github/workflows/schema.yml`). Det dækker kun 9 af 67 repositories
  (`verify-repositories-against-mysql.js:40-48`).
- **TimescaleDB:** `server/test/resultsTsdbRepository.integration.test.js:16` springes over, fordi ingen
  workflow sætter `TSDB_TEST_URL`.
- **Go-agenten** (`agent/blueeye-agent-go/`) er ikke med i CI.
- **Konklusion:** Ingen test kører mod realistiske netværksdata. Der er ingen optagne sFlow-datagrammer,
  SNMP-walks eller trap-pcaps.

### 5.2 Endpoints uden tests for 404, 403 og 500

Gate-suiten (`server/test/gate/security.test.js`) dækker:

- 401 på alle ikke-offentlige routes (`:127-156`).
- 403 på alle skrive-routes kaldt som viewer (`:165-176`) og på 11 admin-præfikser (`:178-188`).
- 404 kun for GET/DELETE med id (`:214-222`).
- 500 kun som "aldrig 500"-sweeps. Den egentlige test af "repository-fejl → 500" dækker kun 3 routes: `/users`, `/agents` og `/locations` (`:236-255`).

**Mangler 404** (id-routes, som ingen test og ingen gate-sweep dækker):

| Endpoint | Route |
|---|---|
| POST /agents/:id/run-speedtest | `server/src/routes/agents/commands.js:468` |
| POST /api/burst/:id/stop | `server/src/routes/burst.js:70` |
| POST /api/diagnose/:id/evaluate | `server/src/routes/diagnose.js:250` |
| POST /api/discovery/candidates/:id/ignore | `server/src/routes/discovery.js:292` |
| PUT /api/nis2/risks/:id, /controls/:id, /incidents/:id | `server/src/routes/nis2/risks.js:40`, `nis2/controls.js:43`, `nis2/incidents.js:57` (testen `server/test/nis2Api.test.js:78-83` har PUT i titlen, men asserter kun GET og DELETE) |
| POST /api/nis2/reports/:id/approve | `server/src/routes/nis2/reports.js:67` |
| PUT /api/oidc/role-map/:id, PUT /api/saml/role-map/:id | `server/src/routes/oidc.js:152`, `server/src/routes/saml.js:138` |
| POST /api/severity-rules/:id/apply-to-open | `server/src/routes/severityRules.js:132` (tjekker kun `< 500`) |
| GET /enroll/agent-binary/:arch (offentlig) | `server/src/routes/enroll.js:156` (ingen HTTP-test) |

**Mangler 403** (læse-routes med rollekrav):

- `GET /api/audit/actions` og `/api/audit/export.csv`: `server/src/routes/auditEvents.js:179,185`.
- `GET /api/runbooks/playbooks`: `server/src/routes/runbooks.js:39`.
- `GET /api/snmp-profiles/meta` og `/:id`: `server/src/routes/snmpProfiles.js:77,149`.

**Mangler 500** (ingen test for disse routere asserter status 500):

- Routere under `server/src/routes/`: `agents/releases.js`, `apiTokens.js`, `auditLog.js`, `connectionTest.js`, `dashboard.js`, `diagnostics.js`, `forecast.js`, `geocode.js`, `license.js`, `logs.js`, `map.js`, `oidc.js`, `saml.js`, `reportSchedules.js`, `settings.js`, `setup.js`, `severityRules.js`, `speedtest.js`, `thresholds.js`.
- NIS2: kun `GET /api/nis2/risks` og `export/risk.html` har en 500-test.
- Samlet har 396 af 477 endpoints ingen 500-assertion (heuristik: request og assertion inden for 14 linjer).

**Kun dækket af gate-sweepen** (ingen andre tests kalder dem):

- `GET /api/audit-log/verify` (`server/src/routes/auditLog.js:50`)
- `GET /enroll/agent-binary/:arch` og `GET /enroll/agent-binary-status` (`server/src/routes/enroll.js:156,184`)
- `GET/PUT/DELETE /api/nis2/controls/:id` (`server/src/routes/nis2/controls.js:27,43,55`)
- `DELETE /api/nis2/evidence/:id` (`server/src/routes/nis2/evidence.js:41`)
- `GET` og `DELETE /api/nis2/reports/:id` (`server/src/routes/nis2/reports.js:29,122`)
- `GET /api/nis2/export/{controls.csv, incidents.csv, readiness.html, control.html, incident.html}` (`server/src/routes/nis2/exports.js:40-117`)
- `GET /api/nis2/meta` (`server/src/routes/nis2/meta.js:19`)
- `GET /api/oidc/login-audit` og `GET /api/saml/login-audit` (`server/src/routes/oidc.js:172`, `server/src/routes/saml.js:158`)
- `PUT /api/settings/geoip`, `POST /api/settings/geoip/update` og `GET /api/settings/geoip/update` (`server/src/routes/settings.js:207,222,230`)
- `POST /api/topology/flow-baselines/recompute` (`server/src/routes/topology.js:44`)

Agenten har ingen HTTP-handlers. Den eneste listener er syslog-modtageren.

### 5.3 TODO, stubs, placeholders og død kode

- **TODO:** 1 (`server/src/search/searchService.js:563`). FIXME, XXX og HACK: 0. `not implemented`-throw og 501: 0.
- **Stub:** `resolveUser()` returnerer `[]` (`server/src/search/searchService.js:551,571-573`), men er stadig registreret som resolver (`:588`).
- **`return []`/`return {}`:** 187 i alt. 176 er legitime tidlige returns. Mistænkelige:
  - `server/src/investigation/locator.js:195`: en subnet uden match giver **alle agenter**.
  - `server/src/investigation/locator.js:198-202`: "interface" giver altid alle agenter.
- **Placeholder, fail-closed:** `agent/src/release/publicKey.js:13-15` (`REPLACE_WITH_BLUEEYE_AGENT_RELEASE_PUBLIC_KEY`).
- **Discovery-ICMP-stub:** returnerer `null` (`agent/src/discovery/probes.js:36`).
- **Evidens `agent.state`:** "connected" er altid "unknown". `client.isConnected` findes ikke (`agent/src/runtime.js:1289`).
- **Moduler, der aldrig kaldes:** kun `server/src/analysis/types.js` (JSDoc).
- **Eksporteret, men aldrig brugt:**
  - `windowMatches` (`server/src/analysis/alerting/maintenance.js:16`).
  - `SYSTEM_PROMPT` (`server/src/diagnose/llm.js:36`). Den prompt, der faktisk bruges, er en kopi i `server/src/analysis/assistant.js:710-719`.
  - `findCheck` og `RUNNABLE_IDS` (`server/src/connectionTest/checks.js:45,57`).
  - `fingerprintsMatch` (`server/src/enroll/fingerprint.js:18`).
  - `meetsFeatureTier` (`server/src/license/plans.js:235`).
  - `IF_ADMIN_STATUS` (`agent/src/snmp/oids.js:135`).
- **Repository-metode, der aldrig kaldes:** `purgeOlderThan` (`server/src/repositories/hostConnectionsRepository.js:78-80`).

### 5.4 Delvist bygget, men ikke koblet til UI eller API

| Feature | Hvad mangler | Bevis |
|---|---|---|
| Interface-transitioner og flapping | Modtager aldrig data i drift | `server/src/health/interfaceStateService.js:37` mod `agent/src/testRunner.js:23-31` |
| Topologiændringer (LLDP-diff) | Agenten sender aldrig `capabilities.lldp`. SNMP-naboer diff'es ikke | `server/src/routes/agentReports.js:375-389`, `agent/src/runtime.js:429-464` |
| Søgningens rate-limiter | Når aldrig routeren | `server/src/server.js:1204` → `server/src/routes/index.js:243` |
| `clusterAlertGate` for prober | Parameteren ignoreres | `server/src/server.js:863`, `server/src/analysis/probePipeline.js:17-36` |
| Migration 041 (password-historik og -alder) | `password_history` og `password_changed_at` læses og skrives ingen steder | `server/migrations/041_baseline_security_hardening.sql:17,30` |
| OIDC/SAML-administration | API uden UI. UI-teksten henviser til en skærm, der kun kalder LDAP | `server/src/routes/oidc.js:134-179`, `server/src/routes/saml.js:120-158`, `server/public/app.js:11837,13931-14072` |
| NIS2-frister | `GET /api/nis2/deadlines` har ingen UI-kalder | `server/src/routes/nis2/incidents.js:36` |
| NIS2-udkast for probe-outage | `GET /api/reports/nis2-draft/:id` har ingen UI-kalder | `server/src/routes/reports.js:151` |
| Flow-par-baseline API | `GET /api/baselines/flow-pair` har ingen UI-kalder. `BaselineMetric` bruges ikke | `server/src/routes/baselines.js:50`, `server/public/index.html:256` |
| Audit-log (hash-kæde) | `/api/audit-log`, `/categories` og `/verify` har ingen UI | `server/src/routes/auditLog.js:19,37,50` |
| Øvrige API'er uden UI | `/api/reports/*` (7), `/api/thresholds` (4), `GET /api/topology/neighbors`, `POST /api/forecast`, `/api/nis2/evidence`, `POST /api/investigation/from-event`, `POST /api/severity-rules/preview` | `server/src/routes/reports.js:93-151`, `thresholds.js:20-48`, `topology.js:122`, `forecast.js:35`, `nis2/evidence.js:17-41`, `investigation.js:122`, `severityRules.js:168` |
| VLAN-navne og duplex-status | Valideres, men gemmes ikke | `server/src/validation/snmpDeviceValidation.js:302-307,443` |
| Timescale-hypertables | `flow_records`, `probe_results` og `speedtest_results` skrives aldrig | `server/db/timescale/001_init.sql:66,102,192` |
| Go-agenten | Delvis port, hverken bygget eller testet i CI | `agent/blueeye-agent-go/README.md:8-13`, `server/src/enroll/agentBinaryStore.js:8,14` |

### 5.5 Retention: drift

- Retention-jobbet kører med `setInterval` hver 24. time og **aldrig ved opstart**
  (`server/src/analysis/retention/scheduler.js:121-126`).
- Ingen oprydning (ikke fundet): `probe_results`, `speedtest_results`, `transaction_results`,
  `probe_outages`, `topology_changes`, `discovered_devices` og `audit_events`.

---

## 6. Top 10 huller for et vandselskab med OT-netværk

Rangeret efter betydning i flade netværk med ældre udstyr og få sFlow-kilder.

1. **Ingen OT-protokolgenkendelse.** Modbus-, S7-, DNP3- og IEC-104-trafik vises som unavngivne porte, så
   uventet PLC-kommunikation ikke kan skelnes fra normal.
2. **En ny enhed udløser ingen alarm.** En fremmed laptop eller PLC på et fladt OT-net bliver kun en række
   på discovery-listen. SNMP-ARP (IP-MIB) polles ikke, og lokal ARP læses kun ved agentstart.
3. **"Hvad taler med hvad" kræver agent eller flow-eksport.** Service-afhængigheder kræver agent i begge
   ender. Med få sFlow-kilder ses PLC↔SCADA ikke, og interne flows slettes efter 7 dage uden rollup, så der
   er ingen langtidsbaseline for OT-trafik.
4. **Link down og flapping på switchporte giver ingen alarm.** Trap, syslog og SNMP `oper_status` ender kun
   i Device Log, og interface-transitionerne virker ikke på grund af payload-fejlen. Et ustabilt kabel til en
   PLC opdages ikke automatisk.
5. **Traps sendes aldrig, hvis syslog er slået fra.** Begge er slået fra som standard. Ældre switches, der
   kun kan traps, forbliver tavse.
6. **CRC- og duplex-tællere er fra som standard, og duplex-status kasseres.** FLATLINE-støj på nul-tællere
   og fejlklassificering af den første fejl gør detektionen upålidelig. Duplex mismatch er typisk på ældre
   udstyr og findes kun via syslog.
7. **Ingen rapport over dækningshuller.** Med få agenter og få sFlow-kilder kan man ikke se, hvilke
   segmenter, switches eller porte der ikke overvåges. Tomme skærme ligner et sundt net.
8. **Alerting er slået fra som standard, og alarmerne er støjende.** Probe-findings går uden om
   cluster-gaten, og severity-regler når ikke alarmen. Resultatet er enten ingen alarmer eller en alarmstorm
   pr. agent ved en fælles fejl.
9. **Agent offline kan ikke skelnes fra netværksfejl.** Ingen alarm, og blast radius tilskriver fejlen til
   agenten og gråner raske naboer. En død agent på et fjernanlæg kan ligne et netudfald og omvendt.
10. **NIS2 art. 23-frister vises ikke, og event cases er ikke koblet til NIS2.** Fristen på 24 timer for
    early warning kan overskrides, uden at UI'et advarer. Felter som grænseoverskridende virkning og
    ondsindet handling mangler.

---

## 7. Forslag til lab-test (scenarier markeret Dækket eller Delvist)

Forudsætninger for alle tests:

- `ALERTING_ENABLED=true` og mindst én alarmkanal.
- Mindst to agenter på samme site (`location_id`).
- En managed switch i `snmp_devices`, tildelt en agent, med `collect` inklusive `ifcounters` og en `counter_interval_sec`.
- Agenten startet med `syslogEnabled=true` og `trapsEnabled=true`. Syslog skal være slået til, ellers sendes traps ikke.
- Switchen sender syslog og traps til agentens IP på port 1514 og 1162.

| # | Scenarie | Sådan fremkaldes fejlen | Forventet i BlueEye |
|---|---|---|---|
| 1 | Link down | a) `shutdown` på en switchport med en agent-probet vært bag. b) Træk kablet fysisk | a) Device Log viser `link.admin_down` via trap. b) Device Log viser `link.down` med portnavn via trap/syslog inden for ca. 30 s. Probe-reachability-finding og alarm for værten efter næste probecyklus (60 s). Ingen finding på selve porten. `device_interfaces.oper_status` = down efter næste topologipoll (≤300 s) |
| 3 | Duplex mismatch / CRC | Sæt den ene ende til 100/half og den anden til 100/full, og kør trafik med `iperf3` i 10 min. Alternativt et defekt patchkabel | Syslog `duplex.mismatch` i Device Log (hvis switchen logger CDP-DUPLEX). `device_counter_samples.fcs_errors`/`late_collisions` stiger. **Forventet fejl:** under opvarmningen (≥200 prøver pr. bucket) og på nul-tællere kommer FLATLINE/WARN. Den første fejlprøve klassificeres som FLATLINE, og først den næste giver ANOMALY/CRIT med portnavn. Duplex-status ses ikke nogen steder |
| 4 | L2-loop | Forbind to porte i samme VLAN på en switch med STP slået fra på dem (eller BPDU-filter), i et isoleret lab-VLAN | FDB-moves mellem portparret ved næste topologipoll, finding `l2.loop` med portpar og event case. **Forventet:** ingen alarm (dispatcher ikke koblet). STP-korroborationen er 0 på grund af id-fejlen. Uden MAC-flapping giver en ren broadcast-storm ingen finding |
| 7 | DNS fejler | a) Bloker UDP/TCP 53 til resolveren i en firewall. b) Stop resolveren. c) Lad resolveren svare SERVFAIL | Probe-finding "N/M targets not responding" på DNS-proben og alarm/case. Med en DNS-transaktion konfigureret: transaktionsalarm, hvis `thresholds` er sat. **Forventet:** de tre varianter kan ikke skelnes. En timeout rapporteres som `error`/fase `dns`, ikke `timeout` |
| 8 | DHCP fejler | Formindsk DHCP-puljen til 2 adresser, og tilslut 3 klienter. Serveren skal sende syslog til agenten | `dhcp.pool_exhausted` i Device Log og Changes (hvis severity ≤4). **Forventet:** ingen alarm og intet case. Et stoppet DHCP-servermodul uden logning opdages ikke |
| 9 | Høj latency/jitter på én sti | `tc qdisc add dev <if> root netem delay 80ms 30ms` på en router mellem agent og mål. Hold 30 min, fjern, og gentag i 4 timer | Latency-finding (z ≥ 3 over gulvet) og jitter-finding (> 30 ms WARN / > 100 ms CRIT) med målet navngivet, samt alarm og case. Sti-grafen viser hoppet med høj RTT (> 120 ms). **Forventet:** ved en vedvarende 4-timers forringelse forsvinder findingen, efterhånden som 6-timers-medianen flytter sig. Et nyt case ca. hver 30. min |
| 11 | ACL blokerer én trafiktype | Tilføj en ACL, der dropper TCP/502 (eller 443) mellem agent og mål, men tillader ICMP. Konfigurer `BLUEEYE_PROBE_TARGETS=<mål>:502` og et ping-mål | Reachability-finding for TCP-målet og alarm. Ping-målet forbliver grønt. **Forventet:** ingen tekst, der peger på et filter. Refused (RST) og drop (timeout) ser ens ud i proben. `acl.denied` vises kun i Device Log og kun for Cisco `SEC-IPACCESSLOG` |
| 12 | Agent offline | a) `systemctl stop blueeye-agent`. b) Træk agentens netkabel. c) Bloker agentens uplink på switchen | Alle tre: agenten er `offline` inden for ca. 30–60 s (ping-timeout), `agent.offline` i audit, og "stale heartbeat" i Changes efter 15 min. **Forventet:** de tre tilfælde kan ikke skelnes. Ingen alarm. Troubleshooting-topologien markerer online naboer som `unreachable_downstream`. I tilfælde c) viser Device Log `link.down` for porten, men uden kobling til agentstatus |
| 13 | Samme fejl fra flere agenter | Mindst tre agenter på samme site prober samme mål. Bloker målet i en firewall | Én cluster under Situations inden for en 5-min-bucket (sweep hvert 60 s) og én cluster-alarm. NIS2-kladde, hvis CRIT og medium/high. **Forventet:** hver agent får også sin egen probe-alarm og sit eget event case (gaten er ikke koblet). Bloker to *forskellige* mål på samme site i samme vindue: de slås fejlagtigt sammen til én cluster |

Scenarie 2 (flapping), 5 (asymmetrisk routing), 6 (ECMP) og 10 (ny enhed) er markeret Ikke dækket, Kun
spec eller Kun UI. De har derfor ingen lab-test her.
