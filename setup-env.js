// Test bootstrap: imported first by the suite so that config.js (evaluated when
// the src modules are imported) sees these API keys — one key per role. Kept at
// the repo root, with a name the test runner does not treat as a test file.
process.env.API_KEYS =
  'viewer-key:viewer,operator-key:operator,admin-key:admin';
