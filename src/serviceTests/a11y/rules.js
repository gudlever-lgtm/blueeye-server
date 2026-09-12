'use strict';

// Accessibility checks (V2 §9).
//
// Missing labels, buttons with no accessible name, images with no alt, fields
// with no label, heading structure, keyboard access on the things people
// actually operate.
//
// Two rules govern everything here, and they are the whole design:
//
//   1. A finding NEVER fails a run. The spec says "reported separately from
//      functional failures" and it means it: an image missing alt text is not
//      the service being down. Mixing the two makes both useless — the run
//      status stops meaning "the journey works", and the accessibility report
//      becomes something people switch off to get their build green.
//
//   2. Every finding says what it saw, why it matters and which element it was
//      about. A list of rule codes is a report nobody acts on.
//
// PURE: a collected snapshot in, findings out. No DOM, no browser, no clock —
// every judgement lives here where it can be argued with in a test.
//
// Hand-written rather than a library. The repo's rule is local + explainable
// with no cloud and no heavyweight dependency, and injecting a third-party
// auditor into a customer's page under test is a different risk from running
// our own read-only checks. The cost is narrower coverage, which is why this is
// called "basic checks" and says so on the screen rather than implying a page
// with no findings is accessible.

// Impact, not severity. Deliberately a different vocabulary from CRIT/WARN/INFO
// so nobody reads an accessibility finding as an incident — and so the two can
// never be summed into one misleading number.
const IMPACT = { SERIOUS: 'serious', MODERATE: 'moderate', MINOR: 'minor' };

// A hard ceiling. One templating mistake can produce four hundred identical
// findings, and a report nobody can read is a report nobody reads. The count is
// reported honestly alongside what was kept.
const MAX_FINDINGS = 100;

// Per rule, so one bad pattern cannot crowd out every other kind of problem.
// Fifty unlabelled inputs and one unnamed button is a page with two problems,
// and the second must not be pushed off the end of the list.
const MAX_PER_RULE = 20;

const trim = (v) => (typeof v === 'string' ? v.trim() : '');

// Does this element have an accessible name?
//
// Not a full accname implementation — that is a specification of its own, and
// claiming one we do not have would be worse than saying what this is. It
// covers the sources that actually appear in real markup, in the order the
// browser consults them.
function accessibleName(node) {
  if (!node) return '';
  return trim(node.ariaLabel)
    || trim(node.ariaLabelledByText)
    || trim(node.labelText)
    || trim(node.title)
    || trim(node.alt)
    || trim(node.value)
    || trim(node.text);
}

// An element hidden from everyone is not an accessibility problem — it is not
// part of the page. `aria-hidden` plus no size is how carousels, drawers and
// off-screen menus are built, and flagging them is how a report earns its
// reputation for noise.
function isHidden(node) {
  return Boolean(node && (node.hidden === true || node.ariaHidden === true || node.displayNone === true));
}

// A finding, in the repo's shape: what, where, why, and the evidence.
function finding(rule, impact, node, message, why) {
  return {
    rule,
    impact,
    message,
    why,
    // Enough to FIND the element again. A finding an operator cannot locate is
    // a finding they cannot fix.
    element: {
      tag: (node && node.tag) || null,
      selector: (node && node.selector) || null,
      text: (node && trim(node.text).slice(0, 120)) || null,
      role: (node && node.role) || null,
    },
  };
}

// ---------------------------------------------------------------- the rules

// A control nobody can name is a control a screen reader announces as "button".
function unnamedControls(nodes) {
  return nodes
    .filter((n) => ['button', 'link'].includes(n.kind) && !isHidden(n) && !accessibleName(n))
    .map((n) => finding(
      n.kind === 'link' ? 'link-name' : 'button-name',
      IMPACT.SERIOUS,
      n,
      n.kind === 'link' ? 'This link has no text a screen reader can announce.'
        : 'This button has no text a screen reader can announce.',
      'It is read out as just "button" or "link", so someone using a screen reader '
        + 'cannot tell what it does without activating it to find out.'
    ));
}

