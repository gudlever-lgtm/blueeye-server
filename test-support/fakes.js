'use strict';

// Safety net: make sure a JWT secret exists before the app/config is loaded,
// in case a test file forgets to set one. Individual test files still set
// these at their very top to be explicit.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';

const { createApp } = require('../src/app');
const { issueToken } = require('../src/auth/jwt');

// ---- Repositories ---------------------------------------------------------

// A fake locations repository. Each method has a sensible default and can be
// overridden per test — e.g. point one at `throwingAsync()` to drive a 500.
function makeLocationsRepo(overrides = {}) {
  return {
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    create:
      overrides.create ||
      (async (input) => ({
        id: 1,
        ...input,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })),
    update: overrides.update || (async () => null),
    remove: overrides.remove || (async () => false),
  };
}

// A fake users repository.
function makeUsersRepo(overrides = {}) {
  return {
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    findByEmail: overrides.findByEmail || (async () => null),
    findByEmailWithHash: overrides.findByEmailWithHash || (async () => null),
    create:
      overrides.create ||
      (async (input) => ({
        id: 1,
        email: input.email,
        role: input.role,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })),
    update: overrides.update || (async () => null),
    remove: overrides.remove || (async () => false),
    countByRole: overrides.countByRole || (async () => 1),
  };
}

// A fake agents repository.
function makeAgentsRepo(overrides = {}) {
  return {
    findAll: overrides.findAll || (async () => []),
    findById: overrides.findById || (async () => null),
    updateManaged:
      overrides.updateManaged || (async (id, patch) => ({ id, ...patch })),
    remove: overrides.remove || (async () => false),
    setStatus: overrides.setStatus || (async () => {}),
    touchLastSeen: overrides.touchLastSeen || (async () => {}),
  };
}

// A fake agent-tokens repository.
function makeAgentTokensRepo(overrides = {}) {
  return {
    findActiveByHash: overrides.findActiveByHash || (async () => null),
    touchLastUsed: overrides.touchLastUsed || (async () => {}),
  };
}

// A fake results repository.
function makeResultsRepo(overrides = {}) {
  return {
    createMany: overrides.createMany || (async () => 0),
    findByAgentId: overrides.findByAgentId || (async () => []),
  };
}

// A fake enrollment-codes repository.
function makeEnrollmentCodesRepo(overrides = {}) {
  return {
    create:
      overrides.create ||
      (async ({ code, location_id, created_by }) => ({
        id: 1,
        code,
        location_id: location_id ?? null,
        created_by,
        expires_at: '2026-01-01T01:00:00.000Z',
        used_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
      })),
    findAll: overrides.findAll || (async () => []),
    remove: overrides.remove || (async () => false),
  };
}

// A fake enrollment store (the atomic claim-and-enroll operation).
function makeEnrollmentStore(overrides = {}) {
  return {
    claimAndEnroll:
      overrides.claimAndEnroll || (async () => ({ status: 'ok', agentId: 1 })),
  };
}

// A fake db with a ping() used by GET /health.
function makeDb(overrides = {}) {
  return {
    pool: overrides.pool || {},
    ping: overrides.ping || (async () => {}),
    close: overrides.close || (async () => {}),
  };
}

// A fake license manager (defaults to a healthy, generous license).
function makeLicenseManager(overrides = {}) {
  return {
    isLicensed: overrides.isLicensed || (() => true),
    getMaxAgents: overrides.getMaxAgents || (() => 1000),
    canAcceptNewConnection: overrides.canAcceptNewConnection || (() => true),
    getStatus:
      overrides.getStatus ||
      (() => ({ status: 'valid', licensed: true, maxAgents: 1000, serverId: 'test-server' })),
  };
}

// ---- App + auth helpers ---------------------------------------------------

// Builds an app wired with fakes; pass overrides to swap any dependency.
function makeApp(overrides = {}) {
  return createApp({
    db: overrides.db || makeDb(),
    locationsRepo: overrides.locationsRepo || makeLocationsRepo(),
    usersRepo: overrides.usersRepo || makeUsersRepo(),
    agentsRepo: overrides.agentsRepo || makeAgentsRepo(),
    enrollmentCodesRepo: overrides.enrollmentCodesRepo || makeEnrollmentCodesRepo(),
    enrollmentStore: overrides.enrollmentStore || makeEnrollmentStore(),
    agentTokensRepo: overrides.agentTokensRepo || makeAgentTokensRepo(),
    resultsRepo: overrides.resultsRepo || makeResultsRepo(),
    licenseManager: overrides.licenseManager || makeLicenseManager(),
  });
}

// Mints a real JWT for the given role (signed with the test secret).
function tokenFor(role, overrides = {}) {
  return issueToken({
    id: overrides.id ?? 1,
    email: overrides.email ?? `${role}@blueeye.local`,
    role,
  });
}

// Convenience: the value for an `Authorization` header.
function authHeader(role, overrides) {
  return `Bearer ${tokenFor(role, overrides)}`;
}

// Helper producing an async function that always rejects — to exercise the
// 500 / error-handler paths.
const throwingAsync = (message = 'simulated database failure') => async () => {
  throw new Error(message);
};

module.exports = {
  makeLocationsRepo,
  makeUsersRepo,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeResultsRepo,
  makeEnrollmentCodesRepo,
  makeEnrollmentStore,
  makeLicenseManager,
  makeDb,
  makeApp,
  tokenFor,
  authHeader,
  throwingAsync,
};
