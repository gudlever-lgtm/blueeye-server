import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The license cache persists the last *online-verified* validation to disk so
 * the offline grace period survives restarts. We store the signed token (not
 * just the parsed claims) so it can be re-verified against the embedded public
 * key on load — a tampered cache file is therefore rejected.
 */

export function readCache(path) {
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !obj ||
      typeof obj.signedLicense !== 'string' ||
      typeof obj.signature !== 'string' ||
      typeof obj.validatedAt !== 'number'
    ) {
      return null;
    }
    return obj;
  } catch {
    // missing / unreadable / corrupt → treat as no cache
    return null;
  }
}

export function writeCache(path, { signedLicense, signature, validatedAt }) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ signedLicense, signature, validatedAt }, null, 2)
    );
    return true;
  } catch (err) {
    console.error(`[license] failed to write cache: ${err.message}`);
    return false;
  }
}
