'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// THE SQL, not the fake. The Analysis page was slow because four GROUP BY
// passes read the whole findings table on every load — 184 780 rows on a fleet
// with 98 open findings — and accepting could not help, because an accepted
// finding is still a row. What makes it fast is that `acked = 0` reaches the
// WHERE clause of every one of those passes, and lands first so it is the
// leading column of idx_findings_open (migration 114).
//
// A scripted pool captures the statements: this asserts what is SENT to MySQL,
// which is the part the in-memory fake can never speak to.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FindingStore } = require('../src/analysis/findings');

function recordingStore() {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
      return [[]];
    },
  };
  return { store: new FindingStore({ db: { pool } }), queries };
}

const grouped = (queries) => queries.filter((q) => /GROUP BY/i.test(q.sql));

test('every grouped read of the summary is scoped to open findings', async () => {
  const { store, queries } = recordingStore();
  await store.summary({ open: true });

  const groups = grouped(queries);
  assert.equal(groups.length, 4, 'severity, metric, host, host+metric');
  for (const q of groups) {
    assert.match(q.sql, /WHERE acked = 0/, q.sql);
  }
});

test('acked = 0 leads the WHERE, so it leads the index range', async () => {
  // Ordering is not cosmetic here: idx_findings_open is (acked, host_id,
  // metric, severity, created_at), and a predicate that is not on the leading
  // column cannot start a range scan.
  const { store, queries } = recordingStore();
  await store.summary({ open: true, hostId: '9', severity: 'CRIT' });
  for (const q of grouped(queries)) {
    assert.match(q.sql, /WHERE acked = 0 AND host_id = \? AND severity = \?/, q.sql);
  }
});

test('without the scope the statements are exactly what they always were', async () => {
  const { store, queries } = recordingStore();
  await store.summary({});
  for (const q of grouped(queries)) {
    // The WHERE, not the whole statement: `acked = 0` also appears inside the
    // SUM() open counts, which are a different thing — they report how much is
    // open WITHIN whatever was counted, and they are why the per-host CRIT/WARN
    // columns move when somebody presses Accept.
    assert.doesNotMatch(q.sql, /WHERE/, 'a report that counts everything still counts everything');
  }
  const byHost = grouped(queries).find((q) => /GROUP BY host_id ORDER BY/.test(q.sql));
  assert.match(byHost.sql, /SUM\(acked = 0\) AS open_total/, 'and still reports what is open within it');
});

test('the list takes the same scope as the summary', async () => {
  const { store, queries } = recordingStore();
  await store.list(null, null, 50, undefined, { open: true });
  assert.match(queries[0].sql, /WHERE acked = 0/);
});

test('the index the scope relies on exists in the migration chain', async () => {
  // The scope without the index is the same full scan with extra words in it.
  const dir = path.join(__dirname, '..', 'migrations');
  const chain = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.match(chain, /CREATE INDEX `idx_findings_open`\s+ON `findings` \(`acked`, `host_id`, `metric`, `severity`, `created_at`\)/);

  // And in the generated snapshot, which is what a fresh install loads.
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  assert.match(schema, /idx_findings_open/);
});
