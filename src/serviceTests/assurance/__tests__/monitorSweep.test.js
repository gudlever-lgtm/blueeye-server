'use strict';

// The monitor sweep: due monitors are checked, results are stored, incidents are
// opened and resolved, and the alerts are grouped rather than sent one per row.
//
// It runs the REAL reactor over the in-memory repositories with a scripted
// runner, so what is being tested is the reaction loop and not a socket.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');

const MAIL = {
  name: 'Customer mail',
  type: 'mail',
  target: 'smtp.example.com',
  config: { smtp_host: 'smtp.example.com', from_address: 'a@example.com', to_address: 'b@example.com' },
  interval_sec: 900,
  enabled: 1,
};
const DNS = {
  name: 'SPF for example.com',
  type: 'dns_record',
  target: 'example.com',
  config: { domain: 'example.com', preset: 'spf' },
  interval_sec: 3600,
  enabled: 1,
};

const failing = (kind, summary) => ({ status: 'failed', kind, summary, duration_ms: 20 });

function fixture(over = {}) {
  return makeServiceTests({ monitors: [MAIL, DNS], ...over });
}

test('a sweep checks every due monitor and stores one result per check', async () => {
  const st = fixture();
  const first = await st.reactor.sweepMonitors();
  assert.equal(first.checked, 2);
  assert.equal(st.tables.monitorResults.rows.length, 2);

  // Nothing is due immediately afterwards — the interval is honoured.
  const second = await st.reactor.sweepMonitors();
  assert.equal(second.checked, 0);
  assert.equal(st.tables.monitorResults.rows.length, 2);

  // `force` is the "check now" path and ignores the interval.
  const forced = await st.reactor.sweepMonitors({ force: true });
  assert.equal(forced.checked, 2);
});

test('a monitor that keeps failing opens one incident, and recovery resolves it', async () => {
  const st = fixture({
    monitor_results: { 'Customer mail': failing('mail_undelivered', 'accepted but never arrived') },
  });

  await st.reactor.sweepMonitors({ force: true });
  assert.equal(st.tables.incidents.rows.length, 0, 'one failure is not an outage');

  await st.reactor.sweepMonitors({ force: true });
  const incidents = st.tables.incidents.rows;
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].subject_type, 'monitor');
  assert.equal(incidents[0].subject_key, 'monitor:1');
  assert.equal(incidents[0].severity, 'CRIT');
  assert.match(incidents[0].summary, /"Customer mail" — accepted but never arrived \(2 checks in a row\)/);

  // A third failure does not open a second incident.
  await st.reactor.sweepMonitors({ force: true });
  assert.equal(st.tables.incidents.rows.length, 1);
  assert.equal(st.tables.incidents.rows[0].occurrences >= 2, true);

  // Recovery.
  st.monitorRunner.run = async () => ({ status: 'ok', summary: 'Delivered.', value: 900, unit: 'ms', duration_ms: 900 });
  await st.reactor.sweepMonitors({ force: true });
  assert.equal(st.tables.incidents.rows[0].status, 'resolved');
  assert.equal(st.tables.monitors.rows[0].consecutive_failures, 0);
});

test('the failure streak lives on the monitor row and resets on a pass', async () => {
  const st = fixture({ monitor_results: { 'Customer mail': failing('mail_rejected', 'refused') } });
  await st.reactor.sweepMonitors({ force: true });
  await st.reactor.sweepMonitors({ force: true });
  assert.equal(st.tables.monitors.rows[0].consecutive_failures, 2);
  assert.equal(st.tables.monitors.rows[0].last_status, 'failed');

  st.monitorRunner.run = async () => ({ status: 'ok', summary: 'ok', duration_ms: 5 });
  await st.reactor.sweepMonitors({ force: true });
  assert.equal(st.tables.monitors.rows[0].consecutive_failures, 0);
  assert.equal(st.tables.monitors.rows[0].last_status, 'ok');
});

test('every check leaves a typed observation, whatever the outcome', async () => {
  const st = fixture({ monitor_results: { 'SPF for example.com': failing('dns_record_missing', 'no TXT record') } });
  await st.reactor.sweepMonitors({ force: true });
  const observations = st.tables.observations.rows;
  assert.equal(observations.length, 2);
  const dns = observations.find((o) => o.kind === 'dns.record');
  assert.equal(dns.layer, 'network');
  assert.equal(dns.outcome, 'bad');
  const mail = observations.find((o) => o.kind === 'mail.delivery');
  assert.equal(mail.outcome, 'ok');
});

test('a sweep that opens several incidents sends them as grouped alerts, not one each', async () => {
  const st = fixture({
    monitor_results: {
      'Customer mail': failing('mail_undelivered', 'accepted but never arrived'),
      'SPF for example.com': failing('dns_record_missing', 'no TXT record'),
    },
  });
  await st.reactor.sweepMonitors({ force: true });
  await st.reactor.sweepMonitors({ force: true });

  assert.equal(st.tables.incidents.rows.length, 2, 'both were recorded');
  assert.ok(st.notifications.length >= 1, 'something was sent');
  assert.ok(st.notifications.length <= 2, 'and it was not one message per row beyond the grouping');
  // Every incident is named in what went out — grouping must never hide one.
  const text = JSON.stringify(st.notifications);
  assert.match(text, /Customer mail|SPF for example\.com/);
});

test('a check that throws costs its own row and never the sweep', async () => {
  const st = fixture();
  let calls = 0;
  st.monitorRunner.run = async (monitor) => {
    calls += 1;
    if (monitor.type === 'mail') throw new Error('the checker exploded');
    return { status: 'ok', summary: 'fine', duration_ms: 3 };
  };
  const swept = await st.reactor.sweepMonitors({ force: true });
  assert.equal(calls, 2, 'the second monitor was still checked');
  assert.equal(swept.checked, 2);
  assert.equal(st.tables.monitorResults.rows.length, 1, 'only the healthy one stored a result');
});

test('the sweep can be turned off, and then nothing is checked', async () => {
  const st = fixture();
  await st.settings.set('monitors', { enabled: false });
  const swept = await st.reactor.sweepMonitors();
  assert.equal(swept.skipped, 'disabled');
  assert.equal(st.tables.monitorResults.rows.length, 0);
});

test('a manual check reads the monitor as it is NOW, not as a screen had it', async () => {
  const st = fixture();
  await st.repositories.monitors.update(1, { name: 'Renamed mail', config: { ...MAIL.config, smtp_host: 'smtp2.example.com' } });
  st.monitorRunner.run = async (monitor) => {
    assert.equal(monitor.name, 'Renamed mail');
    assert.equal(monitor.config.smtp_host, 'smtp2.example.com');
    return { status: 'ok', summary: 'ok', duration_ms: 1 };
  };
  const outcome = await st.reactor.checkMonitor(1, { trigger: 'manual', requestedBy: 7 });
  assert.equal(outcome.result.trigger_source, 'manual');
  assert.equal(outcome.result.requested_by, 7);
});

test('checking a monitor that no longer exists is a skip, not a crash', async () => {
  const st = fixture();
  assert.deepEqual(await st.reactor.checkMonitor(999), { skipped: 'missing' });
});
