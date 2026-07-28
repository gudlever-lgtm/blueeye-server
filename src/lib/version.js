'use strict';

// Version comparison for "is an update available?" checks.
//
// Deliberately identical in behaviour to the dashboard's compareVersions in
// public/app.js (which flags out-of-date agents): only the numeric release core
// is compared, any pre-release/build suffix is ignored. Keeping the two in step
// means the server and the UI never disagree about what "behind" means.
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isValidVersion(value) {
  return typeof value === 'string' && VERSION_RE.test(value.trim());
}

// -1 / 0 / 1 — a before b, equal, a after b.
function compareVersions(a, b) {
  const parse = (s) => String(s).split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// True only when `candidate` is STRICTLY newer than `current`, and both are
// usable versions. Anything unparseable is "no update" — a malformed version
// must never produce a phantom "update available" badge.
function isNewer(candidate, current) {
  if (!isValidVersion(candidate) || !isValidVersion(current)) return false;
  return compareVersions(candidate, current) > 0;
}

module.exports = { isValidVersion, compareVersions, isNewer, VERSION_RE };
