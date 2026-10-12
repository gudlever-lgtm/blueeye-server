'use strict';

// npm `version` lifecycle hook: stamps package.json's `releaseDate` with today's
// date (UTC, YYYY-MM-DD) whenever the version is bumped. Wired as the "version"
// script, it runs right after `npm version <patch|minor|major>` rewrites the
// version field — and before any commit — so the bump and the date land together
// in the same change (works with --no-git-tag-version too). This keeps the
// dashboard footer's "BlueEye server · v<version> · <release date>" truthful
// without a manual edit, in line with "the version field is the source of truth".
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

if (pkg.releaseDate === today) process.exit(0); // already current — nothing to do

if ('releaseDate' in pkg) {
  pkg.releaseDate = today;
} else {
  // First-time insert: keep releaseDate right after version for a tidy header.
  const rebuilt = {};
  for (const [k, v] of Object.entries(pkg)) {
    rebuilt[k] = v;
    if (k === 'version') rebuilt.releaseDate = today;
  }
  if (!('releaseDate' in rebuilt)) rebuilt.releaseDate = today;
  for (const k of Object.keys(pkg)) delete pkg[k];
  Object.assign(pkg, rebuilt);
}

fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
process.stdout.write(`release date stamped: ${today}\n`);
