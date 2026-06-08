'use strict';

const {
  CATEGORIES, RISK_STATUSES, CONTROL_STATUSES, CONTROL_FREQUENCIES,
  INCIDENT_SEVERITIES, INCIDENT_STATUSES, REPORT_TYPES, EVIDENCE_ENTITIES,
} = require('../nis2/constants');

// ---- small field helpers --------------------------------------------------

// Required, non-empty, trimmed string with a max length.
function reqString(input, field, max, errors) {
  const v = input[field];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    errors[field] = `${field} is required`;
    return undefined;
  }
  if (typeof v !== 'string') { errors[field] = `${field} must be a string`; return undefined; }
  if (v.trim().length > max) { errors[field] = `${field} must be at most ${max} characters`; return undefined; }
  return v.trim();
}

// Optional string -> null when absent; validated max length otherwise.
function optString(input, field, max, errors) {
  const v = input[field];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') { errors[field] = `${field} must be a string`; return null; }
  if (v.length > max) { errors[field] = `${field} must be at most ${max} characters`; return null; }
  return v.trim();
}

// Required enum membership.
function reqEnum(input, field, allowed, errors) {
  const v = input[field];
  if (!allowed.includes(v)) { errors[field] = `${field} must be one of: ${allowed.join(', ')}`; return undefined; }
  return v;
}

// Optional date-only field (YYYY-MM-DD). Empty -> null. Validates it parses.
function optDate(input, field, errors) {
  const v = input[field];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    errors[field] = `${field} must be a date (YYYY-MM-DD)`;
    return null;
  }
  return v;
}

// Optional datetime field. Empty -> null. Stored as a MySQL DATETIME string.
function optDateTime(input, field, errors) {
  const v = input[field];
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) { errors[field] = `${field} must be a valid date/time`; return null; }
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Integer in [min,max].
function reqIntRange(input, field, min, max, errors) {
  const n = Number(input[field]);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors[field] = `${field} must be an integer between ${min} and ${max}`;
    return undefined;
  }
  return n;
}

function bool(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

const obj = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});
const done = (errors, value) => (Object.keys(errors).length ? { errors } : { value });

// ---- entity validators ----------------------------------------------------

function validateRiskInput(body) {
  const input = obj(body);
  const errors = {};
  const value = {};
  value.title = reqString(input, 'title', 255, errors);
  value.description = optString(input, 'description', 5000, errors);
  value.category = reqEnum(input, 'category', CATEGORIES, errors);
  value.affectedAsset = optString(input, 'affectedAsset', 255, errors);
  value.likelihood = reqIntRange(input, 'likelihood', 1, 5, errors);
  value.impact = reqIntRange(input, 'impact', 1, 5, errors);
  value.owner = optString(input, 'owner', 255, errors);
  value.status = input.status === undefined ? 'open' : reqEnum(input, 'status', RISK_STATUSES, errors);
  value.mitigationPlan = optString(input, 'mitigationPlan', 5000, errors);
  value.dueDate = optDate(input, 'dueDate', errors);
  value.managementAcceptance = bool(input.managementAcceptance);
  value.evidenceLink = optString(input, 'evidenceLink', 1024, errors);
  return done(errors, value);
}

function validateControlInput(body) {
  const input = obj(body);
  const errors = {};
  const value = {};
  value.controlName = reqString(input, 'controlName', 255, errors);
  value.nis2Area = reqEnum(input, 'nis2Area', CATEGORIES, errors);
  value.description = optString(input, 'description', 5000, errors);
  value.owner = optString(input, 'owner', 255, errors);
  value.frequency = input.frequency === undefined ? 'quarterly' : reqEnum(input, 'frequency', CONTROL_FREQUENCIES, errors);
  value.lastPerformed = optDate(input, 'lastPerformed', errors);
  value.nextDue = optDate(input, 'nextDue', errors);
  value.evidenceFile = optString(input, 'evidenceFile', 1024, errors);
  value.status = input.status === undefined ? 'Missing' : reqEnum(input, 'status', CONTROL_STATUSES, errors);
  value.comment = optString(input, 'comment', 5000, errors);
  return done(errors, value);
}

function validateIncidentInput(body) {
  const input = obj(body);
  const errors = {};
  const value = {};
  value.title = reqString(input, 'title', 255, errors);
  value.severity = input.severity === undefined ? 'medium' : reqEnum(input, 'severity', INCIDENT_SEVERITIES, errors);
  value.detectedAt = optDateTime(input, 'detectedAt', errors);
  value.startedAt = optDateTime(input, 'startedAt', errors);
  value.resolvedAt = optDateTime(input, 'resolvedAt', errors);
  value.affectedSystems = optString(input, 'affectedSystems', 2000, errors);
  value.businessImpact = optString(input, 'businessImpact', 2000, errors);
  value.rootCause = optString(input, 'rootCause', 2000, errors);
  value.actionsTaken = optString(input, 'actionsTaken', 2000, errors);
  value.nis2Relevant = bool(input.nis2Relevant);
  value.notificationRequired = bool(input.notificationRequired);
  value.status = input.status === undefined ? 'open' : reqEnum(input, 'status', INCIDENT_STATUSES, errors);
  value.lessonsLearned = optString(input, 'lessonsLearned', 2000, errors);
  return done(errors, value);
}

function validateEvidenceInput(body) {
  const input = obj(body);
  const errors = {};
  const value = {};
  value.title = reqString(input, 'title', 255, errors);
  value.description = optString(input, 'description', 2000, errors);
  value.fileName = optString(input, 'fileName', 255, errors);
  value.fileUrl = optString(input, 'fileUrl', 1024, errors);
  value.contentType = optString(input, 'contentType', 128, errors);
  // entityType/entityId are optional, but must be provided together + valid.
  if (input.entityType === undefined || input.entityType === null || input.entityType === '') {
    value.entityType = null;
    value.entityId = null;
  } else {
    value.entityType = reqEnum(input, 'entityType', EVIDENCE_ENTITIES, errors);
    const n = Number(input.entityId);
    if (!Number.isInteger(n) || n <= 0) errors.entityId = 'entityId must be a positive integer when entityType is set';
    else value.entityId = n;
  }
  // Guard against smuggling a non-http(s) scheme into a stored "file" reference.
  if (value.fileUrl && !/^(https?:\/\/|\/)/i.test(value.fileUrl)) {
    errors.fileUrl = 'fileUrl must be an http(s) URL or an absolute path';
  }
  return done(errors, value);
}

function validateReportRequest(body) {
  const input = obj(body);
  const errors = {};
  const value = {};
  value.reportType = reqEnum(input, 'reportType', REPORT_TYPES, errors);
  value.title = input.title === undefined ? null : optString(input, 'title', 255, errors);
  value.periodStart = optDate(input, 'periodStart', errors);
  value.periodEnd = optDate(input, 'periodEnd', errors);
  return done(errors, value);
}

module.exports = {
  validateRiskInput,
  validateControlInput,
  validateIncidentInput,
  validateEvidenceInput,
  validateReportRequest,
};
