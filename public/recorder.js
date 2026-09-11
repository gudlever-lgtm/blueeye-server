/* BlueEyes Service Assurance — the recorder.
 *
 * Injected into the operator's own browser, on the application they want to
 * test, by the bookmarklet BlueEyes hands them. It watches what they do and
 * posts a description of it back; the server turns that into a test.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP: it OBSERVES. It never clicks, never
 * fills, never submits, never reads a page it was not injected into. Everything
 * it sends is a description of an element — its role, its label, its visible
 * text — plus, for ordinary fields, what was typed into them.
 *
 * WHAT IT NEVER SENDS:
 *   - the value of a password field (reported as null, and the server enforces
 *     the same rule again — see recording/validate.js);
 *   - cookies, storage, or any header;
 *   - the page's HTML, or anything it did not observe as an interaction.
 *
 * Plain ES5-ish browser JavaScript with no dependencies, because it has to run
 * inside whatever the customer's application already is.
 */
(function () {
  'use strict';
  if (window.__blueeyeRecorder) return;

  var script = document.currentScript;
  if (!script || !script.dataset || !script.dataset.endpoint || !script.dataset.token) return;
  var ENDPOINT = script.dataset.endpoint;
  var TOKEN = script.dataset.token;

  var queue = [];
  var stopped = false;
  var flushing = false;
  var FLUSH_MS = 2000;
  var flushMs = FLUSH_MS;
  var MAX_QUEUE = 500;

  // ---------------------------------------------------------------- describing

  function text(node) {
    if (!node) return '';
    var value = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    return value.length > 120 ? value.slice(0, 120) : value;
  }

  // The accessible name, the way a person would name the thing they clicked:
  // its aria-label, the element it is labelled by, its own text, its value.
  function accessibleName(el) {
    if (!el) return '';
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 120);
    var labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var by = document.getElementById(labelledBy.split(/\s+/)[0]);
      if (by) return text(by);
    }
    if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) {
      return String(el.value || '').trim().slice(0, 120);
    }
    return text(el);
  }

  // The <label> for a field: a wrapping label, a for= label, or the field's own
  // aria-label. This is the hint the runner prefers, so it is worth the work.
  function labelFor(el) {
    if (!el) return '';
    if (el.labels && el.labels.length) return text(el.labels[0]);
    var wrapper = el.closest ? el.closest('label') : null;
    if (wrapper) return text(wrapper);
    if (el.id) {
      var byFor = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (byFor) return text(byFor);
    }
    return '';
  }

  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
    return String(value).replace(/["'\\\]\[#.:>+~ ]/g, '\\$&');
  }

  // An implicit ARIA role, for the handful of elements that carry one. Enough
  // for the targeting layer to prefer role+name over an id; not an ARIA engine.
  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A' && el.getAttribute('href')) return 'link';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4') return 'heading';
    if (tag === 'INPUT') {
      var type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'textbox';
    }
    return '';
  }

  // A last-resort CSS path, short and structural. The server prefers every other
  // hint over this one — it is here so a target is never empty, not because it
  // is a good way to find an element.
  function cssPath(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      var part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + '#' + cssEscape(node.id)); break; }
      var parent = node.parentNode;
      if (parent) {
        var siblings = [];
        for (var i = 0; i < parent.children.length; i += 1) {
          if (parent.children[i].tagName === node.tagName) siblings.push(parent.children[i]);
        }
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
      depth += 1;
    }
    return parts.join(' > ').slice(0, 300);
  }

  // Everything we know about the element, all of it. The server keeps every hint
  // and tries them in priority order at run time, so a changed id does not break
  // a test that also knows the role and the name.
  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    var target = {};
    var role = roleOf(el);
    if (role) target.role = role;
    var name = accessibleName(el);
    if (name) target.name = name;
    var label = labelFor(el);
    if (label) target.label = label;
    var placeholder = el.getAttribute && el.getAttribute('placeholder');
    if (placeholder) target.placeholder = placeholder.trim().slice(0, 120);
    if (el.name) target.name = target.name || String(el.name).slice(0, 120);
    if (el.id) target.id = String(el.id).slice(0, 120);
    if (!target.role && !target.name && !target.label && !target.placeholder && !target.id) {
      target.css = cssPath(el);
    }
    return target;
  }

  // ---------------------------------------------------------------- capturing

  // The badge counts what was actually queued, not what was offered: a dropped
  // event (stopped, or the queue at its cap) must not show up as captured work
  // the operator will then look for in the review screen.
  function push(event) {
    if (stopped || queue.length >= MAX_QUEUE) return;
    event.at = Date.now();
    event.url = location.href;
    queue.push(event);
    counted += 1;
    paint();
  }

  // Kept in step with src/serviceTests/recording/secrets.js, which is the
  // authority: the server scrubs again on arrival, so this is the first of two
  // barriers, not the only one. Duplicated deliberately — a value that never
  // leaves the browser is better than one the server has to throw away.
  function isPassword(el) {
    if (!el) return false;
    if ((el.type || '').toLowerCase() === 'password') return true;
    var hints = [el.autocomplete, labelFor(el), el.getAttribute && el.getAttribute('placeholder'), el.name, el.id]
      .filter(Boolean).join(' ').toLowerCase();
    return /(^|[^a-z])(password|passwd|pwd|passphrase|secret|kodeord|adgangskode|pinkode)([^a-z]|$)/.test(hints);
  }

  function onClick(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    // Anything inside a button or a link IS that button or link, as far as the
    // person clicking is concerned.
    var actionable = el.closest ? (el.closest('button, a, [role="button"], input[type="submit"], input[type="button"]') || el) : el;
    push({ kind: 'click', target: describe(actionable), tagName: (actionable.tagName || '') });
  }

  function onInput(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    var tag = (el.tagName || '').toUpperCase();
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
    var type = (el.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      push({ kind: 'check', target: describe(el), tagName: tag, checked: !!el.checked });
      return;
    }
    push({
      kind: 'input',
      target: describe(el),
      tagName: tag,
      inputType: type,
      autocomplete: el.autocomplete || '',
      // The password rule. Nothing further down this file can undo it, because
      // there is nothing further down that reads el.value again.
      value: isPassword(el) ? null : String(el.value == null ? '' : el.value).slice(0, 512),
    });
  }

  function onChange(e) {
    var el = e.target;
    if (!el || (el.tagName || '').toUpperCase() !== 'SELECT') return;
    var selected = el.options && el.options[el.selectedIndex];
    push({
      kind: 'select', target: describe(el), tagName: 'SELECT',
      value: selected ? String(selected.text || selected.value || '').slice(0, 200) : '',
    });
  }

  function onSubmit(e) {
    var form = e.target;
    if (!form || form.nodeType !== 1) return;
    var submit = form.querySelector ? form.querySelector('[type="submit"], button:not([type="button"])') : null;
    push({ kind: 'submit', target: describe(submit || form), tagName: submit ? (submit.tagName || '') : 'FORM' });
  }

  var lastUrl = location.href;
  function checkNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    push({ kind: 'navigate' });
  }

  // ---------------------------------------------------------------- transport

  // `final` sends the stop signal AFTER the last batch, never instead of it:
  // posting to /stop with events in the body would drop the tail of the journey,
  // which is usually the assertion the operator cared about.
  function flush(final) {
    if (flushing) return;
    var batch = queue.splice(0, 200);
    if (!batch.length && !final) return;
    if (batch.length && final) { post('/events', batch, function () { post('/stop', [], null); }); return; }
    post(final ? '/stop' : '/events', batch, null);
  }

  function post(path, batch, then) {
    flushing = true;
    fetch(ENDPOINT + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No cookies, to BlueEyes or to anyone: the capture token is the only
      // authority this request carries, and the server allows no credentials.
      credentials: 'omit',
      mode: 'cors',
      body: JSON.stringify({ token: TOKEN, events: batch }),
      keepalive: path === '/stop',
    }).then(function (res) {
      flushing = false;
      // 401 is terminal: the recording expired or was stopped, and nothing the
      // recorder does will change that.
      if (res.status === 401) { teardown('expired'); return null; }
      // 429 is NOT. Losing the operator's journey because we flushed too eagerly
      // would be a far worse failure than the volume the limiter guards against,
      // so the batch goes back on the queue and the next flush waits longer.
      if (res.status === 429) { requeue(batch); backOff(); return null; }
      return res.json().catch(function () { return null; });
    }).then(function (body) {
      // Stopped from the dashboard — the operator is done, even though they are
      // still on this page.
      if (body && body.status && body.status !== 'recording') teardown('stopped');
      if (then) then();
    }).catch(function () {
      flushing = false;
      // Put the batch back: a flaky network must not silently lose the journey.
      requeue(batch);
    });
  }

  function requeue(batch) {
    if (batch.length && queue.length + batch.length <= MAX_QUEUE) queue = batch.concat(queue);
  }

  // Doubles the flush interval, up to 30 seconds. The recording keeps running;
  // it just stops asking so often.
  function backOff() {
    if (stopped || flushMs >= 30000) return;
    flushMs = Math.min(flushMs * 2, 30000);
    clearInterval(timer);
    timer = setInterval(function () { flush(false); }, flushMs);
  }

  // ---------------------------------------------------------------- the badge

  var badge = document.createElement('div');
  badge.setAttribute('style', [
    'position:fixed', 'z-index:2147483647', 'right:16px', 'bottom:16px',
    'background:#0b0b0b', 'color:#fff', 'font:600 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif',
    'padding:10px 14px', 'border-radius:999px', 'box-shadow:0 4px 16px rgba(0,0,0,.35)',
    'display:flex', 'gap:8px', 'align-items:center', 'cursor:pointer', 'user-select:none',
  ].join(';'));
  var dot = document.createElement('span');
  dot.setAttribute('style', 'width:9px;height:9px;border-radius:50%;background:#d03b3b;display:inline-block');
  var label = document.createElement('span');
  label.textContent = 'BlueEyes optager · 0';
  badge.appendChild(dot);
  badge.appendChild(label);
  badge.title = 'Klik for at stoppe optagelsen. Efter et sideskift: klik bogmærket igen.';
  badge.addEventListener('click', function () { flush(true); teardown('stopped'); });


  var counted = 0;
  function paint() {
    counted = Math.max(counted, 0);
    label.textContent = 'BlueEyes optager · ' + counted;
  }

  // ---------------------------------------------------------------- lifecycle

  var timer = null;
  var navTimer = null;

  function teardown(reason) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearInterval(navTimer);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('submit', onSubmit, true);
    window.removeEventListener('pagehide', onUnload);
    dot.style.background = '#898781';
    label.textContent = reason === 'expired'
      ? 'BlueEyes: optagelsen er udløbet'
      : 'BlueEyes: optagelse stoppet · ' + counted;
    setTimeout(function () { if (badge.parentNode) badge.parentNode.removeChild(badge); }, 4000);
    delete window.__blueeyeRecorder;
  }

  function onUnload() { flush(false); }

  // Capture phase, so a page that stops propagation on its own handlers does not
  // also stop us from seeing the event. Passive: we never preventDefault, so the
  // application behaves exactly as it would with nobody watching.
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('submit', onSubmit, true);
  window.addEventListener('pagehide', onUnload);

  timer = setInterval(function () { flush(false); }, flushMs);
  navTimer = setInterval(checkNavigation, 500);

  // The first event is where the journey starts.
  push({ kind: 'navigate' });
  (document.body || document.documentElement).appendChild(badge);
  paint();

  window.__blueeyeRecorder = { stop: function () { flush(true); teardown('stopped'); } };
}());
