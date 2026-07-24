'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildHostResolver } = require('../src/topology/hostResolver');
const { aggregateServiceDependencies } = require('../src/topology/serviceDependencyAggregator');

// Three monitored hosts: agent 1 (own IP 10.0.0.1), agent 2 (own IP 10.0.0.2,
// plus a second NIC 10.0.0.22), agent 3 = an SNMP-monitored device at 10.0.0.3.
const AGENTS = [
  { id: 1, capabilities: { ips: ['10.0.0.1'] } },
  { id: 2, capabilities: { ips: ['10.0.0.2', '10.0.0.22'] } },
  { id: 3, monitor_config: { source: 'snmp', snmp: { host: '10.0.0.3' } } },
];

test('buildHostResolver maps agent IPs and SNMP device IPs to host ids', () => {
  const r = buildHostResolver(AGENTS);
  assert.equal(r.resolve('10.0.0.1'), 1);
  assert.equal(r.resolve('10.0.0.2'), 2);
  assert.equal(r.resolve('10.0.0.22'), 2);
  assert.equal(r.resolve('10.0.0.3'), 3); // SNMP device
  assert.equal(r.resolve('8.8.8.8'), null); // unknown / external
  assert.equal(r.resolve(undefined), null);
});

test('aggregator builds host↔host edges, folding multiple IPs of one host', () => {
  const r = buildHostResolver(AGENTS);
  const flows = [
    { srcIp: '10.0.0.1', dstIp: '10.0.0.2', dstPort: 443, bytes: 1000, packets: 8, connCount: 3, firstSeen: new Date('2026-07-24T10:00:00Z'), lastSeen: new Date('2026-07-24T10:05:00Z') },
    // Same edge via agent 2's OTHER ip — must fold into the 1→2:443 edge.
    { srcIp: '10.0.0.1', dstIp: '10.0.0.22', dstPort: 443, bytes: 500, packets: 4, connCount: 2, firstSeen: new Date('2026-07-24T09:55:00Z'), lastSeen: new Date('2026-07-24T10:10:00Z') },
    { srcIp: '10.0.0.1', dstIp: '10.0.0.3', dstPort: 22, bytes: 200, packets: 2, connCount: 1, firstSeen: new Date('2026-07-24T10:01:00Z'), lastSeen: new Date('2026-07-24T10:02:00Z') },
  ];
  const { edges, stats } = aggregateServiceDependencies(flows, r, { topN: 50 });

  const https = edges.find((e) => e.srcHostId === 1 && e.dstHostId === 2 && e.dstPort === 443);
  assert.ok(https, 'folded 1→2:443 edge exists');
  assert.equal(https.bytes, 1500); // 1000 + 500
  assert.equal(https.packets, 12);
  assert.equal(https.connCount, 5);
  assert.equal(https.proto, 'tcp');
  // first_seen = earliest observation, last_seen = latest.
  assert.equal(https.firstSeen.toISOString(), '2026-07-24T09:55:00.000Z');
  assert.equal(https.lastSeen.toISOString(), '2026-07-24T10:10:00.000Z');

  assert.ok(edges.find((e) => e.srcHostId === 1 && e.dstHostId === 3 && e.dstPort === 22));
  assert.equal(edges.length, 2);
  assert.equal(stats.droppedUnknown, 0);
});

test('unknown-endpoint edges are dropped (either side not a monitored host)', () => {
  const r = buildHostResolver(AGENTS);
  const flows = [
    { srcIp: '10.0.0.1', dstIp: '8.8.8.8', dstPort: 443, bytes: 999, packets: 9, connCount: 1 }, // dst unknown
    { srcIp: '203.0.113.7', dstIp: '10.0.0.2', dstPort: 443, bytes: 999, packets: 9, connCount: 1 }, // src unknown
    { srcIp: '10.0.0.1', dstIp: '10.0.0.2', dstPort: 443, bytes: 10, packets: 1, connCount: 1 }, // both known -> kept
  ];
  const { edges, stats } = aggregateServiceDependencies(flows, r, { topN: 50 });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].srcHostId, 1);
  assert.equal(edges[0].dstHostId, 2);
  assert.equal(stats.droppedUnknown, 2);
});

test('self-edges (same host on both ends) are dropped', () => {
  const r = buildHostResolver(AGENTS);
  // 10.0.0.2 and 10.0.0.22 both belong to host 2.
  const flows = [{ srcIp: '10.0.0.2', dstIp: '10.0.0.22', dstPort: 443, bytes: 5, packets: 1, connCount: 1 }];
  const { edges, stats } = aggregateServiceDependencies(flows, r, { topN: 50 });
  assert.equal(edges.length, 0);
  assert.equal(stats.droppedSelf, 1);
});

test('Top-N truncation works per source host (heaviest edges kept)', () => {
  // Host 1 talks to 5 distinct services on host 2; keep the top 2 by bytes.
  const agents = [
    { id: 1, capabilities: { ips: ['10.0.0.1'] } },
    { id: 2, capabilities: { ips: ['10.0.0.2'] } },
  ];
  const r = buildHostResolver(agents);
  const flows = [80, 443, 5432, 6379, 9200].map((port, i) => ({
    srcIp: '10.0.0.1', dstIp: '10.0.0.2', dstPort: port,
    bytes: (i + 1) * 100, packets: 1, connCount: 1,
  }));
  const { edges, stats } = aggregateServiceDependencies(flows, r, { topN: 2 });
  assert.equal(edges.length, 2);
  const ports = edges.map((e) => e.dstPort).sort((a, b) => a - b);
  assert.deepEqual(ports, [6379, 9200]); // the two heaviest (bytes 400, 500)
  assert.equal(stats.truncated, 3);
});

test('Top-N is per source host, not global', () => {
  const agents = [
    { id: 1, capabilities: { ips: ['10.0.0.1'] } },
    { id: 2, capabilities: { ips: ['10.0.0.2'] } },
    { id: 3, capabilities: { ips: ['10.0.0.3'] } },
  ];
  const r = buildHostResolver(agents);
  const flows = [
    { srcIp: '10.0.0.1', dstIp: '10.0.0.2', dstPort: 443, bytes: 100, packets: 1, connCount: 1 },
    { srcIp: '10.0.0.1', dstIp: '10.0.0.3', dstPort: 443, bytes: 90, packets: 1, connCount: 1 },
    { srcIp: '10.0.0.2', dstIp: '10.0.0.3', dstPort: 443, bytes: 80, packets: 1, connCount: 1 },
  ];
  // topN=1 per host: host1 keeps its heaviest (1→2), host2 keeps its only (2→3).
  const { edges } = aggregateServiceDependencies(flows, r, { topN: 1 });
  assert.equal(edges.length, 2);
  assert.ok(edges.find((e) => e.srcHostId === 1 && e.dstHostId === 2));
  assert.ok(edges.find((e) => e.srcHostId === 2 && e.dstHostId === 3));
});
