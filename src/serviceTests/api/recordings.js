'use strict';

const express = require('express');
const { asyncHandler, invalid, notFound, makeLoader, auditor, userId, parseId } = require('./helpers');
const { validateTest } = require('../validation');
const { requiresCredential } = require('../engine/validate');
const { validateRecordingStart, validateCaptureBatch } = require('../recording/validate');
const { translateRecording } = require('../recording/translate');
const { buildBookmarklet, CAPTURE_MOUNT } = require('../recording/bookmarklet');

// Recording — the operator performs the journey, BlueEye writes the test
// (V2 §1 "Recording", P1 #2).
//
// The surface is split in two on purpose, because the two halves have nothing in
// common but the table they share:
//
//   createRecordingsRouter        mounted INSIDE /api/service-tests, so it wears
//                                 the licence gate and the session auth every
//                                 other route wears. Operators start, review,
//                                 save and delete recordings here.
//
//   createRecordingsRouter.capture  mounted OUTSIDE that, at /api/service-capture.
//                                 Its caller is a script running on the CUSTOMER'S
//                                 site, in the operator's own browser, which has
//                                 no BlueEye session and cannot get one. Its only
//                                 authority is the capture token.
//
// Why the split is safe rather than a hole:
//   * a token exists only because an authorised operator started a recording, so
//     an unlicensed or unauthenticated install has no valid token anywhere;
//   * the token is stored as SHA-256 and matches only while the recording is
//     still `recording` and not expired — minutes, not forever;
//   * the capture routes can ONLY append observations to the one recording their
//     token names. There is no read, no list, and no way to reach another row.
//   * no credentials are accepted, so a browser never attaches a cookie: CORS is
//     opened for the origin, never for the session.

function createRecordingsRouter({ repositories, settings, audit, requireRole, roles }) {
  const router = express.Router();
  const { recordings, applications, tests, credentials } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const write = requireRole(roles.OPERATOR, roles.ADMIN);
  const load = makeLoader(recordings, 'Recording');
  const record = auditor(audit);

  // What the review screen gets: the recording, plus the definition the
  // translation currently produces from it. Translated on READ rather than
  // stored, so an improved translation improves recordings that already exist.
  const withPreview = (rec) => {
    const { definition, requires_credential: requiresCredential } = translateRecording(rec.events, {
      name: rec.name, baseUrl: rec.base_url,
    });
    // The raw observations are not part of the response. They are what the
    // translation reads; showing them would put every field the operator typed
    // on a screen that does not need them.
    const { events, ...rest } = rec;
    return { ...rest, definition, requires_credential: requiresCredential, step_count: definition.steps.length };
  };

  router.get('/', read, asyncHandler(async (req, res) => {
    const applicationId = req.query.application_id !== undefined ? parseId(req.query.application_id) : null;
    if (req.query.application_id !== undefined && applicationId === null) {
      return res.status(400).json({ error: 'Invalid application_id' });
    }
    const list = await recordings.list({ applicationId, status: req.query.status || null });
    return res.json(list.map(withPreview));
  }));

  router.post('/', write, asyncHandler(async (req, res) => {
    const { value, errors } = validateRecordingStart(req.body);
    if (errors) return invalid(res, errors);
    const app = await applications.findById(value.application_id);
    if (!app) return invalid(res, { application_id: 'that application does not exist' });

    const { recording, token } = await recordings.start({
      applicationId: app.id,
      name: value.name,
      baseUrl: app.base_url || null,
      createdBy: userId(req),
      ttlMs: (value.ttl_minutes || 30) * 60000,
    });
    record(req, 'recording_start', recording.id, `app=${app.id} name=${recording.name}`);

    // The token is returned exactly once, here. Nothing can read it back — the
    // table holds only its hash — so an operator who loses the bookmarklet
    // starts a new recording rather than recovering this one.
    return res.status(201).json({
      ...withPreview(recording),
      token,
      ...buildBookmarklet({ req, token }),
    });
  }));

  router.get('/:id', read, asyncHandler(async (req, res) => {
    const rec = await load(req, res);
    if (!rec) return undefined;
    return res.json(withPreview(rec));
  }));

  router.post('/:id/stop', write, asyncHandler(async (req, res) => {
    const rec = await load(req, res);
    if (!rec) return undefined;
    const stopped = await recordings.stop(rec.id);
    record(req, 'recording_stop', rec.id, `events=${rec.event_count}`);
    return res.json(withPreview(stopped || rec));
  }));

  // Turning a recording into a test. This is where the recording stops being a
  // recording: the definition goes through the SAME validator every hand-built
  // test goes through, so a recorded test cannot be saved in a shape the
  // designer could not have produced and the runner could not execute.
  router.post('/:id/accept', write, asyncHandler(async (req, res) => {
    const rec = await load(req, res);
    if (!rec) return undefined;
    if (rec.status === 'accepted') return invalid(res, { _: 'that recording has already been saved as a test' });

    const { definition } = translateRecording(rec.events, { name: rec.name, baseUrl: rec.base_url });
    // A recording with nothing in it is not a test. The designer must not offer
    // "save" here at all — this is the second line of defence, not the first.
    if (!definition.steps.length) {
      return invalid(res, { steps: 'that recording captured no steps' });
    }
    const name = typeof req.body === 'object' && req.body && typeof req.body.name === 'string' && req.body.name.trim()
      ? req.body.name.trim().slice(0, 120)
      : rec.name;
    const credentialId = req.body && req.body.credential_id !== undefined ? parseId(req.body.credential_id) : null;

    const runner = await settings.get('runner');
    const { value, errors } = validateTest({
      application_id: rec.application_id,
      name,
      definition: { ...definition, name },
      credential_id: credentialId,
    }, { maxSteps: runner.maxStepsPerTest });
    if (errors) return invalid(res, errors);

    // The SAME credential rule POST /tests applies, for the same reason: a
    // recorded login journey carries {{credential.password}}, and saving it
    // without a login selected produces a test that runs and types the
    // placeholder into the password box. Failing here, where the operator is
    // looking at the recording, beats a confusing red run tomorrow.
    const credentialError = await checkCredential({ ...value, application_id: rec.application_id });
    if (credentialError) return invalid(res, credentialError);

    const created = await tests.create({ ...value, created_by: userId(req) });
    await recordings.accept(rec.id, created.id);
    record(req, 'recording_accept', rec.id, `test=${created.id} steps=${definition.steps.length}`);
    return res.status(201).json(created);
  }));

  router.delete('/:id', write, asyncHandler(async (req, res) => {
    const rec = await load(req, res);
    if (!rec) return undefined;
    await recordings.remove(rec.id);
    record(req, 'recording_delete', rec.id, `events=${rec.event_count}`);
    return res.status(204).end();
  }));

  // Mirrors src/serviceTests/api/tests.js. Duplicated rather than shared because
  // the two routers are separate seams onto the same rule; if a third appears,
  // lift it into engine/validate.js rather than growing a third copy.
  async function checkCredential(test) {
    if (!test.definition || !requiresCredential(test.definition)) return null;
    if (!test.credential_id) {
      return { credential_id: 'this journey signs in, so it needs a login selected' };
    }
    const cred = await credentials.findById(test.credential_id);
    if (!cred) return { credential_id: 'that login does not exist' };
    if (test.application_id && cred.application_id !== test.application_id) {
      return { credential_id: 'that login belongs to a different application' };
    }
    if (!cred.has_secret) return { credential_id: 'that login has no password stored' };
    return null;
  }

  return router;
}

