'use strict';

// The ladder registry, and the one walk that drives every ladder in it.
//
// A ladder is an ordered list of rungs, an evaluator per rung, and a rule for
// reading the result. That is a table, not a constant — so the reachability
// ladder is one entry here rather than the shape of the module, and the next
// one is a file beside it rather than a fork of this logic.
//
// WHAT EVERY LADDER SHARES, and why it is here rather than in each of them:
//
//   * a rung is only decided by a measurement. No measurement, no verdict: the
//     rung reads `unknown`, and `unknown` is never promoted to `ok`;
//   * the FIRST rung that fails is the answer. Everything above it is
//     `unreached`, never green, because a layer that was measured after the
//     chain already broke was not measured through the thing that is broken;
//   * a rung switched off in Settings is reported as switched off, not dropped.
//     Shrinking a ladder makes an incomplete answer look like a complete one;
//   * a rung carries a message KEY and its parameters, never a sentence. One
//     render pass at the end puts it in the caller's language.
//
// WHAT EACH LADDER OWNS: its rungs, which of them are a causal chain (and so
// cannot be reordered), what it needs to run, and what it dispatches.
//
// A ladder definition:
//
//   id        'reachability'
//   layers    rung ids, in the shipped order
//   locked    the causal subsequence: these keep their relative order
//   needs     { agents: 1|2, target: 'host'|'device'|'none' } — what the caller
//             must supply, so a screen can ask for it and a route can refuse
//   dispatch  ({ host, config }) => { specs: [{ id, probe }], skipped: [...] },
//             or null for a ladder that measures nothing new (device location
//             reads what the fleet already reported). `skipped` says what was
//             left out and why, because a check that quietly disappears is the
//             same bug as one that quietly fails
//   extras    the config fields beyond order/enabled, with their defaults
//   clamp     (config) => the same fields, forced into range
//   prepare   (ctx, config) => the value every rung is handed, computed ONCE.
//             Optional; without it the rungs get the raw ctx. This is where a
//             ladder does the shaping its rungs all need — sorting probe rows
//             by type, say — so it happens once a walk rather than once a rung
//   rungs     { [id]: (prepared, config, ctx) => ({ status, key, params?, extra? }) }
//
// Pure: a context in, a verdict out. Every read happens in the route.

const { createT } = require('../i18n');

// Status vocabulary. Deliberately six words, not three: "not measured", "not
// applicable" and "not reached" are three different answers, and all three are
// different from "fine".
const STATUS = {
  OK: 'ok',
  FAILED: 'failed',
  SUSPECT: 'suspect',
  UNKNOWN: 'unknown',
  NA: 'not_applicable',
  UNREACHED: 'unreached',
};

// A rung result. The canonical fields are written LAST so that an extra called
// `status` (an HTTP one, say) cannot overwrite the rung's own verdict — a bug
// that shipped once and reported `502` where it meant to report `failed`.
const rung = (layer, status, key, params = null, extra = {}) => ({ ...extra, layer, status, key, params });

const REGISTRY = new Map();

function register(def) {
  if (REGISTRY.has(def.id)) throw new Error(`ladder "${def.id}" is registered twice`);
  // Checked at load, so a ladder that could never produce a verdict fails the
  // build rather than answering "unknown" for ever in the field.
  for (const l of def.locked) if (!def.layers.includes(l)) throw new Error(`ladder "${def.id}": locked rung "${l}" is not one of its layers`);
  for (const l of def.layers) if (typeof def.rungs[l] !== 'function') throw new Error(`ladder "${def.id}": rung "${l}" has no evaluator`);
  REGISTRY.set(def.id, def);
  return def;
}

const get = (id) => REGISTRY.get(String(id || '')) || null;
const ids = () => [...REGISTRY.keys()];
const all = () => [...REGISTRY.values()];

// The rungs a ladder may move freely: the ones that are not part of its causal
// chain. An observation ABOUT the path rather than a step along it.
const movableOf = (def) => def.layers.filter((l) => !def.locked.includes(l));

// Is this a legal order for this ladder? Every rung exactly once, and the
// locked chain in its canonical relative order. Returns null when it is fine,
// or the reason it is not — the settings validator turns that into a 400 an
// operator can act on, rather than silently falling back to the default.
function validateOrder(def, order) {
  if (!Array.isArray(order) || order.length !== def.layers.length) return `order must list all ${def.layers.length} rungs`;
  if (new Set(order).size !== order.length) return 'order must not repeat a rung';
  for (const l of def.layers) if (!order.includes(l)) return `order is missing "${l}"`;
  for (const l of order) if (!def.layers.includes(l)) return `"${l}" is not a rung of ${def.id}`;
  const chain = order.filter((l) => def.locked.includes(l));
  for (let i = 0; i < chain.length; i += 1) {
    if (chain[i] !== def.locked[i]) {
      return `${def.locked.join(' → ')} is a causal chain and cannot be reordered — "${chain[i]}" cannot come before "${def.locked[i]}"`;
    }
  }
  return null;
}

const defaultsOf = (def) => ({
  order: [...def.layers],
  enabled: Object.fromEntries(def.layers.map((l) => [l, true])),
  ...def.extras,
});

// A stored config, filled in from the defaults and refusing anything that would
// make the ladder lie. Never throws: a config that cannot be honoured falls
// back field by field, because a ladder that will not run is worse than one
// running the shipped order.
function resolveConfig(def, config) {
  const c = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const base = defaultsOf(def);
  const order = validateOrder(def, c.order) === null ? [...c.order] : base.order;
  const enabled = { ...base.enabled };
  if (c.enabled && typeof c.enabled === 'object') {
    for (const l of def.layers) if (typeof c.enabled[l] === 'boolean') enabled[l] = c.enabled[l];
  }
  return { ...base, ...(def.clamp ? def.clamp(c) : {}), order, enabled };
}

