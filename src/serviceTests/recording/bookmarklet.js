'use strict';

// The bookmarklet the operator drags to their bookmarks bar.
//
// WHY A BOOKMARKLET, and not a browser extension or a proxy: the operator must
// record on the real application, signed in as themselves, on their own machine.
// An extension needs installing and reviewing per browser; a recording proxy
// would mean BlueEye sitting in the middle of a live session with the
// customer's real traffic passing through it, which is exactly what the privacy
// rule forbids. A bookmarklet is one click, installs nothing, and the operator
// can read every character of it before they use it.
//
// What it does is deliberately the smallest possible thing: append ONE <script>
// tag pointing at BlueEye's own `/recorder.js`, carrying the endpoint and the
// capture token on the tag's dataset. No logic lives in the bookmarklet itself,
// so the recorder can be fixed server-side without every operator re-dragging a
// new bookmark.
//
// The limit, stated plainly because it will be met in the field: a site with a
// strict `script-src` Content-Security-Policy will refuse to load a script from
// another origin, and the bookmarklet will do nothing there. That is the site's
// policy working correctly. The fallback is to build the test in the designer.

const CAPTURE_MOUNT = '/api/service-capture';

// Only a sane host[:port] when deriving our own URL from the request, so a
// forged Host header cannot be reflected into something the operator clicks.
// Same rule, same reason, as the enrollment installer's server URL.
const SAFE_HOST_RE = /^[a-zA-Z0-9.\-:[\]]+$/;

function serverUrlOf(req) {
  const configured = req && req.app && req.app.get && req.app.get('publicUrl');
  if (configured) return String(configured).replace(/\/+$/, '');
  const host = (req && typeof req.get === 'function' && req.get('host')) || '';
  const proto = (req && req.protocol) || 'https';
  if (!SAFE_HOST_RE.test(host)) return '';
  return `${proto}://${host}`;
}

// The token is interpolated into a JavaScript string literal, so it must not be
// able to end that literal. It cannot — `start()` mints it as base64url — but
// the guard is here anyway, because the cost of being wrong is a script the
// operator pastes into their own browser on the customer's site.
const jsString = (value) => JSON.stringify(String(value == null ? '' : value));

function buildBookmarklet({ req, token, recorderSource = '' }) {
  const base = serverUrlOf(req);
  const captureUrl = `${base}${CAPTURE_MOUNT}`;
  const src = `${base}/recorder.js`;

  // The config goes in FIRST, as a global the recorder reads. It cannot ride on
  // `document.currentScript` here — there is no script element when the code is
  // the bookmarklet itself.
  const config = `window.__blueeyeRecorderConfig={endpoint:${jsString(captureUrl)},token:${jsString(token)}};`;

  const code = recorderSource
    ? `(function(){if(window.__blueeyeRecorder){window.__blueeyeRecorder.stop();return;}${config}${recorderSource}})();`
    // No recorder source wired (a host that did not supply it): fall back to the
    // tag, which at least works on a site with no CSP.
    : [
      '(function(){',
      'if(window.__blueeyeRecorder){window.__blueeyeRecorder.stop();return;}',
      'var s=document.createElement("script");',
      `s.src=${jsString(src)};`,
      `s.dataset.endpoint=${jsString(captureUrl)};`,
      `s.dataset.token=${jsString(token)};`,
      's.onerror=function(){alert("BlueEyes: the page blocked the recorder (Content-Security-Policy). Build the test in the designer instead.");};',
      '(document.body||document.documentElement).appendChild(s);',
      '})();',
    ].join('');

  return {
    capture_url: captureUrl,
    recorder_url: src,
    inline: !!recorderSource,
    // encodeURIComponent so the whole program survives being a URL: a bookmark
    // href is parsed as one, and an unescaped `#` would truncate it.
    bookmarklet: `javascript:${encodeURIComponent(code)}`,
  };
}

// The recorder's source, read once and cached. A path rather than a require:
// public/recorder.js is a browser script, not a module, and the module is handed
// the path by its host rather than reaching into the host's public directory —
// the same boundary rule as every other port.
function createRecorderSource({ path: scriptPath = null, fs = require('fs'), logger = null } = {}) {
  let cached = null;
  return () => {
    if (cached !== null) return cached;
    if (!scriptPath) { cached = ''; return cached; }
    try {
      cached = fs.readFileSync(scriptPath, 'utf8');
    } catch (err) {
      // The bookmarklet degrades to the script-tag form rather than failing to
      // build: a recording that works on sites without a CSP beats no recording.
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`Service Assurance: could not read the recorder script (${err.message}); the bookmarklet falls back to a script tag`);
      }
      cached = '';
    }
    return cached;
  };
}

module.exports = { buildBookmarklet, createRecorderSource, serverUrlOf, CAPTURE_MOUNT, SAFE_HOST_RE };
