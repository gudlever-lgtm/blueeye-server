'use strict';

// What the shipped containers expose, and as whom they run. These are one-line
// settings that are easy to lose in a merge and expensive to lose in the field,
// so they are pinned here rather than left to review.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the dashboard port is published on loopback unless the operator says otherwise', () => {
  const compose = read('docker-compose.yml');
  // Published on 0.0.0.0 the server answers plain HTTP to anything that can
  // route to the host, proxy or no proxy.
  assert.match(compose, /\$\{SERVER_BIND_ADDR:-127\.0\.0\.1\}:\$\{SERVER_HOST_PORT:-3000\}:3000/,
    'the server port must default to a loopback bind');
  // MySQL has always been loopback-only; keep it that way.
  assert.match(compose, /"127\.0\.0\.1:\$\{DB_HOST_PORT:-3307\}:3306"/, 'MySQL must not be published to the LAN');
});

test('the server container does not run as root', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/entrypoint\.sh"\]/, 'the privilege drop runs from the entrypoint');
  assert.match(dockerfile, /chown -R node:node/, '/data must belong to the unprivileged user');

  const entrypoint = read('docker/entrypoint.sh');
  assert.match(entrypoint, /su-exec node:node|setpriv --reuid=1000/, 'the entrypoint must drop privileges');
  // The escape hatch exists, but it cannot be the quiet default.
  assert.match(entrypoint, /BLUEEYE_RUN_AS_ROOT/);
  assert.match(entrypoint, /WARNING: BLUEEYE_RUN_AS_ROOT=1/, 'running as root has to be loud');
  assert.match(read('Dockerfile'), /su-exec/, 'su-exec must be installed, or the drop silently falls through');
});

test('the service-assurance worker still drops privileges', () => {
  // It drives a browser against customer networks; it is the last container
  // that should be root.
  assert.match(read('docker/Dockerfile.service-test-worker'), /^USER blueeye$/m);
});

test('the server container cannot gain new privileges', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /no-new-privileges:true/);
});
