// public/eventTitle.js — what an event's stored title should read as in a LIST
// that already has columns for the parts it repeats. Pure, no DOM, so it is
// unit-testable under `node --test` (the dashboard has no build step).
//
// Dual export: `window.EventTitle` in the browser (plain <script> before
// app.js), `module.exports` under Node (tests).
//
// The server stores a self-contained title — `${SEV} ${metric} on ${device
// (site)}` from eventCases/eventCaseService.js — and that is CORRECT for the
// places it stands alone: the detail-page heading, an ITSM ticket subject, an
// alert body. It is only redundant in the events table, where severity, device
// and location are each already their own column, so a row read:
//
//   CRIT | Open | CRIT probe.latency on Localhost agent test (gnf-server-agent)
//        | Localhost agent test #1 | gnf-server-agent | …
//
// Three of five columns saying the same thing, and the one piece of information
// unique to the title — `probe.latency` — buried in the middle of it.
//
// So this trims for DISPLAY only; nothing rewrites the stored title.

(function (root) {
  'use strict';

  var SEVERITY_ALIASES = { CRITICAL: 'CRIT', WARNING: 'WARN' };

  function normaliseSeverity(word) {
    var w = String(word == null ? '' : word).toUpperCase();
    return SEVERITY_ALIASES[w] || w;
  }

  // Drop a leading severity token, but ONLY when it matches the row's own
  // severity — the badge beside it is then saying the same word. A title that
  // opens with a different severity is describing something else and is left
  // alone.
  function stripSeverity(title, severity) {
    var m = /^\s*(CRIT|CRITICAL|WARN|WARNING|INFO)\b[\s:—-]*/i.exec(title);
    if (!m) return title;
    if (normaliseSeverity(m[1]) !== normaliseSeverity(severity)) return title;
    var rest = title.slice(m[0].length);
    return rest.trim() ? rest : title;
  }

  // Drop a trailing " on <device label>" — but only when the tail is EXACTLY
  // the label this row's device column is showing. Matching loosely (any " on
  // …") would eat a metric that legitimately contains it, and matching a stale
  // label would silently hide that the agent has since been renamed: in both
  // cases keeping the full title is the safe answer.
  function stripDevice(title, deviceLabel) {
    if (!deviceLabel) return title;
    var suffix = ' on ' + deviceLabel;
    if (title.length <= suffix.length) return title;
    if (title.slice(-suffix.length) !== suffix) return title;
    var rest = title.slice(0, title.length - suffix.length);
    return rest.trim() ? rest : title;
  }

  // The condition alone — what the title says that the columns do not.
  // `deviceLabel` is what the device/location columns render for this same row
  // (formatDeviceLabel's "name (site)"). Returns the full title unchanged
  // whenever the pattern does not match, so an unrecognised or hand-edited
  // title is never mangled into nonsense.
  function conditionOf(title, severity, deviceLabel) {
    var t = String(title == null ? '' : title);
    if (!t) return '';
    var out = stripDevice(stripSeverity(t, severity), deviceLabel).trim();
    // Nothing left, or nothing left but the device tail itself ("on core-sw" —
    // a title that carried no condition to begin with). Either way the trimmed
    // form is a fragment, not a shorter truth: show the title as stored.
    if (!out) return t.trim();
    if (deviceLabel && out.toLowerCase() === ('on ' + deviceLabel).toLowerCase()) return t.trim();
    return out;
  }

  var apiObj = {
    conditionOf: conditionOf,
    stripSeverity: stripSeverity,
    stripDevice: stripDevice,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = apiObj;
  if (root) root.EventTitle = apiObj;
})(typeof window !== 'undefined' ? window : null);
