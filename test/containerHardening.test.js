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

// --- the Service Assurance worker's network ---------------------------------
//
// It is the one container that drives a browser at addresses a customer
// supplied. The host policy refuses loopback, link-local and the metadata
// address and allows only a per-application allowlist — but that check runs
// before Chromium resolves the name a second time, and nothing in an
// application can close that window entirely. The network is what makes the
// remainder unreachable: there is no route from here to BlueEye' own API,
// whatever a name resolves to.
//
// Parsed rather than regex-matched, because "is the worker on a network the
// server is also on" is a question about the graph, not about the text.
test('the worker is on a network the server and the licens signer are not', () => {
  const compose = read('docker-compose.yml');
  // A tiny reader for the two shapes this file uses: `networks: [a, b]`.
  const netsOf = (service) => {
    const block = compose.slice(compose.indexOf(`\n  ${service}:`));
    const next = block.slice(2).search(/\n  [a-z]/);
    const body = next === -1 ? block : block.slice(0, next + 2);
    const m = /\n    networks:\s*\[([^\]]*)\]/.exec(body);
    return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : ['default'];
  };

  const worker = netsOf('service-assurance-worker');
  assert.deepEqual(worker, ['assurance'], 'the worker must be on the isolated network only');

  for (const service of ['server', 'licens', 'agent']) {
    const nets = netsOf(service);
    assert.ok(!nets.includes('assurance'),
      `${service} shares a network with the browser worker (${nets.join(', ')})`);
  }
  // …and the database is reachable from both, because the worker genuinely
  // needs it. If this ever stops being true the worker cannot run at all,
  // which is a louder failure than a silent one.
  assert.deepEqual(netsOf('db').sort(), ['assurance', 'default']);
});

test('the browser worker runs with no capabilities and bounded resources', () => {
  const compose = read('docker-compose.yml');
  const block = compose.slice(compose.indexOf('\n  service-assurance-worker:'));
  const body = block.slice(0, block.indexOf('\nnetworks:'));
  // Chromium runs with --no-sandbox in a container, so it needs no capability
  // of its own — and a browser pointed at content this stack does not control
  // is the one workload that can be made to allocate without limit.
  assert.match(body, /cap_drop:\s*\n\s*- ALL/);
  assert.match(body, /no-new-privileges:true/);
  assert.match(body, /pids_limit:/);
  assert.match(body, /mem_limit:/);
});

test('Chromium still runs without a sandbox, which is why dropping caps is safe', () => {
  // If this flag ever goes away, cap_drop: ALL stops being free and the browser
  // will fail to start — better to fail this test than that container.
  assert.match(read('src/serviceTests/runner/driver.js'), /'--no-sandbox'/);
});
