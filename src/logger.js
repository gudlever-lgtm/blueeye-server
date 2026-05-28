'use strict';

// A no-op logger. Used as the default in createApp() so that unit tests stay
// quiet, while the running server (src/server.js) injects `console`.
const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

module.exports = { silentLogger };
