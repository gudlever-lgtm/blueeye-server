'use strict';

const { silentLogger } = require('../logger');
const { config } = require('../config');

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

    // Honour an explicit client-error status (e.g. malformed JSON bodies set
    // by express.json()); everything else is treated as an unexpected 500.
    const explicit = Number(err.statusCode || err.status) || 0;
    const status = explicit >= 400 && explicit < 500 ? explicit : 500;

    if (status >= 500) {
      logger.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
    }

    const body = {
      error: status === 500 ? 'Internal Server Error' : err.message || 'Error',
    };
    // Surface the underlying message off-production to aid debugging.
    if (status === 500 && config.env !== 'production') {
      body.detail = err.message;
    }

    res.status(status).json(body);
  };
}

module.exports = { notFoundHandler, errorHandler };
