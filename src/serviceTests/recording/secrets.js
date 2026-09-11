'use strict';

// What counts as a secret field — the ONE definition, shared by the two places
// that have to agree about it:
//
//   recording/validate.js   the server-side scrubber, which decides what is
//                           allowed into the database at all
//   recording/translate.js  the translation, which decides whether a step
//                           carries a literal or a credential reference
//
// They used to carry a copy each, and the copies drifted: one looked at the
// element's visible LABEL and the other did not, so a field labelled
// "Adgangskode" with an innocuous id had its value stored. The visible label is
// usually the strongest signal a human has that a field is a password, so it is
// the one a scrubber can least afford to skip.
//
// Deliberately generous. A false positive costs one step the operator has to
// correct in the designer; a false negative puts a real password in the
// database, the version history and the audit log.

const SECRET_WORDS = /(^|[^a-z])(password|passwd|pwd|passphrase|secret|kodeord|adgangskode|pinkode)([^a-z]|$)/i;
const USERNAME_WORDS = /(^|[^a-z])(user|username|userid|login|email|e-mail|brugernavn|bruger|konto)([^a-z]|$)/i;

// Every piece of text that describes the field, joined. `target` is the hint bag
// the recorder produced — label, placeholder, accessible name, name, id.
function hintsOf(event) {
  if (!event || typeof event !== 'object') return '';
  const target = (event.target && typeof event.target === 'object') ? event.target : {};
  return [
    event.autocomplete, target.label, target.placeholder, target.name, target.id, target.text,
  ].filter(Boolean).join(' ').toLowerCase();
}

function isSecretField(event) {
  if (!event) return false;
  const type = String(event.inputType || '').toLowerCase();
  if (type === 'password') return true;
  return SECRET_WORDS.test(hintsOf(event));
}

// A username beside a password. Recording it as a literal would pin the test to
// one person's account; the credential reference lets the application's stored
// login drive it. A secret field is never also a username field — the check
// above wins, because "confirm password" contains neither word by accident.
function isUsernameField(event) {
  if (!event || isSecretField(event)) return false;
  const type = String(event.inputType || '').toLowerCase();
  if (type === 'email') return true;
  return USERNAME_WORDS.test(hintsOf(event));
}

module.exports = { isSecretField, isUsernameField, hintsOf, SECRET_WORDS, USERNAME_WORDS };
