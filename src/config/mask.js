'use strict';

// Shared masking for device-config data on its way out of the process — to
// Mistral (ask-context) or to an API response (config-history/context). Reuses
// the NIS2/flow-advisory principle: IP literals and secret-bearing config lines
// are redacted. Over-masking is intentional — better to drop signal than leak a
// credential.

const ANY_IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g;
function maskIps(s) {
  return typeof s === 'string' ? s.replace(ANY_IP_RE, '[host]') : s;
}

// Redacts the value of a secret-bearing config line from the keyword to EOL.
const SECRET_KEYWORD_RE =
  /(\b(?:password|passwd|secret|community|pre-shared-key|pre-shared|psk|credential|private-key|key-string|auth-key|wpa-psk)\b\s*[:= ]?\s*).+$/i;
function maskSecrets(line) {
  return typeof line === 'string' ? line.replace(SECRET_KEYWORD_RE, '$1[redacted]') : line;
}

// One changed config line, safe to forward: secrets then IPs masked.
function maskConfigLine(line) {
  return maskIps(maskSecrets(line));
}

// A whole config blob, line by line. Used when returning a (masked) snapshot.
function maskConfigText(text) {
  return typeof text === 'string' ? text.split('\n').map(maskConfigLine).join('\n') : text;
}

module.exports = { maskIps, maskSecrets, maskConfigLine, maskConfigText };
