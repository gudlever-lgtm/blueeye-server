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

function buildBookmarklet({ req, token }) {
  const base = serverUrlOf(req);
  const captureUrl = `${base}${CAPTURE_MOUNT}`;
  const src = `${base}/recorder.js`;
  const code = [
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
    // encodeURIComponent so the whole program survives being a URL: a bookmark
    // href is parsed as one, and an unescaped `#` would truncate it.
    bookmarklet: `javascript:${encodeURIComponent(code)}`,
  };
}

module.exports = { buildBookmarklet, serverUrlOf, CAPTURE_MOUNT, SAFE_HOST_RE };
