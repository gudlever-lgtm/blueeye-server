'use strict';

const { renderRegisterHtml } = require('../nis2/report');
const { createT } = require('../nis2/i18n');

// The executive network report: "fix these specific issues at these specific
// locations".
//
// WHY IT REUSES THE NIS2 PIPELINE. That module already solves the parts that
// are tedious and easy to get subtly wrong — print-ready chrome, a per-request
// locale (two people can pull a report in two languages at once, so the
// catalogue is a parameter rather than module state), and a section shape the
// renderer understands. A second report engine would mean a second set of those
// decisions, drifting.
//
// WHAT IT DELIBERATELY DOES NOT DO: call a model. Every number here is computed
// by the server and every sentence is assembled from those numbers. A report
// that a manager forwards to an engineer has to be defensible line by line, and
// "the assistant said so" is not that. The AI on the Analysis screen is for
// interpretation at the desk; this is the record.

// How many places and issues the report names. An executive report that lists
// forty sites is a spreadsheet — it is read as "everything is broken", which is
// the same as saying nothing. Ten is a morning's work.
const MAX_PLACES = 10;
const MAX_ISSUES_PER_PLACE = 5;

// A place is worth naming when it has a critical, or enough warnings that it is
// not noise. Below this it goes into the tail count rather than the table.
const MIN_WARN_TO_NAME = 5;

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

// Worst first: criticals, then warnings, then volume. A place with one critical
// outranks a place with four hundred warnings, because that is the order
// somebody works in.
function worstFirst(a, b) {
  return (b.crit - a.crit) || (b.warn - a.warn) || (b.count - a.count);
}

// Turns the aggregate the server already computes into the report's structure.
// Pure: no database, no clock beyond what is passed in, no I/O — so the numbers
// in a report can be reproduced from the same summary.
function buildNetworkReport({
  summary,
  trend = [],
  hostName = (id) => String(id),
  locationOf = () => null,
  periodDays = 30,
  locale,
  now = new Date(),
} = {}) {
  const t = createT(locale);
  const s = summary || {};
  const bySev = s.bySeverity || {};
  const hosts = (s.byHost || []).slice().sort(worstFirst);

  const named = hosts
    .filter((h) => h.crit > 0 || h.warn >= MIN_WARN_TO_NAME)
    .slice(0, MAX_PLACES);
  const tail = hosts.length - named.length;

  // Is it getting better? First half of the period against the second, which is
  // the comparison somebody makes by eye anyway. Fewer than four buckets is not
  // a trend, it is two numbers, and saying so is better than drawing a line
  // through them.
  let direction = 'flat';
  let changePct = 0;
  if (trend.length >= 4) {
    const half = Math.floor(trend.length / 2);
    const sum = (list) => list.reduce((n, p) => n + (p.count || 0), 0);
    const before = sum(trend.slice(0, half));
    const after = sum(trend.slice(half));
    if (before > 0) {
      changePct = Math.round(((after - before) / before) * 100);
      if (changePct >= 15) direction = 'worse';
      else if (changePct <= -15) direction = 'better';
    } else if (after > 0) {
      direction = 'worse';
      changePct = 100;
    }
  } else {
    direction = 'unknown';
  }

  const places = named.map((h) => ({
    host: hostName(h.hostId),
    location: locationOf(h.hostId),
    crit: h.crit,
    warn: h.warn,
    total: h.count,
    unacknowledged: h.count - (h.acked || 0),
    lastAt: h.lastAt,
    issues: (h.topMetrics || []).slice(0, MAX_ISSUES_PER_PLACE).map((m) => ({
      metric: m.metric, count: m.count, crit: m.crit,
    })),
  }));

  return {
    locale: t.locale,
    title: t('net.title'),
    generatedAt: now instanceof Date ? now.toISOString() : String(now),
    periodDays,
    totals: {
      findings: s.total || 0,
      unacknowledged: s.unacked || 0,
      crit: bySev.CRIT || 0,
      warn: bySev.WARN || 0,
      info: bySev.INFO || 0,
      places: hosts.length,
      placesNamed: named.length,
      placesNotNamed: tail < 0 ? 0 : tail,
      critShare: pct(bySev.CRIT || 0, s.total || 0),
    },
    direction,
    changePct,
    places,
    topIssues: (s.byMetric || []).slice(0, MAX_ISSUES_PER_PLACE).map((m) => ({
      metric: m.metric, count: m.count, share: pct(m.count, s.total || 0),
    })),
  };
}

