'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// API tests for the incident work log (Fase 3):
//   GET  /api/incidents/:id/notes   viewer+
//   POST /api/incidents/:id/notes   operator+
//
// Covers 201/400/403/404/500 per the repo convention, the append-only guarantee,
// the separately-served ruled_out list, and that the hash-chained audit log
// stays verifiable after a note is written.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeIncidentCasesRepo,
  makeIncidentNotesRepo,
  makeAuditLogRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

const { createAuditLogRepository } = require('../src/repositories/auditLogRepository');
const { createAuditLogger } = require('../src/services/complianceLogger');

// An incident_cases fake seeded with one open incident (id 1).
function seededCases() {
  const repo = makeIncidentCasesRepo();
  repo.rows.push({
    id: 1,
    host_id: 'agent-7',
    title: 'Packet loss on agent-7',
    status: 'open',
    severity: 'CRIT',
    primary_finding_id: null,
    config_change_id: null,
    first_event_at: new Date('2026-07-27T09:00:00Z'),
    last_event_at: new Date('2026-07-27T09:30:00Z'),
    resolved_at: null,
    created_by: 'system',
    closed_by: null,
    created_at: new Date('2026-07-27T09:00:00Z'),
  });
  return repo;
}

function appWith(overrides = {}) {
  return makeApp({ incidentCasesRepo: seededCases(), ...overrides });
}

const post = (app, role, body, id = 1) =>
  request(app).post(`/api/incidents/${id}/notes`).set('Authorization', authHeader(role)).send(body);

const get = (app, role, id = 1) =>
  request(app).get(`/api/incidents/${id}/notes`).set('Authorization', authHeader(role));

// ------------------------------------------------------------------ POST 201
test('POST /notes returns 201 for each valid kind', async () => {
  for (const kind of ['observation', 'action', 'ruled_out']) {
    const app = appWith();
    const res = await post(app, 'operator', { text: `a ${kind} entry`, kind });
    assert.equal(res.status, 201, `kind ${kind} should be accepted`);
    assert.equal(res.body.note.kind, kind);
    assert.equal(res.body.note.text, `a ${kind} entry`);
    assert.equal(res.body.note.incidentCaseId, 1);
  }
});

test('POST /notes stamps the author and a timestamp on every entry', async () => {
  const app = appWith();
  const res = await post(app, 'operator', { text: 'checked the uplink', kind: 'observation' });

  assert.equal(res.status, 201);
  assert.equal(res.body.note.authorEmail, 'operator@blueeye.local');
  assert.equal(res.body.note.authorRole, 'operator');
  assert.equal(res.body.note.author, 'operator@blueeye.local');
  assert.ok(res.body.note.createdAt, 'expected a createdAt timestamp');
  assert.ok(!Number.isNaN(Date.parse(res.body.note.createdAt)));
});

test('POST /notes trims surrounding whitespace before storing', async () => {
  const app = appWith();
  const res = await post(app, 'operator', { text: '   swapped the SFP   ', kind: 'action' });
  assert.equal(res.status, 201);
  assert.equal(res.body.note.text, 'swapped the SFP');
});

test('admin may write as well as operator', async () => {
  const res = await post(appWith(), 'admin', { text: 'escalated', kind: 'action' });
  assert.equal(res.status, 201);
});

// ------------------------------------------------------------------- POST 400
test('POST /notes returns 400 for empty text', async () => {
  const app = appWith();
  for (const text of ['', '   ', '\n\t ']) {
    const res = await post(app, 'operator', { text, kind: 'observation' });
    assert.equal(res.status, 400, `text ${JSON.stringify(text)} should be rejected`);
    assert.match(res.body.details.join(' '), /text must not be empty/);
  }
});

test('POST /notes returns 400 for a missing or non-string text', async () => {
  const app = appWith();
  assert.equal((await post(app, 'operator', { kind: 'observation' })).status, 400);
  assert.equal((await post(app, 'operator', { text: 42, kind: 'observation' })).status, 400);
  assert.equal((await post(app, 'operator', { text: null, kind: 'observation' })).status, 400);
});

