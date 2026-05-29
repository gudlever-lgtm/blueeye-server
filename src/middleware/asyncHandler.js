'use strict';

// Wraps an async route handler so that any rejected promise is forwarded to
// Express' error-handling middleware (Express 4 does not do this on its own).
// This is what turns an unexpected DB failure into a clean 500 response.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { asyncHandler };
