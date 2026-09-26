'use strict';

// Compatibility surface for the reachability ladder.
//
// The ladder used to be this file. It is now one entry in a registry
// (`./ladders/`), because a ladder is an ordered list of rungs plus an
// evaluator per rung plus a verdict rule — a table, not the shape of a module —
// and there are four of them.
//
// What stays here: the names the rest of the server already imports, bound to
// the reachability ladder. `walk({ results, host, arp, ... })` still walks that
// one, so a caller that only ever wanted "where does this destination stop"
// does not have to know a registry exists.

const registry = require('./ladders');
const reachability = require('./ladders/reachability');

const DEF = reachability.DEF;

const walk = ({ results = [], host = '', arp = null, symptom = null, locale = 'en', config = null } = {}) =>
  ({ host, ...registry.walk({ ladder: DEF, ctx: { results, host, arp }, config, locale, symptom }) });

module.exports = {
  walk,
  STATUS: registry.STATUS,
  LAYERS: reachability.LAYERS,
  LOCKED_ORDER: reachability.LOCKED,
  MOVABLE: registry.movableOf(DEF),
  DEFAULT_CONFIG: Object.freeze(registry.defaultsOf(DEF)),
  resolveConfig: (config) => registry.resolveConfig(DEF, config),
  validateOrder: (order) => registry.validateOrder(DEF, order),
  targetHost: reachability.targetHost,
  targetPort: reachability.targetPort,
  collect: reachability.collect,
  FILTERED: reachability.FILTERED,
  ANSWERED: reachability.ANSWERED,
};
