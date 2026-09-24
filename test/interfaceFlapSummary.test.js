'use strict';

// markFlapping writes the summary from the SAME count it stores.
//
// MySQL evaluates the assignments of a single-table UPDATE left to right, and
// an assignment sees the value an earlier one in the list just wrote. With
// `flap_count = flap_count + 1` ahead of the summary, the summary read the new
// count and added one again: "flapping 3×" beside flap_count = 2 (found in a
// real end-to-end run). The statement is pinned here against a scripted pool
// and evaluated with MySQL's left-to-right rule; whether MySQL agrees is
// scripts/verify-repositories-against-mysql.js ("interface flaps").

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createInterfaceStatesRepository } = require('../src/repositories/interfaceStatesRepository');

function scriptedPool() {
  const calls = [];
  return {
    calls,
    pool: {
      async query(sql, params) {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return [{ affectedRows: 1, insertId: 1 }];
      },
    },
  };
}

// The SET list, split at top-level commas, as [column, expression] in order.
function assignments(sql) {
  const set = /\bSET (.*) WHERE /.exec(sql)[1];
  const out = [];
  let depth = 0; let quote = null; let buf = '';
  for (const c of set) {
    if (quote) { buf += c; if (c === quote) quote = null; continue; }
    if (c === "'") { quote = c; buf += c; continue; }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  out.push(buf.trim());
  return out.map((a) => { const i = a.indexOf('='); return [a.slice(0, i).trim(), a.slice(i + 1).trim()]; });
}

// Evaluates the two assignments that matter, in the order MySQL does.
function applyLeftToRight(row, list) {
  const r = { ...row };
  for (const [col, expr] of list) {
    if (col === 'flap_count') {
      assert.equal(expr, 'flap_count + 1');
      r.flap_count += 1;
    } else if (col === 'summary') {
      assert.match(expr, /^CONCAT\(SUBSTRING_INDEX\(summary, ' \(flapping', 1\), ' \(flapping ', flap_count \+ 1, '×\)'\)$/);
      r.summary = `${r.summary.split(' (flapping')[0]} (flapping ${r.flap_count + 1}×)`;
    }
  }
  return r;
}

test('the flapping summary counts what flap_count stores, under left-to-right SET evaluation', async () => {
  const { pool, calls } = scriptedPool();
  const repo = createInterfaceStatesRepository({ pool });
  await repo.markFlapping(7, { at: new Date('2026-09-24T08:00:00Z') });
  const list = assignments(calls[0].sql);
  const cols = list.map(([c]) => c);
  assert.ok(cols.indexOf('summary') < cols.indexOf('flap_count'), `summary must be assigned before flap_count: ${cols.join(', ')}`);

  let row = { flap_count: 1, summary: 'eth0 went down' };
  for (let n = 2; n <= 4; n += 1) {
    row = applyLeftToRight(row, list);
    assert.equal(row.flap_count, n);
    assert.equal(row.summary, `eth0 went down (flapping ${n}×)`);
  }
  assert.deepEqual(calls[0].params, [new Date('2026-09-24T08:00:00Z'), 7]);
});
