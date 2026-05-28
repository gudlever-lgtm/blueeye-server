import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// On-disk cache of the last verified, valid license validation. Survives
// restarts so the server can keep running (within the grace period) when the
// license server is temporarily unreachable.

export function readCache(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeCache(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // directory may already exist
  }
  writeFileSync(path, JSON.stringify(data, null, 2));
}
