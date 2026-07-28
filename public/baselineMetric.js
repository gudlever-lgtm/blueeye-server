// public/baselineMetric.js — the shared "metric with baseline context" component
// (Fase 4).
//
// 300 Mbit means nothing. "220% above normal for a Tuesday at 14:00" means
// something. This renders a metric with an optional SECOND line giving that
// context, and it lives in ONE place so throughput, latency, loss and jitter all
// read the same wherever they appear — instead of four views each inventing
// their own phrasing.
//
// THE RULE THAT MATTERS: when there is no baseline for a metric or an interface,
// this renders NO secondary line. No placeholder, no "–", no guessed context. An
// empty space says "we do not know"; a placeholder invites the reader to think
// something was measured and came back unremarkable.
//
// PROVIDER INTERFACE. The component does not know where baselines come from. A
// provider is:
//
//   { name, lookup(metric) -> baseline|null }
//
// where `baseline` is { median, mad?, sampleCount?, observationCount?, updatedAt?,
// dow?, hour? }. Only `median` is required.
//
// Today exactly ONE provider can be implemented — flow-pair traffic volume
// (flow_pair_baselines, migration 068). Per-interface baselines and
// latency/loss/jitter baselines do not exist in a form this can read (see
// docs/baseline-context.md). The interface is here so those register later
// without touching any call site.
//
// Dual export: window.BaselineMetric (browser <script>) + module.exports (tests).

