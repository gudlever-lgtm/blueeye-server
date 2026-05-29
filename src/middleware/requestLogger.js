'use strict';

const { silentLogger } = require('../logger');

// Minimal, dependency-free request logger: one line per completed request.
// Uses the injected logger, so it is automatically silent under test.
function requestLogger(logger = silentLogger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info(
        `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`
      );
    });
    next();
  };
}

module.exports = { requestLogger };