// Walk one ladder.
//
//   ladder   the definition, or its id
//   ctx      whatever that ladder's rungs read. Each ladder owns its shape;
//            the walk never looks inside it
//   config   what Settings stored for this ladder
//   locale   which language the sentences come back in
//   symptom  what the operator said was wrong, echoed back so the answer sits
//            next to the question. Never parsed, never trusted, never executed
function walk({ ladder, ctx = {}, config = null, locale = 'en', symptom = null } = {}) {
  const def = typeof ladder === 'string' ? get(ladder) : ladder;
  if (!def) throw new Error(`unknown ladder "${ladder}"`);
  const t = createT(locale);
  const cfg = resolveConfig(def, config);

  const prepared = typeof def.prepare === 'function' ? def.prepare(ctx, cfg) : ctx;
  const computed = {};
  for (const id of def.layers) {
    computed[id] = cfg.enabled[id]
      ? { ...def.rungs[id](prepared, cfg, ctx), layer: id }
      : rung(id, STATUS.UNKNOWN, 'rung.disabled', null, { disabled: true });
  }

  const layers = [];
  let stopsAt = null;
  for (const id of cfg.order) {
    const r = computed[id];
    if (stopsAt === null) {
      layers.push(r);
      if (r.status === STATUS.FAILED) stopsAt = id;
      continue;
    }
    layers.push(r.status === STATUS.UNKNOWN || r.status === STATUS.NA
      ? r
      : rung(id, STATUS.UNREACHED, 'rung.unreached', { layer: t(`layer.${stopsAt}`) }, { would_have_said: r.status }));
  }

  // One render pass, at the boundary. `evidence` is a nested { key, params } —
  // the only nesting the sentences use — so it is resolved first.
  for (const l of layers) {
    const params = l.params && l.params.evidence && l.params.evidence.key
      ? { ...l.params, evidence: t(l.params.evidence.key, l.params.evidence.params) }
      : l.params;
    l.because = t(l.key, params);
  }

  const decided = layers.filter((l) => l.status === STATUS.OK || l.status === STATUS.FAILED || l.status === STATUS.SUSPECT);
  const untested = layers.filter((l) => l.status === STATUS.UNKNOWN).map((l) => l.layer);
  const stop = stopsAt ? layers.find((l) => l.layer === stopsAt) : null;
  const suspects = layers.filter((l) => l.status === STATUS.SUSPECT);
  const named = (list) => list.map((id) => t(`layer.${id}`)).join(', ');
  const listOf = (rows) => rows.map((sp) => `${t(`layer.${sp.layer}`)}: ${sp.because}`).join('. ');

  let verdict;
  if (stop) {
    // A rung that is odd without being broken still belongs in the answer when
    // something below it broke: a load balancer in the path is exactly what
    // explains a healthy handshake under a dead service, and leaving it out
    // sends the operator to the wrong team.
    const also = suspects.filter((sp) => cfg.order.indexOf(sp.layer) < cfg.order.indexOf(stopsAt));
    // "The communication stops at" is the reachability ladder's sentence; a
    // ladder about one host or one switch port says it its own way. Same
    // fallback rule as `verdict.clear` below.
    const pick = (key) => (t.has(`${key}.${def.id}`) ? `${key}.${def.id}` : key);
    verdict = {
      outcome: 'stops',
      layer: stopsAt,
      text: also.length
        ? t(pick('verdict.stops.also'), { layer: t(`layer.${stopsAt}`), because: stop.because, also: listOf(also) })
        : t(pick('verdict.stops'), { layer: t(`layer.${stopsAt}`), because: stop.because }),
    };
  } else if (decided.length === 0) {
    verdict = { outcome: 'untested', layer: null, text: t('verdict.untested') };
  } else if (suspects.length) {
    // "No rung is broken" would overclaim while half the ladder is untested, so
    // the sentence says which half it is speaking for.
    const key = untested.length === 0 ? 'verdict.suspect'
      : untested.length > 1 ? 'verdict.suspect.untested.many' : 'verdict.suspect.untested';
    verdict = { outcome: 'suspect', layer: suspects[0].layer, text: t(key, { suspects: listOf(suspects), untested: named(untested) }) };
  } else if (untested.length) {
    verdict = {
      outcome: 'partial',
      layer: null,
      text: t(untested.length > 1 ? 'verdict.partial.many' : 'verdict.partial', { untested: named(untested) }),
    };
  } else {
    // A ladder may say "clear" in its own words — "this host is not the
    // problem" reads better than "the fault is not on the path to this
    // destination" when there is no destination.
    const own = `verdict.clear.${def.id}`;
    verdict = { outcome: 'clear', layer: null, text: t(t.has(own) ? own : 'verdict.clear') };
  }

  return {
    ladder: def.id,
    locale: t.locale,
    symptom: symptom ? String(symptom).slice(0, 500) : null,
    layers,
    stopsAt,
    verdict,
    tested: decided.map((l) => l.layer),
    untested,
  };
}

// What a screen needs to offer the ladders: what each one is called, what it
// needs before it can run, and which of its rungs may be moved.
const catalogue = () => all().map((def) => ({
  id: def.id,
  layers: [...def.layers],
  locked: [...def.locked],
  movable: movableOf(def),
  needs: { ...def.needs },
  dispatches: typeof def.dispatch === 'function',
  defaults: defaultsOf(def),
}));

module.exports = {
  STATUS, rung, register, get, ids, all, catalogue,
  movableOf, validateOrder, defaultsOf, resolveConfig, walk,
};
