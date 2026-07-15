'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createUserMailer, renderTempPasswordEmail, formatExpiry } = require('../src/services/userMailer');

test('renderTempPasswordEmail includes the password, login link and expiry in the body only', () => {
  const { subject, text, html } = renderTempPasswordEmail({
    name: 'Ada',
    tempPassword: 'S3cret-Temp-Pw!23',
    loginUrl: 'https://blueeye.acme.dk',
    expiresAt: new Date('2026-07-17T14:30:00Z'),
  });
  assert.ok(subject.length > 0);
  // Password appears in the body...
  assert.ok(text.includes('S3cret-Temp-Pw!23'));
  assert.ok(html.includes('S3cret-Temp-Pw!23'));
  // ...but never inside the login URL (link carries no password).
  assert.ok(!/blueeye\.acme\.dk[^\s]*S3cret/.test(text));
  assert.ok(text.includes('https://blueeye.acme.dk'));
  assert.ok(text.includes('2026-07-17 14:30 UTC'));
  // Bilingual: Danish + English.
  assert.ok(/Engangs-adgangskode/.test(text));
  assert.ok(/One-time password/.test(text));
  assert.ok(text.includes('Ada'));
});

test('renderTempPasswordEmail works without a name or login url', () => {
  const { text } = renderTempPasswordEmail({ tempPassword: 'abc', loginUrl: '', expiresAt: null });
  assert.ok(text.includes('abc'));
  assert.ok(/browseren/.test(text)); // Danish fallback for the missing link
});

test('formatExpiry renders a stable UTC string and tolerates bad input', () => {
  assert.equal(formatExpiry(new Date('2026-01-02T03:04:05Z')), '2026-01-02 03:04 UTC');
  assert.equal(formatExpiry('not-a-date'), '');
});

test('sendTempPassword delivers via the injected transport', async () => {
  const sent = [];
  const mailer = createUserMailer({
    getEmailConfig: () => ({ from: 'blueeye@acme.dk', smtp: { host: 'smtp' } }),
    transport: { sendMail: async (m) => { sent.push(m); } },
  });
  const res = await mailer.sendTempPassword({
    to: 'user@acme.dk', name: 'Bo', tempPassword: 'pw12345', loginUrl: 'https://x', expiresAt: new Date(),
  });
  assert.deepEqual(res, { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'user@acme.dk');
  assert.equal(sent[0].from, 'blueeye@acme.dk');
  assert.ok(sent[0].text.includes('pw12345'));
});

test('sendTempPassword throws when no transport is configured', async () => {
  const mailer = createUserMailer({ getEmailConfig: () => ({ from: 'x', smtp: {} }) });
  await assert.rejects(
    () => mailer.sendTempPassword({ to: 'u@x', tempPassword: 'pw', loginUrl: '', expiresAt: null }),
    /no mail transport/
  );
});

test('sendTempPassword propagates a transport failure (so the caller can roll back)', async () => {
  const mailer = createUserMailer({
    getEmailConfig: () => ({ from: 'x', smtp: {} }),
    transport: { sendMail: async () => { throw new Error('smtp down'); } },
  });
  await assert.rejects(
    () => mailer.sendTempPassword({ to: 'u@x', tempPassword: 'pw', loginUrl: '', expiresAt: null }),
    /smtp down/
  );
});
