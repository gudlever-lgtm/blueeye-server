'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateReportRange, validateThresholdInput, validateSeverityFilter } = require('../src/validation/incidentValidation');

// ---- validateReportRange ---------------------------------------------------

test('validateReportRange requires both from and to', () => {
  assert.ok(validateReportRange({}).errors.from);
  assert.ok(validateReportRange({ from: '2026-06-01T00:00:00Z' }).errors.to);
});

test('validateReportRange rejects unparseable dates and from>=to', () => {
  assert.ok(validateReportRange({ from: 'nope', to: 'also' }).errors);
  assert.ok(validateReportRange({ from: '2026-06-02T00:00:00Z', to: '2026-06-01T00:00:00Z' }).errors.range);
  assert.ok(validateReportRange({ from: '2026-06-01T00:00:00Z', to: '2026-06-01T00:00:00Z' }).errors.range); // equal
});

test('validateReportRange returns Date objects for a valid range', () => {
  const { value, errors } = validateReportRange({ from: '2026-06-01T00:00:00Z', to: '2026-06-02T00:00:00Z' });
  assert.equal(errors, undefined);
  assert.ok(value.from instanceof Date && value.to instanceof Date);
  assert.ok(value.from < value.to);
});

test('validateReportRange rejects a span longer than 366 days', () => {
  const over = validateReportRange({ from: '2025-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' });
  assert.ok(over.errors && over.errors.range);
  // Exactly within the cap is accepted.
  const ok = validateReportRange({ from: '2025-06-01T00:00:00Z', to: '2026-06-01T00:00:00Z' });
  assert.equal(ok.errors, undefined);
});

// ---- validateThresholdInput ------------------------------------------------

test('validateThresholdInput requires a valid metric', () => {
  assert.ok(validateThresholdInput({}).errors.metric);
  assert.ok(validateThresholdInput({ metric: 'bogus' }).errors.metric);
});

test('validateThresholdInput defaults debounce_count to 3 and allows null values', () => {
  const { value, errors } = validateThresholdInput({ metric: 'reachability' });
  assert.equal(errors, undefined);
  assert.equal(value.debounce_count, 3);
  assert.equal(value.warning_value, null);
  assert.equal(value.critical_value, null);
});

test('validateThresholdInput rejects critical<warning and a bad debounce_count', () => {
  assert.ok(validateThresholdInput({ metric: 'latency', warning_value: 300, critical_value: 100 }).errors.critical_value);
  assert.ok(validateThresholdInput({ metric: 'latency', warning_value: 1, critical_value: 2, debounce_count: 0 }).errors.debounce_count);
  assert.ok(validateThresholdInput({ metric: 'latency', warning_value: -1, critical_value: 2 }).errors.warning_value);
});

test('validateThresholdInput accepts a well-formed threshold', () => {
  const { value, errors } = validateThresholdInput({ metric: 'packet_loss', warning_value: 2, critical_value: 5, debounce_count: 4 });
  assert.equal(errors, undefined);
  assert.deepEqual(value, { metric: 'packet_loss', warning_value: 2, critical_value: 5, debounce_count: 4 });
});

// ---- validateSeverityFilter ------------------------------------------------

test('validateSeverityFilter: empty is null, valid passes through, invalid errors', () => {
  assert.deepEqual(validateSeverityFilter(undefined), { value: null });
  assert.deepEqual(validateSeverityFilter('warning'), { value: 'warning' });
  assert.deepEqual(validateSeverityFilter('critical'), { value: 'critical' });
  assert.ok(validateSeverityFilter('meh').errors);
});