test('POST /notes returns 400 for an invalid kind', async () => {
  const app = appWith();
  const res = await post(app, 'operator', { text: 'something', kind: 'guess' });
  assert.equal(res.status, 400);
  assert.match(res.body.details.join(' '), /kind must be one of/);
});

test('POST /notes returns 400 when kind is omitted — it is never defaulted', async () => {
  // A "ruled out" entry silently stored as an observation would defeat the
  // pinned exclusion list, so an omitted kind must fail loudly.
  const res = await post(appWith(), 'operator', { text: 'not the switch' });
  assert.equal(res.status, 400);
  assert.match(res.body.details.join(' '), /kind must be one of/);
});

test('POST /notes returns 400 for text beyond the column limit', async () => {
  const res = await post(appWith(), 'operator', { text: 'x'.repeat(4001), kind: 'observation' });
  assert.equal(res.status, 400);
  assert.match(res.body.details.join(' '), /at most 4000 characters/);
});

test('POST /notes returns 400 for a non-numeric incident id', async () => {
  const res = await request(appWith())
    .post('/api/incidents/abc/notes')
    .set('Authorization', authHeader('operator'))
    .send({ text: 'x', kind: 'observation' });
  assert.equal(res.status, 400);
});

// --------------------------------------------------------------- POST 401/403
test('POST /notes returns 401 without a token', async () => {
  const res = await request(appWith()).post('/api/incidents/1/notes').send({ text: 'x', kind: 'action' });
  assert.equal(res.status, 401);
});

test('POST /notes returns 403 when a viewer tries to write', async () => {
  const res = await post(appWith(), 'viewer', { text: 'x', kind: 'observation' });
  assert.equal(res.status, 403);
});

test('a rejected viewer write leaves the log untouched', async () => {
  const incidentNotesRepo = makeIncidentNotesRepo();
  const app = appWith({ incidentNotesRepo });
  await post(app, 'viewer', { text: 'should not land', kind: 'observation' });
  assert.equal(incidentNotesRepo.rows.length, 0);
});

// ------------------------------------------------------------------- POST 404
test('POST /notes returns 404 for an unknown incident id', async () => {
  const res = await post(appWith(), 'operator', { text: 'x', kind: 'action' }, 9999);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Incident not found');
});

test('POST /notes validates the body before checking the incident exists', async () => {
  // A bad body is the caller's fault regardless of which incident they meant;
  // reporting 400 first keeps the error actionable.
  const res = await post(appWith(), 'operator', { text: '', kind: 'nope' }, 9999);
  assert.equal(res.status, 400);
});

// ------------------------------------------------------------------- POST 500
test('POST /notes returns 500 (clean, no stack) when the repo throws', async () => {
  const incidentNotesRepo = makeIncidentNotesRepo({ append: throwingAsync() });
  const res = await post(appWith({ incidentNotesRepo }), 'operator', { text: 'x', kind: 'action' });

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  // No stack trace, ever — off-production the handler adds `detail` with the
  // message (see errorHandler), but never frames.
  assert.ok(!/at Object|at async|\.js:\d+:\d+/.test(JSON.stringify(res.body)), 'must not leak a stack trace');
});

test('POST /notes 500 hides the underlying message in production', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const incidentNotesRepo = makeIncidentNotesRepo({ append: throwingAsync() });
    const res = await post(appWith({ incidentNotesRepo }), 'operator', { text: 'x', kind: 'action' });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Internal Server Error' });
    assert.ok(!/simulated database failure/.test(JSON.stringify(res.body)));
  } finally {
    process.env.NODE_ENV = prev;
  }
});

// ------------------------------------------------------------------- GET 200
test('GET /notes returns the log chronologically (oldest first)', async () => {
  const app = appWith();
  await post(app, 'operator', { text: 'first', kind: 'observation' });
  await post(app, 'operator', { text: 'second', kind: 'action' });
  await post(app, 'operator', { text: 'third', kind: 'observation' });

  const res = await get(app, 'viewer');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.notes.map((n) => n.text), ['first', 'second', 'third']);
  assert.equal(res.body.total, 3);
});

