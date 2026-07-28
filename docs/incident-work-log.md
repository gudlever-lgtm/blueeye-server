# Incident work log (shift handover)

Intermittent faults run across several shifts. Before this, nothing survived the
handover — so every shift started from zero, and the same theory got tested three
times by three different people.

This is the log that fixes that. It hangs off `incident_cases` (the incident an
operator actually works), and it is **append-only**.

## What was there before — and why none of it worked

| Existing field | Why it is not a work log |
| --- | --- |
| `agents.notes` | Overwritten on every `PUT /agents/:id`. One value, no history, no author. |
| `incident_clusters.resolution_note` | Written once, at resolve time. Says how it ended, not what was tried. |
| `findings.acked` | A boolean. No author, no timestamp, no reason. |
| Reopen comment | Lands in `audit_log.detail` only, and only on a reopen. Not queryable as a log. |
| `investigations.narrative` | AI-generated prose about one run. Not an operator's record. |

## The three kinds

| `kind` | Means | Rendered |
| --- | --- | --- |
| `observation` | Something the operator saw | In the chronological log |
| `action` | Something the operator changed or ran | In the chronological log |
| `ruled_out` | A cause the operator has **excluded** | **Pinned above the log**, and in it |

`ruled_out` is why the table exists. It gets its own index
(`idx_incident_notes_ruled_out`) and its own array in the API response, so
"what has already been disproved?" is one cheap query — and so exclusions can
never be the rows that fall off the read cap.

`kind` is **never defaulted**. An operator writing "ruled out the switch" that
silently stored as an observation would defeat the pinned list, so an omitted
`kind` is a 400, not a guess.

## API

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/incidents/:id/notes` | viewer+ | `{ incidentId, notes[], ruledOut[], total }`. `notes` is **oldest-first** — a handover reads forward. |
| `POST` | `/api/incidents/:id/notes` | operator+ | Body `{ text, kind }`. `201` with the stored note. |

There is no `PATCH` and no `DELETE`, on purpose — see below.

Status codes: `400` (empty/oversized `text`, invalid or missing `kind`, non-numeric
id), `401` (no token), `403` (viewer writing), `404` (unknown incident, or the
routes are absent pre-migration), `500` (DB failure — clean, no stack).

## Append-only is structural, not a policy

Three layers, so no single oversight can undo it:

1. **The table** has no `updated_at`, no `edited_by`, no soft-delete column.
2. **The repository** (`src/repositories/incidentNotesRepository.js`) exports
   `append` + reads and nothing else. There is no `update()` to call. A test
   asserts the absence of every mutation-shaped method name.
3. **The router** mounts only `GET` and `POST`. A test asserts that
   `PATCH`/`PUT`/`DELETE` on the notes paths return 404.

A correction is a new entry. That is the desirable outcome anyway: the next shift
needs to see that something *was* believed and then revised, not a tidied-up
final answer with the reasoning removed.

## Audit

Every append writes `incident_note_append` to the hash-chained `audit_log`
(migration 041) through `complianceLogger`. The note **text is not copied** into
the audit detail — the note row is the record, and duplicating operator prose
into a trail where it can never be corrected would be the wrong place for it. The
chain records that an entry of a given kind was appended, by whom, and how long
it was.

The audit logger is fail-safe: if the audit backend is down, the operator's entry
still lands. A test covers this, and a second test proves the chain still verifies
(and still detects tampering) after notes are written.

## Author survives user deletion

`author_user_id` is `ON DELETE SET NULL`, with `author_email` / `author_role`
denormalised alongside it — the same trick `audit_log` uses. Someone leaving the
company must not take the incident history with them.

## Files

- Migration `migrations/072_create_incident_notes.sql`
- Repository `src/repositories/incidentNotesRepository.js`
- Validation `src/validation/incidentNoteValidation.js`
- Routes — in `src/routes/incidents.js` (mounted only when the repo is wired)
- Fake `makeIncidentNotesRepo` in `test-support/fakes.js`
- UI — `incidentNotesCard()` / `noteComposer()` in `public/app.js`, `.wl-*` CSS
- Tests `test/incidentNotes.test.js`

## Graceful degradation

The notes routes are mounted only when `incidentNotesRepo` is injected. A
deployment that has not yet run migration 072 keeps serving the rest of the
incident API instead of 500-ing on a missing table; the routes return 404 until
the migration lands.
