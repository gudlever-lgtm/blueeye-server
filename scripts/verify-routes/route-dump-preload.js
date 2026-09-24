'use strict';

// Preloaded (`node -r`) into the server that scripts/verify-routes-against-mysql.js
// boots. It changes NOTHING about how a request is handled: it only wraps
// express's app.listen so that, the moment the real app starts listening, every
// route it registered is written to the file named by VERIFY_ROUTES_DUMP.
//
// Why a preload rather than enumerating from test-support's fake app: which
// routers mount depends on which dependencies server.js wires, so the route list
// of the production app is only knowable from the production app.
const fs = require('fs');
const path = require('path');
const express = require(require.resolve('express', { paths: [path.join(__dirname, '..', '..')] }));
const { listRoutes } = require('../../test/gate/_routes');

const target = process.env.VERIFY_ROUTES_DUMP;
if (target) {
  const original = express.application.listen;
  express.application.listen = function listen(...args) {
    try {
      fs.writeFileSync(target, JSON.stringify(listRoutes(this)));
    } catch (err) {
      process.stderr.write(`verify-routes preload: could not dump routes (${err.message})\n`);
    }
    return original.apply(this, args);
  };
}
