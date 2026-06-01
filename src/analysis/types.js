'use strict';

// JSDoc @typedefs for the analysis module. These give editors autocomplete and
// let `tsc --checkJs` type-check the code without introducing TypeScript or a
// build step. There is no runtime export here beyond the type names.

/**
 * A single metric observation reported by (or derived from) an agent.
 * @typedef {Object} MetricSample
 * @property {string} hostId   Stable id of the host/agent the sample came from.
 * @property {string} metric   Metric name, e.g. 'cpu', 'io.await', 'app.latency'.
 * @property {number} value    Numeric value of the sample.
 * @property {Date}   ts       Timestamp of the observation.
 * @property {Object} labels   Free-form key/value labels (e.g. { iface: 'eth0' }).
 */

/**
 * A detected condition worth surfacing. `explanation` and `evidence` are
 * mandatory — the FindingStore rejects a finding without them.
 * @typedef {Object} Finding
 * @property {string} id                Unique id (crypto.randomUUID()).
 * @property {string} hostId            Host the finding concerns.
 * @property {string} metric            Metric the finding concerns.
 * @property {'INFO'|'WARN'|'CRIT'} severity
 * @property {'ANOMALY'|'THRESHOLD'|'FLATLINE'|'CORRELATED'} kind
 * @property {number} observed          The observed value that triggered it.
 * @property {number|null} baseline     The baseline (e.g. median) compared against.
 * @property {number|null} deviation    Robust z-score (sigmas) from baseline.
 * @property {[Date, Date]} window      [from, to] time window the finding covers.
 * @property {string} explanation       Human-readable why (non-empty, required).
 * @property {MetricSample[]} evidence   Supporting samples (length >= 1, required).
 * @property {string[]} correlatedWith   Ids of related findings (correlator).
 * @property {Date} createdAt           When the finding was created.
 * @property {boolean} acked            Whether an operator acknowledged it.
 */

module.exports = {};
