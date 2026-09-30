// public/loadingBar.js — the 2px page-load line at the top of the viewport.
//
// Why it exists: every screen fetches on entry, several of them fetch four or
// five endpoints, and the dashboard gave no sign that anything was in flight.
// On a slow link the reader sees the previous screen's numbers and has no way
// to tell whether they are current or stale.
//
// The contract is two calls:
//
//   LoadingBar.start()   a request went out
//   LoadingBar.stop()    it came back (success or failure — always call it)
//
// app.js wires both around api(), so every fetch in the dashboard is covered
// by construction rather than by remembering.
//
// Three decisions worth keeping:
//
//   * DELAY. Nothing is drawn for the first 150 ms. Most calls here finish
//     well inside that, and a bar that flashes at every click is noise the
//     reader learns to ignore — which is the one thing a progress indicator
//     may not be.
//   * NO FAKE PROGRESS. The width is not a measurement; HTTP gives us no
//     fraction to report. It creeps towards 90% with a decaying step, so it
//     always moves and never arrives, then jumps to 100% when the last
//     request lands. A bar that sits at "80%" for six seconds teaches the
//     reader not to believe it.
//   * COUNTING. Parallel fetches are the normal case, so start/stop is a
//     counter, not a flag. Four calls out and one back must not clear it.
//
// Styling is .loading-bar in public/css/components.css; the colour is
// --loading in tokens.css.
//
// Dual export: window.LoadingBar (browser <script>) + module.exports (tests).

(function (root) {
  'use strict';

  // Not drawn at all below this — see DELAY above.
  var SHOW_AFTER_MS = 150;
  // How often the creep advances, and how much of the remaining distance to
  // 90% it eats each time. 8% of the remainder is slow enough to still be
  // moving after ten seconds.
  var CREEP_MS = 200;
  var CREEP_FRACTION = 0.08;
  var CREEP_MIN = 0.4;
  var CEILING = 90;
  // Long enough for the 100% dash plus its fade to finish before the width is
  // reset — resetting early would show the bar snapping back to zero.
  var RESET_AFTER_MS = 320;

  function create(doc) {
    var el = null;
    var fill = null;
    var pending = 0;
    var at = 0;
    var creep = null;
    var showTimer = null;
    var resetTimer = null;

    // Resolved lazily: the script loads before the element is parsed, and in
    // the jsdom boot test there may be no element at all.
    function nodes() {
      if (!el || !el.isConnected) {
        el = doc.getElementById('loading-bar');
        fill = el ? el.querySelector('span') : null;
      }
      return el && fill;
    }

    function paint() { if (fill) fill.style.width = at + '%'; }

    function show() {
      if (!nodes()) return;
      el.classList.remove('is-done');
      el.classList.add('is-on');
      el.removeAttribute('aria-hidden');
      at = 8;
      paint();
      creep = setInterval(function () {
        at += Math.max(CREEP_MIN, (CEILING - at) * CREEP_FRACTION);
        if (at > CEILING) at = CEILING;
        paint();
      }, CREEP_MS);
    }

    function hide() {
      if (creep) { clearInterval(creep); creep = null; }
      if (!nodes()) return;
      at = 100;
      paint();
      el.classList.remove('is-on');
      el.classList.add('is-done');
      el.setAttribute('aria-hidden', 'true');
      resetTimer = setTimeout(function () {
        resetTimer = null;
        // A new request may have started during the fade; leave it alone.
        if (pending || !nodes()) return;
        at = 0;
        // Width must snap back, not travel back: the reader would read a
        // right-to-left sweep as something else happening.
        var prev = fill.style.transition;
        fill.style.transition = 'none';
        paint();
        // Reading a layout property flushes the change before the transition
        // is restored, so the reset is not itself animated.
        void fill.offsetWidth;
        fill.style.transition = prev || '';
      }, RESET_AFTER_MS);
    }

    return {
      start: function () {
        pending += 1;
        if (pending !== 1 || showTimer || creep) return;
        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
        showTimer = setTimeout(function () {
          showTimer = null;
          if (pending) show();
        }, SHOW_AFTER_MS);
      },
      stop: function () {
        pending = Math.max(0, pending - 1);
        if (pending) return;
        if (showTimer) {
          // Finished inside the delay: it was never drawn, so there is
          // nothing to take down.
          clearTimeout(showTimer);
          showTimer = null;
          return;
        }
        hide();
      },
      // Tests and the "session ended" path: drop everything in flight.
      reset: function () {
        pending = 0;
        if (showTimer) { clearTimeout(showTimer); showTimer = null; }
        if (creep) { clearInterval(creep); creep = null; }
        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
        if (nodes()) {
          el.classList.remove('is-on', 'is-done');
          el.setAttribute('aria-hidden', 'true');
          at = 0;
          paint();
        }
      },
      // Exposed for the unit test — the counter is the part worth asserting.
      pending: function () { return pending; },
    };
  }

  var api = typeof document !== 'undefined'
    ? create(document)
    // No DOM (node --test importing the module): the calls must still be safe.
    : { start: function () {}, stop: function () {}, reset: function () {}, pending: function () { return 0; } };
  api.create = create;

  root.LoadingBar = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