test('GET /notes serves ruled_out as its own list as well as in the log', async () => {
  const app = appWith();
  await post(app, 'operator', { text: 'link looks clean', kind: 'observation' });
  await post(app, 'operator', { text: 'not the SFP', kind: 'ruled_out' });
  await post(app, 'operator', { text: 'restarted bgpd', kind: 'action' });
  await post(app, 'operator', { text: 'not DNS', kind: 'ruled_out' });

  const res = await get(app, 'viewer');
  assert.equal(res.status, 200);
  assert.equal(res.body.notes.length, 4);
  assert.deepEqual(res.body.ruledOut.map((n) => n.text), ['not the SFP', 'not DNS']);
  assert.ok(res.body.ruledOut.every((n) => n.kind === 'ruled_out'));
});

test('GET /notes returns an empty log (not 404) for an incident with no entries', async () => {
  const res = await get(appWith(), 'viewer');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.notes, []);
  assert.deepEqual(res.body.ruledOut, []);
  assert.equal(res.body.total, 0);
});

test('viewer may read the work log', async () => {
  assert.equal((await get(appWith(), 'viewer')).status, 200);
});

test('GET /notes returns 401 without a token', async () => {
  assert.equal((await request(appWith()).get('/api/incidents/1/notes')).status, 401);
});

test('GET /notes returns 404 for an unknown incident and 400 for a bad id', async () => {
  assert.equal((await get(appWith(), 'viewer', 9999)).status, 404);
  const bad = await request(appWith()).get('/api/incidents/abc/notes').set('Authorization', authHeader('viewer'));
  assert.equal(bad.status, 400);
});

test('GET /notes returns 500 (clean) when the repo throws', async () => {
  const incidentNotesRepo = makeIncidentNotesRepo({ listForIncident: throwingAsync() });
  const res = await get(appWith({ incidentNotesRepo }), 'viewer');
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  assert.ok(!/at Object|at async|\.js:\d+:\d+/.test(JSON.stringify(res.body)), 'must not leak a stack trace');
});