// A field with no label is a field you have to guess at.
function unlabelledFields(nodes) {
  return nodes
    .filter((n) => n.kind === 'field' && !isHidden(n) && !accessibleName(n))
    .map((n) => finding(
      'field-label', IMPACT.SERIOUS, n,
      'This form field has no label.',
      'A screen reader announces the field with no idea what belongs in it. '
        + 'A placeholder is not a label — it disappears the moment someone types.'
    ));
}

// A placeholder standing in for a label is the commonest near-miss: it looks
// labelled until the first keystroke, and it is never announced as a name.
function placeholderAsLabel(nodes) {
  return nodes
    .filter((n) => n.kind === 'field' && !isHidden(n)
      && !trim(n.ariaLabel) && !trim(n.ariaLabelledByText) && !trim(n.labelText)
      && trim(n.placeholder))
    .map((n) => finding(
      'placeholder-not-label', IMPACT.MODERATE, n,
      `This field is identified only by its placeholder ("${trim(n.placeholder).slice(0, 60)}").`,
      'The placeholder vanishes as soon as someone types, so anyone who looks away '
        + 'loses what the field was for — and it is not reliably announced as the name.'
    ));
}

// An image with no alt at all. Empty alt is CORRECT for decoration and is not
// flagged: alt="" is how you say "this picture carries no information", and
// treating it as a fault would push people into writing noise.
function imagesWithoutAlt(nodes) {
  return nodes
    .filter((n) => n.kind === 'image' && !isHidden(n) && n.alt === null && !trim(n.ariaLabel))
    .map((n) => finding(
      'image-alt', IMPACT.SERIOUS, n,
      'This image has no alt attribute.',
      'A screen reader falls back to reading the file name, or skips it. If the image '
        + 'is decorative the fix is alt="" — saying so explicitly, not leaving it out.'
    ));
}

// Heading structure. Two separate problems, deliberately distinguished.
function headingStructure(headings) {
  const visible = (headings || []).filter((h) => !isHidden(h) && trim(h.text));
  const out = [];
  if (!visible.length) return out;

  const h1s = visible.filter((h) => h.level === 1);
  if (!h1s.length) {
    out.push(finding('heading-h1', IMPACT.MODERATE, visible[0],
      'This page has no level-1 heading.',
      'The h1 is what someone jumping by headings lands on first — it is how they '
        + 'learn what page they are on without reading it all.'));
  }

  // A jump (h2 → h4) means a level was skipped, which reads as a missing
  // section to anyone navigating by structure. Going back UP is normal — that
  // is just the next section — so only downward jumps count.
  let previous = null;
  for (const h of visible) {
    if (previous !== null && h.level > previous + 1) {
      out.push(finding('heading-order', IMPACT.MINOR, h,
        `Heading level jumps from h${previous} to h${h.level}.`,
        'Someone navigating by headings hears a section start where its parent should '
          + 'be, so the page reads as if a section is missing.'));
    }
    previous = h.level;
  }
  return out;
}

// Keyboard access. Two things, both about people who never touch a mouse.
function keyboardAccess(nodes) {
  const out = [];

  // A div wired up with onclick is a button to a mouse and nothing at all to a
  // keyboard: no focus, no Enter, no Space.
  for (const n of nodes) {
    if (isHidden(n)) continue;
    if (n.kind !== 'clickable') continue;
    if (n.focusable) continue;
    out.push(finding('keyboard-reachable', IMPACT.SERIOUS, n,
      'This is clickable with a mouse but cannot be reached with a keyboard.',
      'It has a click handler but no tabindex and is not a button or a link, so it '
        + 'never takes focus. Anyone using a keyboard or a screen reader cannot operate it.'));
  }

  // A positive tabindex does not add an element to the tab order — it jumps it
  // to the FRONT of the whole page, ahead of everything with tabindex 0. One is
  // usually a mistake; several is a tab order nobody can predict.
  for (const n of nodes) {
    if (isHidden(n)) continue;
    if (!Number.isInteger(n.tabIndex) || n.tabIndex <= 0) continue;
    out.push(finding('tabindex-positive', IMPACT.MODERATE, n,
      `This element has tabindex="${n.tabIndex}".`,
      'A positive tabindex pulls it in front of everything else on the page rather '
        + 'than leaving it in reading order, so the tab order stops matching what is on screen.'));
  }
  return out;
}