// The one paragraph somebody actually reads. Assembled from the numbers above,
// which is why it can be trusted: there is no sentence here that is not a
// restatement of a count.
function conclusion(report, t) {
  const { totals, places, direction, changePct } = report;
  if (!totals.findings) return t('net.concl.clean');

  const worst = places[0];
  const trendLine = direction === 'better' ? t('net.trend.better', { pct: Math.abs(changePct) })
    : direction === 'worse' ? t('net.trend.worse', { pct: Math.abs(changePct) })
      : direction === 'flat' ? t('net.trend.flat')
        : t('net.trend.unknown');

  if (!worst) {
    // Findings exist but none clear the bar for naming a place — a wide, thin
    // spread. Saying that is more useful than naming an arbitrary host.
    return `${t('net.concl.spread', { n: totals.findings, places: totals.places })} ${trendLine}`;
  }
  return `${t('net.concl.focus', {
    place: worst.host,
    issue: worst.issues.length ? worst.issues[0].metric : t('net.issue.unknown'),
    crit: totals.crit,
    n: totals.placesNamed,
  })} ${trendLine}`;
}

// Renders to the same print-ready document the NIS2 reports use.
function renderNetworkReportHtml(report, { org, locale } = {}) {
  const t = createT(locale || report.locale);
  const dash = '—';

  const sections = [
    {
      heading: t('net.sec.conclusion'),
      intro: conclusion(report, t),
      headers: [t('net.col.measure'), t('net.col.value')],
      rows: [
        [t('net.m.period'), t('net.m.periodDays', { days: report.periodDays })],
        [t('net.m.findings'), String(report.totals.findings)],
        [t('net.m.unack'), String(report.totals.unacknowledged)],
        [t('net.m.crit'), `${report.totals.crit} (${report.totals.critShare}%)`],
        [t('net.m.warn'), String(report.totals.warn)],
        [t('net.m.places'), String(report.totals.places)],
      ],
    },
    {
      heading: t('net.sec.where'),
      intro: report.totals.placesNotNamed
        ? t('net.where.intro', { n: report.places.length, rest: report.totals.placesNotNamed })
        : t('net.where.introAll', { n: report.places.length }),
      headers: [
        t('net.col.place'), t('net.col.location'), t('net.col.crit'),
        t('net.col.warn'), t('net.col.issues'), t('net.col.last'),
      ],
      rows: report.places.length
        ? report.places.map((p) => [
          p.host,
          p.location || dash,
          String(p.crit),
          String(p.warn),
          // The ISSUES, not a count: this column is the instruction.
          p.issues.map((i) => `${i.metric} (${i.count})`).join(', ') || dash,
          p.lastAt ? new Date(p.lastAt).toLocaleString(t.htmlLang) : dash,
        ])
        : [[t('net.where.none'), dash, dash, dash, dash, dash]],
    },
    {
      heading: t('net.sec.what'),
      intro: t('net.what.intro'),
      headers: [t('net.col.issue'), t('net.col.count'), t('net.col.share')],
      rows: report.topIssues.length
        ? report.topIssues.map((i) => [i.metric, String(i.count), `${i.share}%`])
        : [[t('net.where.none'), dash, dash]],
    },
  ];

  return renderRegisterHtml(report.title, sections, { org, locale: t.locale });
}

module.exports = {
  buildNetworkReport, renderNetworkReportHtml, conclusion,
  MAX_PLACES, MAX_ISSUES_PER_PLACE, MIN_WARN_TO_NAME,
};
