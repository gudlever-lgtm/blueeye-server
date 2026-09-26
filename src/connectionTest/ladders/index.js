'use strict';

// The registry, with every ladder loaded.
//
// Registration happens HERE rather than in each module, so requiring one ladder
// for its helpers does not quietly register it, and the order the catalogue
// comes out in is the order this file lists — which is the order a screen shows
// them, from the most asked to the least.

const registry = require('./registry');

const reachability = require('./reachability');
const twoWay = require('./twoWay');
const localHost = require('./localHost');
const deviceLocation = require('./deviceLocation');

for (const m of [reachability, twoWay, localHost, deviceLocation]) registry.register(m.DEF);

module.exports = {
  ...registry,
  REACHABILITY: reachability.DEF.id,
  TWO_WAY: twoWay.DEF.id,
  LOCAL_HOST: localHost.DEF.id,
  DEVICE_LOCATION: deviceLocation.DEF.id,
};
