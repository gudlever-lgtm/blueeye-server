'use strict';

// The script Discovery runs INSIDE the page.
//
// It is deliberately a plain function serialised into the browser: it must not
// close over anything from Node, and everything it returns must be structured-
// cloneable. It only READS — no clicks, no submits, no writes (spec §8).
//
// Keeping it here rather than inline in the worker means the shape it produces is
// versioned alongside extract.js, which is what parses it.

function extractSnapshotScript() {
  var MAX = 200;
  var text = function (el) { return (el.innerText || el.textContent || '').trim().slice(0, 255); };
  var attr = function (el, name) { return el.getAttribute(name) || null; };

  // The accessible name, cheaply: aria-label, then a referenced label, then the
  // visible text. Not a full accname implementation — enough to target reliably.
  function accessibleName(el) {
    var aria = el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 255);
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var ref = document.getElementById(labelledBy);
      if (ref) return text(ref);
    }
    if (el.id) {
      var label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) return text(label);
    }
    var wrapping = el.closest ? el.closest('label') : null;
    if (wrapping) return text(wrapping);
    return text(el);
  }

  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      return 'textbox';
    }
    return null;
  }

  var links = [];
  var els = document.querySelectorAll('a[href]');
  for (var i = 0; i < els.length && links.length < MAX; i++) {
    var a = els[i];
    links.push({
      text: text(a), href: a.getAttribute('href'), role: 'link',
      accessibleName: accessibleName(a), id: a.id || null, ariaLabel: attr(a, 'aria-label'),
    });
  }

  var buttons = [];
  var bs = document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]');
  for (var j = 0; j < bs.length && buttons.length < MAX; j++) {
    var b = bs[j];
    buttons.push({
      text: text(b) || attr(b, 'value'), type: (b.getAttribute('type') || '').toLowerCase(),
      role: roleOf(b), accessibleName: accessibleName(b), ariaLabel: attr(b, 'aria-label'),
      name: attr(b, 'name'), id: b.id || null,
    });
  }

  var inputs = [];
  var is = document.querySelectorAll('input, textarea');
  for (var k = 0; k < is.length && inputs.length < MAX; k++) {
    var inp = is[k];
    var type = (inp.getAttribute('type') || 'text').toLowerCase();
    if (type === 'hidden') continue;
    inputs.push({
      // The VALUE is never read: a page may prefill a field, and reading it
      // would put user data into the discovery record. Metadata only.
      label: accessibleName(inp), name: attr(inp, 'name'), id: inp.id || null,
      type: type, placeholder: attr(inp, 'placeholder'), autocomplete: attr(inp, 'autocomplete'),
      role: roleOf(inp), required: inp.hasAttribute('required'),
    });
  }

  var forms = [];
  var fs = document.querySelectorAll('form');
  for (var m = 0; m < fs.length && forms.length < MAX; m++) {
    var f = fs[m];
    forms.push({
      action: f.getAttribute('action') || '', method: (f.getAttribute('method') || 'get').toLowerCase(),
      id: f.id || null, name: attr(f, 'name'), field_count: f.elements ? f.elements.length : 0,
    });
  }

  var selects = [];
  var ss = document.querySelectorAll('select');
  for (var n = 0; n < ss.length && selects.length < MAX; n++) {
    var sel = ss[n];
    var options = [];
    for (var o = 0; o < sel.options.length && o < 50; o++) {
      options.push({ value: sel.options[o].value, label: (sel.options[o].text || '').trim().slice(0, 120) });
    }
    selects.push({
      label: accessibleName(sel), name: attr(sel, 'name'), id: sel.id || null,
      role: 'combobox', options: options,
    });
  }

  return {
    title: (document.title || '').slice(0, 512),
    links: links, buttons: buttons, inputs: inputs, forms: forms, selects: selects,
  };
}

module.exports = { extractSnapshotScript };