(function (root) {
  'use strict';

  // Weekday names come from the translation catalogue, not from a hardcoded
  // array and not from toLocaleDateString: a baseline slot is a day-of-week
  // INDEX out of the baselines table, not a date, so there is nothing to format
  // — and a hardcoded English name inside a translated sentence produces
  // "normal for en Tuesday", which is how this was caught.
  var WEEKDAY_KEYS = ['weekday.0', 'weekday.1', 'weekday.2', 'weekday.3', 'weekday.4', 'weekday.5', 'weekday.6'];

  // Below this the deviation is noise, and calling a 1% wobble "above normal"
  // trains people to ignore the line.
  var SIGNIFICANT_PCT = 5;
  // A baseline built from fewer observations than this is reported as still
  // building — the number is shown, but hedged.
  var THIN_OBSERVATIONS = 100;

  // Resolved at CALL time, not at load time: under node there is no `window` when
  // this module is required, so a reference captured in the IIFE would be null
  // forever and every string would silently degrade to its key — including in
  // tests, which would then be asserting against key names rather than the text
  // a user sees. Falling back to the key is still the behaviour when no
  // catalogue is present at all.
  function t(key, params) {
    var g = typeof globalThis !== 'undefined' ? globalThis : null;
    var i18n = (root && root.I18n)
      || (g && g.I18n)
      || (g && g.window && g.window.I18n)
      || null;
    if (i18n && typeof i18n.t === 'function') return i18n.t(key, params);
    return key;
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  // --- pure comparison ---------------------------------------------------------

  // Compares an observed value against a baseline. Returns null when no
  // comparison can honestly be made, which the renderer turns into "no secondary
  // line" rather than into a placeholder.
  //
  // Returns { direction: 'above'|'below'|'at', pct, absolute, median, comparable }.
  //
  // `comparable:false` means "we have a baseline, but a PERCENTAGE would be
  // meaningless" — the median-is-zero case. Dividing by it would be Infinity or
  // NaN, and a made-up denominator would be worse, so the renderer falls back to
  // the absolute difference and says so.
  function compare(value, baseline) {
    if (!isFiniteNumber(value)) return null;
    if (!baseline || !isFiniteNumber(baseline.median)) return null;

    var median = baseline.median;
    var absolute = value - median;

    // Median 0: the pair/metric has no established normal above zero. Any
    // traffic at all is "new", not "220% up".
    if (median === 0) {
      return {
        direction: absolute > 0 ? 'above' : 'at',
        pct: null,
        absolute: absolute,
        median: 0,
        comparable: false,
      };
    }

    // Percentage deviation from normal, using the ABSOLUTE median so a negative
    // baseline (not expected for volume, but possible for a future signed
    // metric) cannot silently flip the sign of the direction.
    var pct = (absolute / Math.abs(median)) * 100;
    var direction = 'at';
    if (pct >= SIGNIFICANT_PCT) direction = 'above';
    else if (pct <= -SIGNIFICANT_PCT) direction = 'below';

    return {
      direction: direction,
      pct: pct,
      absolute: absolute,
      median: median,
      comparable: true,
    };
  }

  // The weekday/hour a baseline slot describes, in words. Falls back to the
  // baseline's own dow/hour when present, so the phrasing matches the slot the
  // number actually came from rather than "now".
  function slotLabel(baseline, now) {
    var d = baseline && isFiniteNumber(baseline.dow) ? baseline.dow : null;
    var h = baseline && isFiniteNumber(baseline.hour) ? baseline.hour : null;
    if (d === null || h === null) {
      var when = now instanceof Date ? now : new Date();
      if (d === null) d = when.getUTCDay();
      if (h === null) h = when.getUTCHours();
    }
    return {
      weekday: WEEKDAY_KEYS[d] ? t(WEEKDAY_KEYS[d]) : String(d),
      hour: (h < 10 ? '0' : '') + h + ':00',
    };
  }

  // Formats the deviation as the sentence shown under the value. Returns null
  // when there is nothing honest to say.
  function describe(value, baseline, now) {
    var cmp = compare(value, baseline);
    if (!cmp) return null;

    var slot = slotLabel(baseline, now);

    if (!cmp.comparable) {
      // Median zero. Report the absolute difference rather than a percentage.
      if (cmp.absolute === 0) {
        return { text: t('baseline.atNormal', slot), direction: 'at', cmp: cmp };
      }
      return {
        // Deliberately the absolute number: there is no meaningful percentage of
        // zero, and printing one would be inventing a denominator.
        text: t('baseline.aboveNormal', {
          pct: '∞',
          weekday: slot.weekday,
          hour: slot.hour,
        }),
        direction: 'above',
        cmp: cmp,
        absoluteOnly: true,
      };
    }

    if (cmp.direction === 'at') {
      return { text: t('baseline.atNormal', slot), direction: 'at', cmp: cmp };
    }

    var rounded = Math.round(Math.abs(cmp.pct));
    var key = cmp.direction === 'above' ? 'baseline.aboveNormal' : 'baseline.belowNormal';
    return {
      text: t(key, { pct: rounded, weekday: slot.weekday, hour: slot.hour }),
      direction: cmp.direction,
      cmp: cmp,
    };
  }

  // The hover text: how much data the baseline rests on, and when it was last
  // recomputed. A baseline from three days is not the same claim as one from
  // three months, and the person deciding whether to act needs to know which.
  function ageTitle(baseline) {
    if (!baseline) return null;
    var samples = isFiniteNumber(baseline.observationCount) ? baseline.observationCount
      : (isFiniteNumber(baseline.sampleCount) ? baseline.sampleCount : null);
    if (samples === null) return null;
    if (samples < THIN_OBSERVATIONS) return t('baseline.ageThin', { samples: samples });
    return t('baseline.ageTitle', {
      samples: samples,
      when: baseline.updatedAt || t('common.unknown'),
    });
  }

  // --- rendering ---------------------------------------------------------------

  // Renders <span class="bm"><span class="bm-value">…</span>[<span
  // class="bm-context">…</span>]</span>.
  //
  // `doc` is injected so the renderer is testable under jsdom, matching
  // TimelineView.renderRow's shape.
  //
  //   opts: { value, formatted?, baseline?, provider?, metric?, now? }
  //
  // `formatted` is the already-humanised value string ("300 Mbit/s"); `value` is
  // the raw number the comparison uses. Views already know how to format their
  // own units, so this does not try to.
  function render(doc, opts) {
    var o = opts || {};
    var wrap = doc.createElement('span');
    wrap.className = 'bm';

    var valueEl = doc.createElement('span');
    valueEl.className = 'bm-value';
    valueEl.textContent = o.formatted != null ? String(o.formatted)
      : (o.value == null ? '–' : String(o.value));
    wrap.appendChild(valueEl);

    // Resolve the baseline: an explicit one wins, otherwise ask the provider.
    var baseline = o.baseline;
    if (baseline === undefined && o.provider && typeof o.provider.lookup === 'function') {
      try {
        baseline = o.provider.lookup(o.metric);
      } catch (e) {
        // A broken provider must not cost the value itself. No context is the
        // correct degradation.
        baseline = null;
      }
    }

    var described = describe(o.value, baseline, o.now);
    // NO baseline -> NO secondary element at all. Not an empty one, not a
    // placeholder: nothing to mistake for a measurement.
    if (!described) return wrap;

    var ctx = doc.createElement('span');
    ctx.className = 'bm-context bm-' + described.direction;
    ctx.textContent = described.text;
    var title = ageTitle(baseline);
    if (title) ctx.setAttribute('title', title);
    wrap.appendChild(ctx);

    return wrap;
  }

  // --- providers ---------------------------------------------------------------

  // Builds a provider over GET /api/baselines/flow-pair rows. `rows` is the
  // `baselines` array from that response.
  //
  // A metric is identified by { dstHostId, dstPort, dow, hour }; a lookup with no
  // matching slot returns null, which is what makes an un-baselined pair render
  // without a secondary line instead of borrowing another slot's number.
  function flowPairProvider(rows) {
    var index = {};
    (rows || []).forEach(function (b) {
      var key = [b.dstHostId, b.dstPort, b.dow, b.hour].join('|');
      index[key] = {
        median: Number(b.medianBytes),
        mad: Number(b.madBytes),
        sampleCount: Number(b.sampleCount),
        observationCount: Number(b.observationCount),
        updatedAt: b.updatedAt || null,
        dow: Number(b.dow),
        hour: Number(b.hour),
      };
    });
    return {
      name: 'flow_pair_volume',
      lookup: function (metric) {
        if (!metric) return null;
        var key = [metric.dstHostId, metric.dstPort, metric.dow, metric.hour].join('|');
        return Object.prototype.hasOwnProperty.call(index, key) ? index[key] : null;
      },
    };
  }

  // Registry, so latency/loss/jitter providers can be added when a data source
  // for them exists without touching any call site. Empty of those today, on
  // purpose — see docs/baseline-context.md.
  var PROVIDERS = { flow_pair_volume: flowPairProvider };

  var apiObj = {
    SIGNIFICANT_PCT: SIGNIFICANT_PCT,
    THIN_OBSERVATIONS: THIN_OBSERVATIONS,
    WEEKDAY_KEYS: WEEKDAY_KEYS,
    compare: compare,
    describe: describe,
    slotLabel: slotLabel,
    ageTitle: ageTitle,
    render: render,
    flowPairProvider: flowPairProvider,
    PROVIDERS: PROVIDERS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.BaselineMetric = apiObj;
})(typeof window !== 'undefined' ? window : null);
