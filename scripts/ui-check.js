#!/usr/bin/env node
'use strict';

// scripts/ui-check.js — the UI contract, enforced.
//
//   npm run ui:check
//
// Reports `file:line:rule  message` and exits 1 on any finding. It is a lint,
// not a test: it reads the source rather than rendering it, so it catches the
// class of regression that is invisible until somebody opens the page in a
// theme nobody tested.
//
// The rules are the contract's "forbidden after migration" list
// (docs/ui-contract.md):
//
//   inline-style     style=" in a view
//   colour           a hex/rgb literal outside tokens.css — IN ANY STYLESHEET,
//                    contract or not, and in any migrated view
//   px-size          a raw px spacing or font-size outside the token files
//   legacy-class     a class the contract replaced, still in use
//   tab-pattern      buttons used as tabs
//   chip-metadata    a chip carrying metadata or a host name
//   primary-count    more than one primary button in a PageHeader
//   template         a migrated view that uses none of the four templates
//
// MIGRATED is the list of files the contract already covers. It only grows:
// phase 3 adds a screen to it in the same commit that migrates the screen, so
// the sweep tightens one screen at a time instead of being switched off while
// the work is in flight. Nothing here is ever loosened to make a finding go
// away — a finding is either fixed or the file is not migrated yet.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const CSS_DIR = path.join(PUBLIC, 'css');

// The one file colour is allowed in, and the one file the scale is defined in.
const TOKEN_FILES = new Set(['css/tokens.css']);
// Sheets the contract owns outright: no colour, no raw sizes.
const CONTRACT_CSS = new Set(['css/base.css', 'css/components.css']);

// Files that build their UI from the contract's components. Phase 3 appends to
// this as each screen is migrated; nothing is ever removed.
const MIGRATED = [
  'ui.js',
  'uiPreview.js',
  'kitchenSink.js',
  // Phase 3, in the order docs/ui-contract.md sets out.
  'views/changes.js',
  'views/probes.js',
  'views/analysis.js',
  'views/fleet.js',
  'views/sites.js',
  'views/traffic.js',
  'views/destinations.js',
  'views/topologyDelta.js',
  'views/investigate.js',
  'views/diagnose.js',
  'views/troubleshooting.js',
  'views/topology.js',
  'views/flows.js',
  'views/transactions.js',
  'views/serviceAssurance.js',
];

// Classes the contract replaced. A migrated file may not use them.
// value = what to use instead.
const LEGACY_CLASSES = {
  hero: 'PageHeader + the (?) popover',
  callout: 'ui.inlineNote(), or the (?) popover for background',
  'section-head': 'ui.pageHeader()',
  subtabs: 'ui.tabs() (tabStrip) — the class is fine, building the strip by hand is not',
  'seg-btn': 'ui.tabs()',
  'fs-chip': 'ui.statStrip()',
  'chip-det': 'ui.meta()',
  pill: 'ui.badge() for a state, ui.meta() for anything else',
  tablewrap: 'ui.dataTable()',
  'data-table': 'ui.dataTable()',
  'form-grid': 'ui.formSection()',
  'set-field': 'ui.field()',
  'form-actions': 'ui.formActions()',
  'row-actions': 'ui.rowActions()',
  'dc-head': 'ui.panel()',
  'settings-card': 'ui.panel()',
  'sa-panel': 'ui.panel()',
  'sa-empty': 'ui.emptyState()',
};

// `ui-check | head` closes the pipe while the report is still being written,
// and an unhandled EPIPE on stdout crashes node with a stack trace instead of
// the findings. Piping a long report into head is exactly how somebody reads
// one, so it has to survive it.
process.stdout.on('error', (err) => { if (err && err.code === 'EPIPE') process.exit(0); });

const findings = [];
function report(file, line, rule, message) {
  findings.push({ file, line, rule, message });
}

const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

// Comments are documentation, not code: a rule that fires on the sentence
// explaining the rule is a rule people switch off.
function stripComments(src) {
  // Replace with spaces so every offset — and therefore every line number —
  // stays exactly where it was.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/[^\n]/g, ' '));
}

// ---------------------------------------------------------------- CSS rules
function cssFiles() {
  return fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.css'))
    .concat(fs.existsSync(CSS_DIR)
      ? fs.readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).map((f) => `css/${f}`)
      : []);
}

function checkCss() {
  // COLOUR is swept in every stylesheet, always. It was once counted rather
  // than failed on — the unmigrated chrome carried 461 literals and a lint that
  // cannot pass is a lint nobody runs — but phase 4 emptied them, so the rule
  // is now what keeps them empty. The SIZE rule is still contract-only: the old
  // sheets are full of hand-set px that migrate with their screens.
  for (const rel of cssFiles()) {
    const raw = read(rel);
    const src = stripComments(raw);

    if (!TOKEN_FILES.has(rel)) {
      // A colour outside tokens.css drops out of the palette system silently:
      // it survives a theme switch looking exactly wrong.
      for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g)) {
        report(rel, lineOf(src, m.index), 'colour',
          `${m[0].trim()} — colour belongs in css/tokens.css`);
      }
    }

    if (CONTRACT_CSS.has(rel)) {
      // The contract's own sheets take every size from a token. (styles.css is
      // exempt until phase 3 has emptied it.)
      for (const m of src.matchAll(/(font-size|padding|margin|gap|row-gap|column-gap)[a-z-]*:\s*[^;{}]*?\b(\d+)px/g)) {
        if (m[2] === '0' || m[2] === '1') continue; // a hairline is a hairline
        report(rel, lineOf(src, m.index), 'px-size',
          `${m[1]}: ${m[2]}px — use a --s-* or --fs-* token`);
      }
    }
  }
}