test('GET /notes returns 500 when the ruled-out query alone fails', async () => {
  // The three reads run in parallel; a failure in any one of them must surface
  // as a clean 500 rather than a half-rendered log missing its exclusions.
  const incidentNotesRepo = makeIncidentNotesRepo({ listRuledOut: throwingAsync() });
  const res = await get(appWith({ incidentNotesRepo }), 'viewer');
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

// ------------------------------------------------------------- append-only
test('the work log exposes no edit or delete route', async () => {
  const app = appWith();
  const created = await post(app, 'operator', { text: 'original', kind: 'observation' });
  const noteId = created.body.note.id;

  for (const [method, path] of [
    ['patch', `/api/incidents/1/notes/${noteId}`],
    ['put', `/api/incidents/1/notes/${noteId}`],
    ['delete', `/api/incidents/1/notes/${noteId}`],
    ['delete', '/api/incidents/1/notes'],
  ]) {
    const res = await request(app)[method](path)
      .set('Authorization', authHeader('admin'))
      .send({ text: 'rewritten', kind: 'action' });
    assert.equal(res.status, 404, `${method.toUpperCase()} ${path} must not exist`);
  }

  // And the entry is unchanged.
  const after = await get(app, 'viewer');
  assert.deepEqual(after.body.notes.map((n) => n.text), ['original']);
});

test('the notes repository surface has no mutation methods', async () => {
  // Structural guarantee: append-only is enforced by what the module exports,
  // not only by which routes are mounted.
  const repo = makeIncidentNotesRepo();
  for (const forbidden of ['update', 'remove', 'delete', 'destroy', 'edit', 'upsert']) {
    assert.equal(typeof repo[forbidden], 'undefined', `repo must not expose ${forbidden}()`);
  }
});

// --------------------------------------------------------------------- audit
test('appending a note writes to the audit log without copying the note text', async () => {
  const auditLogRepo = makeAuditLogRepo();
  const app = appWith({ auditLogRepo, auditLogger: createAuditLogger({ auditLogRepo }) });

  await post(app, 'operator', { text: 'secret-sounding operator prose', kind: 'ruled_out' });

  const entry = auditLogRepo.rows.find((r) => r.action === 'incident_note_append');
  assert.ok(entry, 'expected an incident_note_append audit entry');
  assert.equal(entry.category, 'incident');
  assert.equal(entry.target, '1');
  assert.equal(entry.actorEmail, 'operator@blueeye.local');
  assert.match(entry.detail, /^ruled_out note #\d+ \(\d+ chars\)$/);
  // The note row is the record; free text must not be duplicated into a trail
  // where it can never be corrected.
  assert.ok(!/secret-sounding operator prose/.test(entry.detail));
});

test('the hash chain stays verifiable after notes are appended', async () => {
  // Real audit repository over a minimal fake pool, so the prev_hash/entry_hash
  // chain is actually computed rather than stubbed.
  const rows = [];
  let seq = 0;
  const pool = {
    query: async (sql, params = []) => {
      if (/ORDER BY id DESC LIMIT 1/.test(sql)) {
        const last = rows[rows.length - 1];
        return [last ? [{ entry_hash: last.entry_hash }] : []];
      }
      if (/^\s*INSERT INTO audit_log/.test(sql)) {
        const [category, action, outcome, actor_user_id, actor_email, actor_role, target, detail, ip, prev_hash, entry_hash] = params;
        const row = { id: (seq += 1), category, action, outcome, actor_user_id, actor_email, actor_role, target, detail, ip, prev_hash, entry_hash };
        rows.push(row);
        return [{ insertId: row.id }];
      }
      if (/WHERE entry_hash IS NOT NULL ORDER BY id ASC/.test(sql)) {
        return [rows.filter((r) => r.entry_hash != null)];
      }
      return [[]];
    },
  };
  const auditLogRepo = createAuditLogRepository({ pool });
  const app = appWith({ auditLogRepo, auditLogger: createAuditLogger({ auditLogRepo }) });

  await post(app, 'operator', { text: 'first entry', kind: 'observation' });
  await post(app, 'operator', { text: 'second entry', kind: 'ruled_out' });
  await post(app, 'operator', { text: 'third entry', kind: 'action' });

  const noteRows = rows.filter((r) => r.action === 'incident_note_append');
  assert.equal(noteRows.length, 3);
  assert.ok(noteRows.every((r) => r.entry_hash), 'every note entry must be hashed');

  const verdict = await auditLogRepo.verifyChain();
  assert.equal(verdict.ok, true, 'chain must verify after note writes');
  assert.equal(verdict.brokenAt, null);

  // And tampering is still detected — proving the check above is meaningful.
  noteRows[1].detail = 'tampered';
  const broken = await auditLogRepo.verifyChain();
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAt, noteRows[1].id);
});

test('a failing audit logger does not break the note write', async () => {
  // complianceLogger is fail-safe by design: the operator's entry must land even
  // if the audit backend is down.
  const auditLogRepo = makeAuditLogRepo({ record: throwingAsync('audit down') });
  const incidentNotesRepo = makeIncidentNotesRepo();
  const app = appWith({ auditLogRepo, auditLogger: createAuditLogger({ auditLogRepo }), incidentNotesRepo });

  const res = await post(app, 'operator', { text: 'still recorded', kind: 'observation' });
  assert.equal(res.status, 201);
  assert.equal(incidentNotesRepo.rows.length, 1);
});

// ------------------------------------------------------- graceful degradation
test('the notes routes are absent when no notes repo is wired (pre-migration)', async () => {
  // An older deployment that has not run migration 072 should keep serving the
  // rest of the incident API rather than 500 on a missing table.
  const app = makeApp({ incidentCasesRepo: seededCases(), incidentNotesRepo: null });

  assert.equal((await get(app, 'viewer')).status, 404);
  assert.equal((await post(app, 'operator', { text: 'x', kind: 'action' })).status, 404);
  // The rest of the incident API still works.
  const list = await request(app).get('/api/incidents').set('Authorization', authHeader('viewer'));
  assert.equal(list.status, 200);
});
