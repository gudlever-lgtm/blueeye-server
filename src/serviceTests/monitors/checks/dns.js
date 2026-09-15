'use strict';

const { numOrNull } = require('../../storage/shape');
const { createResolver } = require('../dnsResolve');
const { DNS_PRESETS } = require('../types');
const { ok, failed, unreachable, misconfigured, KIND } = require('../result');

// "Is the record still there, and does it still say what it said?"
//
// This is the cheapest useful check in the module and it catches the failure
// nobody sees coming: somebody edits DNS for an unrelated reason, the SPF record
// loses an `include:`, and mail starts landing in spam a day later with nothing
// in any log to explain it. Same for a DMARC policy that quietly goes back to
// `p=none`, an MX that points at a decommissioned host, or a DKIM selector that
// disappears when a mail provider is swapped.
//
// The presets exist so the operator does not have to know that DMARC is a TXT
// record at `_dmarc.<domain>`. That knowledge belongs in software.

// Resolves a preset into the concrete question to ask. Returns null when the
// configuration cannot form one — a DKIM check with no selector, say — which is
// a misconfiguration and not a missing record.
function question(cfg) {
  const preset = DNS_PRESETS[cfg.preset] || DNS_PRESETS.custom;
  if (cfg.preset === 'dkim' && !cfg.selector) return null;
  const name = typeof preset.name === 'function' ? preset.name(cfg) : null;
  const record = preset.record || cfg.record || null;
  if (!name || !record) return null;
  return {
    name,
    record: String(record).toUpperCase(),
    // The preset's own marker ('v=DMARC1') is always required; anything the
    // operator adds is required on top of it, never instead of it.
    contains: [preset.contains, cfg.expect_contains].filter(Boolean),
    absent: cfg.expect_absent ? [cfg.expect_absent] : [],
    // numOrNull, not Number(): `Number(null)` and `Number('')` are both 0, and
    // "no minimum given" would then mean "zero answers will do" — which is the
    // one value that makes the check pass on a record that is gone.
    minAnswers: numOrNull(cfg.min_answers) === null ? 1 : Math.max(1, numOrNull(cfg.min_answers)),
  };
}

const hasText = (answers, needle) => answers.some((a) => a.toLowerCase().includes(String(needle).toLowerCase()));

function createDnsCheck({ resolver = null, now = () => Date.now() } = {}) {
  const dns = resolver || createResolver({ now });

  async function check(monitor) {
    const cfg = monitor.config || {};
    const q = question(cfg);
    if (!q) {
      return misconfigured({ summary: 'The monitor does not say which record to look up (a DKIM check needs a selector; a custom one needs a name and a type).' });
    }

    const asked = now();
    let answer;
    try {
      answer = await dns.resolve(q.name, q.record, { server: cfg.resolver || null, timeoutMs: cfg.timeout_ms || 5000 });
    } catch (err) {
      return unreachable({
        summary: `DNS did not answer for ${q.name} (${(err && err.code) || 'no code'}).`,
        error: (err && err.message) || String(err),
        // Even a lookup that failed took time, and how long it took before it
        // gave up is the difference between "that resolver is gone" and "that
        // resolver is slow enough to be gone".
        timings: { query: Math.max(0, now() - asked) },
        detail: { name: q.name, record: q.record, resolver: cfg.resolver || null },
      });
    }
    const timings = { query: answer.ms };

    const detail = {
      name: q.name,
      record: q.record,
      resolver: cfg.resolver || null,
      answers: answer.answers.slice(0, 20),
      expected_contains: q.contains,
      expected_absent: q.absent,
    };

    if (answer.answers.length < q.minAnswers) {
      return failed(KIND.DNS_RECORD_MISSING, {
        summary: answer.answers.length === 0
          ? `No ${q.record} record at ${q.name}.`
          : `Only ${answer.answers.length} ${q.record} record(s) at ${q.name}, expected at least ${q.minAnswers}.`,
        value: answer.answers.length,
        unit: 'count',
        durationMs: answer.ms,
        timings,
        detail,
      });
    }

    for (const needle of q.contains) {
      if (!hasText(answer.answers, needle)) {
        return failed(KIND.DNS_RECORD_MISMATCH, {
          summary: `The ${q.record} record at ${q.name} no longer contains "${needle}".`,
          durationMs: answer.ms,
          timings,
          detail,
        });
      }
    }
    for (const needle of q.absent) {
      if (hasText(answer.answers, needle)) {
        return failed(KIND.DNS_UNEXPECTED_RECORD, {
          summary: `The ${q.record} record at ${q.name} contains "${needle}", which this monitor requires it not to.`,
          durationMs: answer.ms,
          timings,
          detail,
        });
      }
    }

    return ok({
      summary: `${q.record} at ${q.name}: ${answer.answers.length} record(s), as expected.`,
      value: answer.ms,
      unit: 'ms',
      durationMs: answer.ms,
      timings,
      detail,
    });
  }

  return { check };
}

module.exports = { createDnsCheck };