// ---------------------------------------------------------------- JS rules
function checkJs() {
  for (const rel of MIGRATED) {
    const raw = read(rel);
    const src = stripComments(raw);

    // inline style="…"
    //
    // One exemption, and it is an element rather than a file: a <col> width is
    // table geometry the caller supplies per table, and expressing it in CSS
    // would mean one class per pixel value. Every other inline style is still
    // caught, in every file, including the rest of ui.js.
    for (const m of src.matchAll(/\bstyle\s*:\s*['"`]/g)) {
      if (/el\(\s*'col'[^)]*$/.test(src.slice(Math.max(0, m.index - 60), m.index))) continue;
      report(rel, lineOf(src, m.index), 'inline-style',
        'inline style — put it in css/components.css behind a class');
    }
    for (const m of src.matchAll(/\bstyle\s*=\s*"/g)) {
      report(rel, lineOf(src, m.index), 'inline-style',
        'inline style attribute — put it in css/components.css behind a class');
    }

    // A colour literal in a view is the same bug as one in a stylesheet.
    for (const m of src.matchAll(/#[0-9a-fA-F]{3,6}\b(?![\w-])|\brgba?\(/g)) {
      report(rel, lineOf(src, m.index), 'colour',
        `${m[0].trim()} — colour belongs in css/tokens.css`);
    }

    // Legacy classes.
    for (const m of src.matchAll(/class\s*:\s*['"`]([^'"`]+)['"`]/g)) {
      const raw2 = m[1];
      // Template placeholders are dynamic; the literal part is still checked.
      for (const cls of raw2.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean)) {
        if (LEGACY_CLASSES[cls]) {
          report(rel, lineOf(src, m.index), 'legacy-class',
            `.${cls} — use ${LEGACY_CLASSES[cls]}`);
        }
      }
    }

    // Buttons used as tabs.
    for (const m of src.matchAll(/class\s*:\s*['"`][^'"`]*\b(subtabs|seg|seg-btn|sa-segmented)\b/g)) {
      report(rel, lineOf(src, m.index), 'tab-pattern',
        'build a tab strip with ui.tabs() — it carries the keyboard and the ARIA');
    }

    // A badge is a state. A chip carrying a count or a host name is metadata
    // wearing a state's clothes.
    for (const m of src.matchAll(/class\s*:\s*['"`][^'"`]*\bchip\b[^'"`]*['"`]/g)) {
      report(rel, lineOf(src, m.index), 'chip-metadata',
        'chip — ui.badge() for a state, ui.meta() for metadata, ui.hostLink() for a host');
    }

    // At most one primary per PageHeader. Read the actions array rather than
    // the whole file, so two headers on one page are counted separately.
    for (const m of src.matchAll(/actions\s*:\s*\[([\s\S]*?)\]\s*,?\s*\}\)/g)) {
      const primaries = (m[1].match(/'primary'|"primary"|btn-primary/g) || []).length;
      if (primaries > 1) {
        report(rel, lineOf(src, m.index), 'primary-count',
          `${primaries} primary buttons in one PageHeader — the contract allows one`);
      }
    }

    // A migrated view is a composition. ui.js and the shared modules are the
    // components themselves, so the rule applies to the screens.
    if (rel !== 'ui.js') {
      if (!/ui\.page\(/.test(src)) {
        report(rel, 1, 'template',
          'no ui.page() — a migrated view builds itself from the contract components');
      }
      if (!/ui\.pageHeader\(/.test(src)) {
        report(rel, 1, 'template',
          'no ui.pageHeader() — every page template starts with one');
      }
    }
  }
}

// ---------------------------------------------------------------- run
checkCss();
checkJs();

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
for (const f of findings) {
  process.stdout.write(`public/${f.file}:${f.line}:${f.rule}  ${f.message}\n`);
}

const scanned = MIGRATED.length;
if (findings.length) {
  process.stdout.write(`\nui:check — ${findings.length} finding(s)\n`);
  // NOT process.exit(): it tears the process down with writes still queued, so
  // on a pipe (CI, a test harness, a shell pipeline) the tail of the report is
  // lost — and with hundreds of findings, that is most of it. Setting exitCode
  // lets node drain stdout and exit on its own.
  process.exitCode = 1;
}

if (!findings.length) {
  process.stdout.write(`ui:check — clean (${scanned} migrated file(s), ${cssFiles().length} stylesheet(s))\n`);
}