// The page needs a language, or a screen reader reads English with a Danish
// voice — or the other way round, which is worse in a Danish product.
function documentLanguage(document) {
  if (!document) return [];
  if (trim(document.lang)) return [];
  return [finding('html-lang', IMPACT.SERIOUS, { tag: 'html', selector: 'html' },
    'The page does not say what language it is in.',
    'Without lang on <html> a screen reader uses its own default voice, so the page '
      + 'is pronounced as if it were another language.')];
}

// A page with no title is "Untitled" in every tab, every bookmark and every
// announcement when the page loads.
function documentTitle(document) {
  if (!document) return [];
  if (trim(document.title)) return [];
  return [finding('document-title', IMPACT.MODERATE, { tag: 'title', selector: 'title' },
    'The page has no title.',
    'The title is announced when the page loads and is what identifies it in tabs, '
      + 'history and bookmarks.')];
}

const RULES = [
  (s) => documentLanguage(s.document),
  (s) => documentTitle(s.document),
  (s) => unnamedControls(s.nodes),
  (s) => unlabelledFields(s.nodes),
  (s) => placeholderAsLabel(s.nodes),
  (s) => imagesWithoutAlt(s.nodes),
  (s) => headingStructure(s.headings),
  (s) => keyboardAccess(s.nodes),
];

// Runs every rule over one collected page.
//
//   audit({ document: {...}, nodes: [...], headings: [...] })
//   -> { findings, counts, truncated, checked }
//
// `truncated` is reported rather than hidden: "20 of 340" is a different fact
// from "20", and an operator who cannot tell them apart will fix twenty things
// and believe they are done.
function audit(snapshot) {
  const safe = {
    document: (snapshot && snapshot.document) || null,
    nodes: Array.isArray(snapshot && snapshot.nodes) ? snapshot.nodes : [],
    headings: Array.isArray(snapshot && snapshot.headings) ? snapshot.headings : [],
  };

  const byRule = new Map();
  let total = 0;
  for (const rule of RULES) {
    let produced = [];
    // One rule throwing must not lose the other seven. A page can contain
    // anything, and an accessibility report is the last place that should take
    // a run down with it.
    try { produced = rule(safe) || []; } catch { produced = []; }
    for (const f of produced) {
      total += 1;
      const list = byRule.get(f.rule) || [];
      if (list.length < MAX_PER_RULE) list.push(f);
      byRule.set(f.rule, list);
    }
  }

  // Serious first: the order is the order to fix them in.
  const order = { [IMPACT.SERIOUS]: 0, [IMPACT.MODERATE]: 1, [IMPACT.MINOR]: 2 };
  const findings = [...byRule.values()].flat()
    .sort((a, b) => (order[a.impact] - order[b.impact]) || a.rule.localeCompare(b.rule))
    .slice(0, MAX_FINDINGS);

  const counts = { serious: 0, moderate: 0, minor: 0, total };
  for (const f of findings) counts[f.impact] += 1;

  return {
    findings,
    counts,
    truncated: total > findings.length,
    // What was actually looked at, so "no findings" can be read honestly. A page
    // where nothing was collected is not a page that passed.
    checked: { elements: safe.nodes.length, headings: safe.headings.length },
  };
}

module.exports = {
  audit, accessibleName, isHidden,
  IMPACT, MAX_FINDINGS, MAX_PER_RULE,
};