// The ingest half. Mounted outside the session gate — see the header above for
// why that is the token's job and not a gap.
function createRecordingsCaptureRouter({ repositories, logger = null, rateLimit = null } = {}) {
  const router = express.Router();
  const { recordings } = repositories;

  // CORS for the capture routes only, as MIDDLEWARE rather than an OPTIONS
  // route: the origin is the customer's own site, which we do not know in
  // advance and have no business enumerating. What makes that safe is the line
  // below it — credentials are never allowed, so a browser attaches no cookie
  // and the capture token stays the only authority on the request.
  router.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
    res.set('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });
  if (typeof rateLimit === 'function') router.use(rateLimit);

  // Resolves the recording this request may write to, or answers 401.
  //
  // 401 for a token that is missing, unknown, expired OR already stopped — one
  // answer for all four, so the endpoint does not tell a caller holding a guess
  // which part of the guess was right.
  async function resolve(req, res) {
    const token = req.body && typeof req.body.token === 'string' ? req.body.token.trim() : '';
    if (!token || token.length > 128) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    const rec = await recordings.findByToken(token);
    if (!rec) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return rec;
  }

  router.post('/events', asyncHandler(async (req, res) => {
    const rec = await resolve(req, res);
    if (!rec) return undefined;
    const { value, errors } = validateCaptureBatch(req.body);
    if (errors) return invalid(res, errors);

    const updated = value.events.length ? await recordings.appendEvents(rec.id, value.events) : rec;
    if (logger && typeof logger.info === 'function' && value.events.length) {
      // The COUNT, never the content. What the operator typed is the one thing
      // this whole path exists to keep out of the logs.
      logger.info(`Service Assurance: recording ${rec.id} captured ${value.events.length} event(s)`);
    }
    // The recorder reads `status` to know it has been stopped from the
    // dashboard — that is why it polls at all.
    return res.json({
      ok: true,
      status: (updated || rec).status,
      event_count: (updated || rec).event_count,
      expires_at: (updated || rec).expires_at,
    });
  }));

  router.post('/stop', asyncHandler(async (req, res) => {
    const rec = await resolve(req, res);
    if (!rec) return undefined;
    const stopped = await recordings.stop(rec.id);
    return res.json({ ok: true, status: (stopped || rec).status, event_count: (stopped || rec).event_count });
  }));

  return router;
}

createRecordingsRouter.capture = createRecordingsCaptureRouter;

module.exports = { createRecordingsRouter, createRecordingsCaptureRouter, CAPTURE_MOUNT };
