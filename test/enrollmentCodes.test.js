'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeEnrollmentCodesRepo,
  makeLocationsRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

const admin = () => authHeader('admin');
const operator = () => authHeader('operator');
const viewer = () => authHeader('viewer');

// ----------------------------------------------------- POST /enrollment-codes
test('POST /enrollment-codes returns 201 with the plaintext code (operator)', async () => {
  let createArgs;
  const enrollmentCodesRepo = makeEnrollmentCodesRepo({
    create: async (args) => {
      createArgs = args;
      return {
        id: 5,
        code: args.code,
        location_id: args.location_id ?? null,
        expires_at: '2026-01-01T01:00:00.000Z',
        created_at: '2026-01-01T00:00:00.000Z',
      };
    },
  });

  const res = await request(makeApp({ enrollmentCodesRepo }))
    .post('/enrollment-codes')
    .set('Authorization', operator())
    .send({});

  assert.equal(res.status, 201);
  assert.equal(res.body.id, 5);
  assert.ok(typeof res.body.code === 'string' && res.body.code.length > 0);
  // created_by is taken from the authenticated user (token id defaults to 1).
  assert.equal(createArgs.created_by, 1);
});

test('POST /enrollment-codes returns 400 when location_id does not exist', async () => {
  // Default locationsRepo.findById returns null -> location does not exist.
  const res = await request(makeApp())
    .post('/enrollment-codes')
    .set('Authorization', operator())
    .send({ location_id: 999 });

  assert.equal(res.status, 400);
  assert.equal(res.body.details.location_id, 'location_id does not reference an existing location');
});

test('POST /enrollment-codes accepts an existing location_id', async () => {
  const locationsRepo = makeLocationsRepo({ findById: async () => ({ id: 2, name: 'Aarhus' }) });

  const res = await request(makeApp({ locationsRepo }))
    .post('/enrollment-codes')
    .set('Authorization', operator())
    .send({ location_id: 2 });

  assert.equal(res.status, 201);
});

test('POST /enrollment-codes returns 400 for an invalid expiry', async () => {
  const res = await request(makeApp())
    .post('/enrollment-codes')
    .set('Authorization', operator())
    .send({ expiresInMinutes: -10 });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('POST /enrollment-codes without a token returns 401', async () => {
  const res = await request(makeApp()).post('/enrollment-codes').send({});
  assert.equal(res.status, 401);
});

test('POST /enrollment-codes as a viewer returns 403', async () => {
  const res = await request(makeApp())
    .post('/enrollment-codes')
    .set('Authorization', viewer())
    .send({});
  assert.equal(res.status, 403);
});

test('POST /enrollment-codes returns 500 when the repository throws', async () => {
  const enrollmentCodesRepo = makeEnrollmentCodesRepo({ create: throwingAsync() });
  const res = await request(makeApp({ enrollmentCodesRepo }))
    .post('/enrollment-codes')
    .set('Authorization', operator())
    .send({});
  assert.equal(res.status, 500);
});

// ------------------------------------------------------ GET /enrollment-codes
test('GET /enrollment-codes returns 200 with status, no plaintext code', async () => {
  const rows = [
    { id: 1, location_id: null, created_by: 1, expires_at: 'x', used_at: null, created_at: 'y', status: 'active' },
  ];
  const enrollmentCodesRepo = makeEnrollmentCodesRepo({ findAll: async () => rows });

  const res = await request(makeApp({ enrollmentCodesRepo }))
    .get('/enrollment-codes')
    .set('Authorization', operator());

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, rows);
  assert.equal(res.body[0].code, undefined); // never exposed in the list
});

test('GET /enrollment-codes returns 500 when the repository throws', async () => {
  const enrollmentCodesRepo = makeEnrollmentCodesRepo({ findAll: throwingAsync() });
  const res = await request(makeApp({ enrollmentCodesRepo }))
    .get('/enrollment-codes')
    .set('Authorization', operator());
  assert.equal(res.status, 500);
});

test('GET /enrollment-codes without a token returns 401', async () => {
  const res = await request(makeApp()).get('/enrollment-codes');
  assert.equal(res.status, 401);
});

test('GET /enrollment-codes as a viewer returns 403', async () => {
  const res = await request(makeApp()).get('/enrollment-codes').set('Authorization', viewer());
  assert.equal(res.status, 403);
});

// -------------------------------------------------- DELETE /enrollment-codes/:id
test('DELETE /enrollment-codes/:id returns 204 (admin)', async () => {
  const enrollmentCodesRepo = makeEnrollmentCodesRepo({ remove: async () => true });
  const res = await request(makeApp({ enrollmentCodesRepo }))
    .delete('/enrollment-codes/1')
    .set('Authorization', admin());
  assert.equal(res.status, 204);
});

test('DELETE /enrollment-codes/:id returns 404 when not found', async () => {
  const enrollmentCodesRepo = makeEnrollmentCodesRepo({ remove: async () => false });
  const res = await request(makeApp({ enrollmentCodesRepo }))
    .delete('/enrollment-codes/999')
    .set('Authorization', admin());
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Enrollment code not found');
});

test('DELETE /enrollment-codes/:id returns 400 for an invalid id', async () => {
  const res = await request(makeApp()).delete('/enrollment-codes/abc').set('Authorization', admin());
  assert.equal(res.status, 400);
});

test('DELETE /enrollment-codes/:id returns 500 when the repository throws', async () => {
  const enrollmentCodesRepo = makeEnrollmentCodesRepo({ remove: throwingAsync() });
  const res = await request(makeApp({ enrollmentCodesRepo }))
    .delete('/enrollment-codes/1')
    .set('Authorization', admin());
  assert.equal(res.status, 500);
});

test('DELETE /enrollment-codes/:id as an operator returns 403', async () => {
  const res = await request(makeApp())
    .delete('/enrollment-codes/1')
    .set('Authorization', operator());
  assert.equal(res.status, 403);
});

test('DELETE /enrollment-codes/:id without a token returns 401', async () => {
  const res = await request(makeApp()).delete('/enrollment-codes/1');
  assert.equal(res.status, 401);
});
