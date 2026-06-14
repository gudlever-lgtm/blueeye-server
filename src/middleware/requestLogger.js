'use strict';

const crypto = require('crypto');
const { silentLogger } = require('../logger');

// Minimal, dependency-free request logger: one line per completed request.
// Uses the injected logger, so it is automatically silent under test.
//
// It also mints a short per-request correlation id (`req.id`), echoes it as the
// `X-Request-Id` response header, and binds it onto a child logger — so the
// request line, and any error logged for this request, share one id an operator
// can grep for. A client-supplied X-Request-Id is honoured (trusted-proxy chains).
function requestLogger(logger = silentLogger) {
  return (req, res, next) => {
    const supplied = req.headers['x-request-id'];
    req.id = (typeof supplied === 'string' && supplied.trim())
      ? supplied.trim().slice(0, 64)
      : crypto.randomUUID().slice(0, 8);
    res.setHeader('X-Request-Id', req.id);
    // A per-request logger carrying the id; routes/errorHandler can use req.log.
    req.log = typeof logger.child === 'function' ? logger.child({ reqId: req.id }) : logger;

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      req.log.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  };
}

module.exports = { requestLogger };
