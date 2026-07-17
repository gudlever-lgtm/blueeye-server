'use strict';

// Validation for the runbooks admin API (Fase 3). Pure: returns
// { value } on success or { errors } (a field→message map) for a 400.

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

function validateRunbookInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};

  const findingType = str(b.findingType ?? b.finding_type);
  if (!findingType) errors.findingType = 'findingType is required';
  else if (findingType.length > 120) errors.findingType = 'findingType must be at most 120 characters';

  const title = str(b.title);
  if (!title) errors.title = 'title is required';
  else if (title.length > 200) errors.title = 'title must be at most 200 characters';

  const bodyMarkdown = typeof (b.bodyMarkdown ?? b.body_markdown) === 'string' ? (b.bodyMarkdown ?? b.body_markdown) : '';
  if (!bodyMarkdown.trim()) errors.bodyMarkdown = 'bodyMarkdown is required';

  let linkedPlaybookId = null;
  const raw = b.linkedPlaybookId ?? b.linked_playbook_id;
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) errors.linkedPlaybookId = 'linkedPlaybookId must be a positive integer or null';
    else linkedPlaybookId = n;
  }

  if (Object.keys(errors).length) return { errors };
  return { value: { findingType, title, bodyMarkdown, linkedPlaybookId } };
}

module.exports = { validateRunbookInput };
