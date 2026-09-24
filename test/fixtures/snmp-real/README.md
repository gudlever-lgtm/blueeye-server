# Real-shaped SNMP payloads

The bodies a blueeye-agent POSTs to `/agents/me/snmp-topology` and
`/agents/me/snmp-counters`, produced by the agent's own code over recordings of
real switches. Used by [`test/snmpRealPayloads.test.js`](../../snmpRealPayloads.test.js).

| File | Switch |
| --- | --- |
| `hpe-procurve-516733-b21.*.json` | HPE ProCurve 6120XG blade switch (Z.14.31): 42 ports, Q-BRIDGE FDB, LLDP + CDP, 8 VLANs |
| `cisco-c3750.*.json` | Cisco Catalyst 3750: 19 ports, BRIDGE-MIB (dot1d) FDB where bridge port ≠ ifIndex, 125 CDP neighbours |

**How they were made (2026-09-24).** The recordings are
[snmpsim-data](https://github.com/lextudio/snmpsim-data) (BSD 2-Clause, © Ilya
Etingof), trimmed to the columns the agent reads; they live in blueeye-agent as
`test/fixtures/snmprec/`. The agent's `pollSnmpTopology` (collect
`if, fdb, lldp, vlan, cdp`) and `pollSnmpCounters` were run over them through
`test-support/snmprec.js` — a net-snmp-shaped session over the recording, which
was checked to give byte-identical varbinds to the real `net-snmp` module
walking the same recordings served by snmpsim 1.2.2. Device id is `1`, host
`192.0.2.50`; `readAt` is `2026-09-24T02:00:00.000Z` (the test re-stamps it).

**Regenerate** from blueeye-agent after an agent payload change (the snippet
is in blueeye-agent `test/fixtures/snmprec/README.md`).

**What they caught.** The ProCurve names two interfaces `lo0` (ifIndex 4170 and
4179), and ports are keyed by name, so one of them is lost — pinned as a known
gap in the test. The Catalyst's `Gi1/0/9` has 257 487 775 630 445 input octets
(above 2^47): the agent read that 7-byte Counter64 as 1 005 811 623 556 before
the fix in its `src/snmp/session.js` `toNumber`.
