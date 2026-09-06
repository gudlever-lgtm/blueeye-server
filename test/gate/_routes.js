'use strict';

// Enumerates every route registered on an Express 4 app (methods + full mount
// path), so the gate suites can sweep the WHOLE HTTP surface instead of the
// routes someone remembered to list. Nested routers' mount prefixes are decoded
// from the layer regexp Express builds for `router.use('/prefix', ...)`.
function decodeMount(layer) {
  if (layer.regexp && layer.regexp.fast_slash) return '';
  let src = layer.regexp.source;
  src = src.replace(/^\^\\\//, '/').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\$$/, '');
  src = src.replace(/\\\//g, '/');
  let i = 0;
  src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${layer.keys[i++] ? layer.keys[i - 1].name : 'p'}`);
  return src;
}

function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) {
        if (m !== '_all') out.push({ method: m, path: (prefix + layer.route.path).replace(/\/\/+/g, '/') });
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, prefix + decodeMount(layer), out);
    }
  }
}

function listRoutes(app) {
  const out = [];
  walk(app._router.stack, '', out);
  const seen = new Map();
  for (const r of out) seen.set(`${r.method} ${r.path}`, r);
  return [...seen.values()];
}

const hasParam = (p) => /:[A-Za-z_]+/.test(p);
const fill = (p, id) => p.replace(/:[A-Za-z_]+\??/g, id).replace(/\/\/+/g, '/');
const key = (r) => `${r.method.toUpperCase()} ${r.path}`;

module.exports = { listRoutes, hasParam, fill, key };
