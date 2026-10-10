'use strict';

const { silentLogger } = require('../logger');

// 404 handler — mounted after all routes. Any request that did not match a
// route lands here.
function notFoundHandler(req, res, next) { // eslint-disable-line no-unused-vars
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
}

// Central error handler. Express recognises error middleware by its arity, so
// the four-argument signature (incl. `next`) must be kept even though `next`
// is only used to delegate once headers are already sent.
function errorHandler({ logger = silentLogger } = {}) {
  return (err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }

    // Honour an explicit status (e.g. malformed JSON bodies set by
    // express.json(), or a 503 from a service that refused to act); everything
    // else is treated as an unexpected 500.
    const explicit = Number(err.statusCode || err.status) || 0;
    const status = explicit >= 400 && explicit < 600 ? explicit : 500;

    if (status >= 500) {
      // Prefer the per-request child logger (carries reqId) when present.
      (req.log || logger).error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
    }

    // A 5xx message is hidden unless the thrower marked it safe to show:
    // `expose` is how a deliberate refusal (a command that could not be signed,
    // say) tells the operator WHY, without leaking the detail of a crash.
    const body = {
      error: status < 500 || err.expose === true ? (err.message || 'Error') : 'Internal Server Error',
    };
    // Surface the underlying message off-production to aid debugging.
    if (status === 500 && process.env.NODE_ENV !== 'production') {
      body.detail = err.message;
    }

    res.status(status).json(body);
  };
}

module.exports = { notFoundHandler, errorHandler };
