'use strict';

// The script the accessibility check runs INSIDE the page (V2 §9).
//
// Like pageSnapshot.js it is a plain function serialised into the browser: it
// must not close over anything from Node, and everything it returns must be
// structured-cloneable. It only READS — no clicks, no focus changes, no writes.
// Running an audit must not alter the page it is auditing.
//
// It collects FACTS and judges nothing. Every "is this a problem" decision lives
// in rules.js, where it is testable without a browser. That split is the point:
// this file cannot be unit-tested (it needs a DOM), so it must contain nothing
// worth arguing about.

function collectAccessibilityScript() {
  var MAX_NODES = 600;
  var MAX_HEADINGS = 100;

  function trim(s) { return (s === null || s === undefined) ? '' : String(s).trim(); }
  function text(el) { return trim(el.innerText || el.textContent || '').slice(0, 255); }

  // A stable-enough selector to find the element again. id first because it is
  // exact; otherwise a short path, because "the third div" is not a location
  // anybody can act on.
  function selectorFor(el) {
    if (el.id) { try { return '#' + CSS.escape(el.id); } catch (e) { return '#' + el.id; } }
    var name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
    var parts = [];
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      var part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) part += '.' + node.classList[0];
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // The text of whatever aria-labelledby points at. Several ids are allowed and
  // the browser joins them, so this does too rather than reading only the first.
  function labelledByText(el) {
    var ids = trim(el.getAttribute('aria-labelledby'));
    if (!ids) return '';
    var out = [];
    var list = ids.split(/\s+/);
    for (var i = 0; i < list.length; i++) {
      var ref = document.getElementById(list[i]);
      if (ref) out.push(text(ref));
    }
    return trim(out.join(' '));
  }

  // The <label> associated with a field, by `for` or by wrapping it.
  function labelText(el) {
    if (el.id) {
      var forLabel = null;
      try { forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); } catch (e) { forLabel = null; }
      if (forLabel) return text(forLabel);
    }
    var wrapping = el.closest ? el.closest('label') : null;
    if (wrapping) return text(wrapping);
    return '';
  }

  // Hidden from EVERYONE, which is not an accessibility problem — it is not part
  // of the page. Checked against computed style rather than the attribute alone,
  // because display:none via a class is how most of it is really done.
  function hiddenState(el) {
    var ariaHidden = trim(el.getAttribute('aria-hidden')) === 'true';
    var attrHidden = el.hasAttribute('hidden');
    var displayNone = false;
    try {
      var cs = window.getComputedStyle(el);
      displayNone = cs && (cs.display === 'none' || cs.visibility === 'hidden');
    } catch (e) { displayNone = false; }
    return { ariaHidden: ariaHidden, hidden: attrHidden, displayNone: displayNone };
  }

  function tabIndexOf(el) {
    var raw = el.getAttribute('tabindex');
    if (raw === null) return null;
    var n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  }

  // Natively focusable, or made so. A disabled control is not focusable and is
  // not a keyboard problem — it is deliberately unavailable to everybody.
  function focusable(el) {
    if (el.hasAttribute('disabled')) return true;
    var tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'select' || tag === 'textarea') return true;
    if (tag === 'input') return true;
    if (tag === 'a') return el.hasAttribute('href');
    var ti = tabIndexOf(el);
    return ti !== null;
  }

  function base(el, kind) {
    var h = hiddenState(el);
    return {
      kind: kind,
      tag: el.tagName.toLowerCase(),
      selector: selectorFor(el),
      role: trim(el.getAttribute('role')) || null,
      text: text(el),
      ariaLabel: trim(el.getAttribute('aria-label')),
      ariaLabelledByText: labelledByText(el),
      title: trim(el.getAttribute('title')),
      tabIndex: tabIndexOf(el),
      focusable: focusable(el),
      ariaHidden: h.ariaHidden,
      hidden: h.hidden,
      displayNone: h.displayNone,
    };
  }

  var nodes = [];
  function push(node) { if (nodes.length < MAX_NODES) nodes.push(node); }

  // Buttons and anything acting as one.
  var buttons = document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], input[type="reset"]');
  for (var b = 0; b < buttons.length; b++) {
    var btn = base(buttons[b], 'button');
    // A submit input carries its name in `value`, not its text content.
    btn.value = trim(buttons[b].getAttribute('value'));
    push(btn);
  }

  // Links. An <a> with no href is not a link — it is text — so it is not judged
  // as one.
  var links = document.querySelectorAll('a[href], [role="link"]');
  for (var l = 0; l < links.length; l++) push(base(links[l], 'link'));

  // Form fields. Hidden inputs are not fields anybody fills in.
  var fields = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea');
  for (var f = 0; f < fields.length; f++) {
    var field = base(fields[f], 'field');
    field.labelText = labelText(fields[f]);
    field.placeholder = trim(fields[f].getAttribute('placeholder'));
    push(field);
  }

  // Images. `null` alt means the attribute is ABSENT; empty string means it is
  // present and deliberately empty, which is correct for decoration. The
  // difference decides whether this is a finding at all, so it is preserved
  // rather than flattened.
  var images = document.querySelectorAll('img');
  for (var i = 0; i < images.length; i++) {
    var img = base(images[i], 'image');
    img.alt = images[i].hasAttribute('alt') ? trim(images[i].getAttribute('alt')) : null;
    push(img);
  }

  // Things wired up as clickable that are not buttons or links. This is the
  // div-with-an-onclick case, which works perfectly with a mouse and not at all
  // with a keyboard. Only inline handlers and explicit cursor:pointer can be
  // seen from here — a listener added with addEventListener is invisible to any
  // script, so this finds the common case and does not pretend to find all.
  var candidates = document.querySelectorAll('[onclick], div[class*="btn"], span[class*="btn"], div[class*="button"], span[class*="button"]');
  for (var c = 0; c < candidates.length; c++) {
    var el = candidates[c];
    var tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'input') continue;
    if (trim(el.getAttribute('role')) === 'button' || trim(el.getAttribute('role')) === 'link') continue;
    push(base(el, 'clickable'));
  }

  var headings = [];
  var hs = document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]');
  for (var hI = 0; hI < hs.length && headings.length < MAX_HEADINGS; hI++) {
    var hEl = hs[hI];
    var level = parseInt(hEl.tagName.slice(1), 10);
    if (isNaN(level)) level = parseInt(trim(hEl.getAttribute('aria-level')), 10);
    if (isNaN(level)) continue;
    var heading = base(hEl, 'heading');
    heading.level = level;
    headings.push(heading);
  }

  return {
    document: {
      lang: trim(document.documentElement && document.documentElement.getAttribute('lang')),
      title: trim(document.title),
      url: String(location.href).slice(0, 1024),
    },
    nodes: nodes,
    headings: headings,
    // So a truncated collection is visible rather than looking like a clean page.
    truncated: nodes.length >= MAX_NODES,
  };
}

module.exports = { collectAccessibilityScript };
