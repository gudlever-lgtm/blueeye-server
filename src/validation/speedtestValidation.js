'use strict';

// Validates the agent -> server speed-test submission: { result: { ... } }.
// Lenient but bounded — numbers must be finite and non-negative, strings capped.
function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function validateSpeedtestResult(body) {
  const b = body && typeof body === 'object' ? body : {};
  const r = b.result && typeof b.result === 'object' && !Array.isArray(b.result) ? b.result : null;
  if (!r) return { errors: { result: 'result is required (object)' } };

  let ts = null;
  if (r.ts) {
    const d = new Date(r.ts);
    if (Number.isNaN(d.getTime())) return { errors: { ts: 'ts must be a valid date' } };
    ts = d;
  }

  const fields = ['downMbps', 'upMbps', 'downBytes', 'upBytes', 'downMs', 'upMs'];
  const out = { ts, ok: r.ok === true, target: null, detail: null };
  for (const f of fields) {
    const n = num(r[f]);
    if (Number.isNaN(n)) return { errors: { [f]: `${f} must be a non-negative number` } };
    out[f] = n;
  }
  if (r.target != null) out.target = String(r.target).slice(0, 255);
  if (r.detail != null) out.detail = String(r.detail).slice(0, 255);
  return { value: out };
}

module.exports = { validateSpeedtestResult };
