'use strict';

// Builds schema.sql — the full-schema snapshot — by replaying migrations/ in
// order against an in-memory model of the database.
//
// WHY THIS EXISTS. schema.sql used to be hand-maintained alongside the numbered
// migrations, and it drifted badly: by migration 077 it was missing 23 tables and
// referenced event_cases in a foreign key without ever creating it, so the
// "load this into a fresh database" path in README no longer worked at all. A
// snapshot that is written twice is a snapshot that disagrees with itself, so it
// is derived now. migrations/ stays the source of truth.
//
//   node scripts/build-schema.js            # rewrite schema.sql
//   node scripts/build-schema.js --check    # exit 1 if schema.sql is stale
//
// test/schemaSnapshot.test.js runs --check, so drift fails the suite.
//
// This is a MODEL of MySQL DDL, not an implementation of it: it understands the
// statement forms migrations/ actually uses and throws on anything else, which is
// what keeps it honest — a new form fails the build loudly instead of being
// silently dropped from the snapshot. Column and key definitions are copied
// verbatim from the migration that introduced them, so the emitted DDL is the
// migrations' own text, reordered.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const SCHEMA_PATH = path.join(ROOT, 'schema.sql');

// Items in a CREATE TABLE body that are indexes/constraints rather than columns.
const KEY_PREFIX = /^(PRIMARY\s+KEY|UNIQUE\s+KEY|UNIQUE\s+INDEX|UNIQUE|KEY|INDEX|FULLTEXT|SPATIAL|CONSTRAINT|FOREIGN\s+KEY|CHECK)\b/i;

// ---------------------------------------------------------------------------
// Lexing: statements, and top-level comma splits that respect nesting/quotes
// ---------------------------------------------------------------------------

// Strips `-- ` line comments, leaving string literals alone.
function stripComments(sql) {
  let out = '';
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === '\\' && quote !== '`') { out += sql[i + 1] ?? ''; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; continue; }
    if (c === '-' && sql[i + 1] === '-' && (sql[i + 2] === ' ' || sql[i + 2] === '\n' || sql[i + 2] === undefined)) {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    out += c;
  }
  return out;
}

// Splits on `;` at nesting depth 0, outside quotes.
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (quote) {
      buf += c;
      if (c === '\\' && quote !== '`') { buf += sql[i + 1] ?? ''; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; buf += c; continue; }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ';' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

// Splits a CREATE TABLE body / ALTER clause list on top-level commas.
function splitTopLevel(text) {
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      buf += c;
      if (c === '\\' && quote !== '`') { buf += text[i + 1] ?? ''; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; buf += c; continue; }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

const unquote = (s) => s.trim().replace(/^`(.*)`$/, '$1');

// Name of the index/constraint an item declares, for DROP/RENAME lookups.
function keyName(def) {
  let m = /^CONSTRAINT\s+`?(\w+)`?/i.exec(def);
  if (m) return m[1];
  m = /^(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+`?(\w+)`?/i.exec(def);
  if (m) return m[1];
  if (/^PRIMARY\s+KEY/i.test(def)) return 'PRIMARY';
  return null;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

function createModel() {
  const tables = new Map(); // name -> { name, comment, columns: [{name, def}], keys: [{name, def}], options }

  const must = (name) => {
    const t = tables.get(name);
    if (!t) throw new Error(`unknown table \`${name}\``);
    return t;
  };

  return {
    tables,
    must,
    hasColumn(table, column) {
      const t = tables.get(table);
      return !!t && t.columns.some((c) => c.name.toLowerCase() === column.toLowerCase());
    },
    hasIndex(table, index) {
      const t = tables.get(table);
      return !!t && t.keys.some((k) => (k.name || '').toLowerCase() === index.toLowerCase());
    },
  };
}

// Inserts a column honouring AFTER / FIRST, and returns the definition with that
// positional clause removed (a CREATE TABLE expresses position by order).
function addColumn(table, name, def, position) {
  const entry = { name, def };
  if (/^FIRST$/i.test(position || '')) { table.columns.unshift(entry); return; }
  const after = /^AFTER\s+`?(\w+)`?$/i.exec(position || '');
  if (after) {
    const at = table.columns.findIndex((c) => c.name.toLowerCase() === after[1].toLowerCase());
    if (at !== -1) { table.columns.splice(at + 1, 0, entry); return; }
  }
  table.columns.push(entry);
}

// Renames a table in the model, carrying the rename into every OTHER table's
// foreign keys — MySQL rewrites REFERENCES clauses pointing at a renamed table,
// so a snapshot that did not would emit FKs against a name that no longer exists
// and fail to load.
function renameTable(model, from, to) {
  const table = model.must(from);
  model.tables.delete(from);
  table.name = to;
  model.tables.set(to, table);

  for (const other of model.tables.values()) {
    for (const key of other.keys) {
      key.def = key.def.replace(
        new RegExp(`(REFERENCES\\s+)\`?${from}\`?\\b`, 'i'),
        `$1${to}`,
      );
    }
  }
}

// Peels a trailing AFTER x / FIRST off a column definition.
function splitPosition(def) {
  const m = /\s+(AFTER\s+`?\w+`?|FIRST)\s*$/i.exec(def);
  if (!m) return { def: def.trim(), position: null };
  return { def: def.slice(0, m.index).trim(), position: m[1].trim() };
}

// ---------------------------------------------------------------------------
// Statement application
// ---------------------------------------------------------------------------

function applyCreateTable(model, stmt, comment) {
  const m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(/i.exec(stmt);
  if (!m) throw new Error(`unparsed CREATE TABLE: ${stmt.slice(0, 80)}`);
  const name = m[1];

  const open = stmt.indexOf('(', m.index + m[0].length - 1);
  // Walk to the matching close paren; whatever follows is the table options.
  let depth = 0;
  let close = -1;
  for (let i = open; i < stmt.length; i += 1) {
    if (stmt[i] === '(') depth += 1;
    else if (stmt[i] === ')') { depth -= 1; if (depth === 0) { close = i; break; } }
  }
  if (close === -1) throw new Error(`unbalanced CREATE TABLE body for \`${name}\``);

  const table = {
    name,
    comment,
    columns: [],
    keys: [],
    options: stmt.slice(close + 1).trim().replace(/\s+/g, ' '),
  };
  for (const item of splitTopLevel(stmt.slice(open + 1, close))) {
    if (KEY_PREFIX.test(item)) table.keys.push({ name: keyName(item), def: item });
    else {
      const col = /^`?(\w+)`?\s+([\s\S]+)$/.exec(item);
      if (!col) throw new Error(`unparsed column in \`${name}\`: ${item}`);
      table.columns.push({ name: col[1], def: col[2].trim() });
    }
  }
  // `IF NOT EXISTS` means a re-run is a no-op; model that rather than clobbering.
  if (/IF\s+NOT\s+EXISTS/i.test(m[0]) && model.tables.has(name)) return;
  model.tables.set(name, table);
}

function applyAlterClause(model, table, clause) {
  let m;

  if ((m = /^ADD\s+(?:COLUMN\s+)?`?(\w+)`?\s+([\s\S]+)$/i.exec(clause)) && !KEY_PREFIX.test(clause.replace(/^ADD\s+/i, ''))) {
    const { def, position } = splitPosition(m[2]);
    addColumn(table, m[1], def, position);
    return;
  }
  if (/^ADD\s+/i.test(clause)) {
    const def = clause.replace(/^ADD\s+/i, '').trim();
    table.keys.push({ name: keyName(def), def });
    return;
  }
  if ((m = /^DROP\s+(?:COLUMN\s+)?`?(\w+)`?$/i.exec(clause)) && model.hasColumn(table.name, m[1])) {
    table.columns = table.columns.filter((c) => c.name.toLowerCase() !== m[1].toLowerCase());
    return;
  }
  if ((m = /^DROP\s+(?:FOREIGN\s+KEY|INDEX|KEY)\s+`?(\w+)`?$/i.exec(clause))) {
    table.keys = table.keys.filter((k) => (k.name || '').toLowerCase() !== m[1].toLowerCase());
    return;
  }
  if ((m = /^MODIFY\s+(?:COLUMN\s+)?`?(\w+)`?\s+([\s\S]+)$/i.exec(clause))) {
    const { def, position } = splitPosition(m[2]);
    const col = table.columns.find((c) => c.name.toLowerCase() === m[1].toLowerCase());
    if (!col) throw new Error(`MODIFY of unknown column \`${m[1]}\` on \`${table.name}\``);
    col.def = def;
    if (position) {
      table.columns = table.columns.filter((c) => c !== col);
      addColumn(table, col.name, col.def, position);
    }
    return;
  }
  if ((m = /^CHANGE\s+(?:COLUMN\s+)?`?(\w+)`?\s+`?(\w+)`?\s+([\s\S]+)$/i.exec(clause))) {
    const col = table.columns.find((c) => c.name.toLowerCase() === m[1].toLowerCase());
    if (!col) throw new Error(`CHANGE of unknown column \`${m[1]}\` on \`${table.name}\``);
    const { def, position } = splitPosition(m[3]);
    col.name = m[2];
    col.def = def;
    if (position) {
      table.columns = table.columns.filter((c) => c !== col);
      addColumn(table, col.name, col.def, position);
    }
    return;
  }
  if ((m = /^RENAME\s+INDEX\s+`?(\w+)`?\s+TO\s+`?(\w+)`?$/i.exec(clause))) {
    const key = table.keys.find((k) => (k.name || '').toLowerCase() === m[1].toLowerCase());
    // An index InnoDB auto-created to back a foreign key is never declared here,
    // so a rename of one has nothing to do — the snapshot only carries what the
    // migrations declare, and a fresh load recreates the implicit ones itself.
    if (!key) return;
    key.def = key.def.replace(new RegExp(`\\b${m[1]}\\b`), m[2]);
    key.name = m[2];
    return;
  }
  if ((m = /^RENAME\s+(?:TO|AS)\s+`?(\w+)`?$/i.exec(clause))) {
    renameTable(model, table.name, m[1]);
    return;
  }
  throw new Error(`unsupported ALTER clause on \`${table.name}\`: ${clause}`);
}

function applyStatement(model, stmt, comment, ctx) {
  const head = stmt.replace(/\s+/g, ' ').trim();

  if (/^CREATE\s+TABLE\b/i.test(head)) return applyCreateTable(model, stmt, comment);

  if (/^ALTER\s+TABLE\b/i.test(head)) {
    const m = /^ALTER\s+TABLE\s+`?(\w+)`?\s+([\s\S]+)$/i.exec(stmt);
    if (!m) throw new Error(`unparsed ALTER TABLE: ${head.slice(0, 80)}`);
    const table = model.must(m[1]);
    for (const clause of splitTopLevel(m[2])) applyAlterClause(model, table, clause);
    return undefined;
  }

  if (/^DROP\s+TABLE\b/i.test(head)) {
    const list = head.replace(/^DROP\s+TABLE\s+(IF\s+EXISTS\s+)?/i, '');
    for (const t of splitTopLevel(list)) model.tables.delete(unquote(t));
    return undefined;
  }

  if (/^RENAME\s+TABLE\b/i.test(head)) {
    for (const pair of splitTopLevel(head.replace(/^RENAME\s+TABLE\s+/i, ''))) {
      const m = /^`?(\w+)`?\s+TO\s+`?(\w+)`?$/i.exec(pair.trim());
      if (!m) throw new Error(`unparsed RENAME TABLE pair: ${pair}`);
      renameTable(model, m[1], m[2]);
    }
    return undefined;
  }

  if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(head)) {
    const m = /^CREATE\s+(UNIQUE\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?\s*(\([\s\S]*\))$/i.exec(head);
    if (!m) throw new Error(`unparsed CREATE INDEX: ${head.slice(0, 80)}`);
    const table = model.must(m[3]);
    const def = `${m[1] ? 'UNIQUE KEY' : 'KEY'} ${m[2]} ${m[4]}`;
    if (!model.hasIndex(m[3], m[2])) table.keys.push({ name: m[2], def });
    return undefined;
  }

  // --- the conditional-DDL idiom (migrations 076, 077) ---------------------
  // SET @v := (SELECT COUNT(*) FROM information_schema...); / SET @s := IF(...);
  // PREPARE ... EXECUTE ... DEALLOCATE. Evaluated against the model so a fresh
  // load reaches the same shape a migrated database does.
  let m;
  if ((m = /^SET\s+@(\w+)\s*:?=\s*([\s\S]+)$/i.exec(head))) {
    ctx.vars.set(m[1], evalExpression(model, m[2].trim(), ctx));
    return undefined;
  }
  if ((m = /^PREPARE\s+\w+\s+FROM\s+@(\w+)$/i.exec(head))) {
    ctx.prepared = ctx.vars.get(m[1]);
    return undefined;
  }
  if (/^EXECUTE\s+\w+$/i.test(head)) {
    const sql = ctx.prepared;
    if (typeof sql === 'string' && !/^DO\s+0$/i.test(sql.trim())) applyStatement(model, sql, null, ctx);
    return undefined;
  }
  if (/^DEALLOCATE\s+PREPARE\s+\w+$/i.test(head)) { ctx.prepared = null; return undefined; }
  if (/^DO\s+0$/i.test(head)) return undefined;

  // Seed/backfill data and DML are not part of a structural snapshot.
  if (/^(INSERT|UPDATE|DELETE|SET\s+NAMES)\b/i.test(head)) return undefined;

  throw new Error(`unsupported statement: ${head.slice(0, 120)}`);
}

// Evaluates the handful of expression shapes the conditional migrations use.
function evalExpression(model, expr, ctx) {
  const text = expr.replace(/\s+/g, ' ').trim();

  if (/^DATABASE\(\)$/i.test(text)) return 'blueeye';
  if (/^'.*'$/.test(text)) return text.slice(1, -1);

  // (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE ... COLUMN_NAME = 'x')
  let m = /information_schema\.COLUMNS\b[\s\S]*TABLE_NAME\s*=\s*'(\w+)'[\s\S]*COLUMN_NAME\s*=\s*'(\w+)'/i.exec(text);
  if (m) return model.hasColumn(m[1], m[2]) ? 1 : 0;
  m = /information_schema\.STATISTICS\b[\s\S]*(?:TABLE_NAME|table_name)\s*=\s*'(\w+)'[\s\S]*(?:INDEX_NAME|index_name)\s*=\s*'(\w+)'/i.exec(text);
  if (m) return model.hasIndex(m[1], m[2]) ? 1 : 0;

  // IF(<cond>, '<sql>', '<sql>')  — including IF(EXISTS(<subquery>), ...)
  m = /^IF\s*\(([\s\S]+)\)$/i.exec(text);
  if (m) {
    const parts = splitTopLevel(m[1]);
    if (parts.length !== 3) throw new Error(`unparsed IF(): ${text.slice(0, 120)}`);
    return evalCondition(model, parts[0], ctx)
      ? evalExpression(model, parts[1], ctx)
      : evalExpression(model, parts[2], ctx);
  }

  throw new Error(`unsupported expression: ${text.slice(0, 120)}`);
}

function evalCondition(model, cond, ctx) {
  const text = cond.replace(/\s+/g, ' ').trim();

  let m = /^EXISTS\s*\(([\s\S]+)\)$/i.exec(text);
  if (m) {
    const inner = m[1];
    let q = /information_schema\.STATISTICS\b[\s\S]*table_name\s*=\s*'(\w+)'[\s\S]*index_name\s*=\s*'(\w+)'/i.exec(inner);
    if (q) return model.hasIndex(q[1], q[2]);
    q = /information_schema\.COLUMNS\b[\s\S]*table_name\s*=\s*'(\w+)'[\s\S]*column_name\s*=\s*'(\w+)'/i.exec(inner);
    if (q) return model.hasColumn(q[1], q[2]);
    throw new Error(`unsupported EXISTS(): ${inner.slice(0, 120)}`);
  }

  m = /^@(\w+)\s*=\s*(\d+)$/.exec(text);
  if (m) return Number(ctx.vars.get(m[1])) === Number(m[2]);

  throw new Error(`unsupported condition: ${text.slice(0, 120)}`);
}

// ---------------------------------------------------------------------------
// Replay + emit
// ---------------------------------------------------------------------------

// The `-- ` block immediately above a statement, kept as the table's doc comment.
function precedingComment(raw, index) {
  const before = raw.slice(0, index).split('\n');
  const lines = [];
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const line = before[i].trim();
    if (line === '') { if (lines.length) break; continue; }
    if (!line.startsWith('--')) break;
    lines.unshift(line);
  }
  return lines.length ? lines.join('\n') : null;
}

// Applies one SQL text to a model. Used both to replay a migration and to read
// the emitted snapshot back in, which is how the snapshot is verified without a
// live MySQL: if rendering dropped or mangled anything, the re-read model stops
// matching the migration-derived one.
function applySql(model, raw) {
  const ctx = { vars: new Map(), prepared: null };
  for (const stmt of splitStatements(stripComments(raw))) {
    let comment = null;
    const create = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i.exec(stmt.trim());
    if (create) {
      const at = raw.search(new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?\`?${create[1]}\`?\\b`, 'i'));
      if (at !== -1) comment = precedingComment(raw, at);
    }
    applyStatement(model, stmt.trim(), comment, ctx);
  }
  return model;
}

function modelFromSql(sql) {
  return applySql(createModel(), sql);
}

function buildModel() {
  const model = createModel();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    try {
      applySql(model, fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    } catch (err) {
      throw new Error(`${file}: ${err.message}`);
    }
  }
  return model;
}

const HEADER = `-- BlueEyes server — canonical database schema (full snapshot).
--
-- GENERATED FILE — do not edit by hand.
--   Regenerate:  node scripts/build-schema.js
--   Verify:      node scripts/build-schema.js --check   (also run by npm test)
--
-- migrations/ is the source of truth; this file is that chain replayed into one
-- picture of the current schema. It was hand-maintained once and drifted 23
-- tables behind, which is why it is derived now.
--
-- Two ways to set up a database:
--   1) Run the migration runner (recommended):   npm run migrate
--      It applies the ordered files in migrations/ and records them in
--      schema_migrations, so it is safe to re-run.
--   2) Load this snapshot directly into a fresh DB:
--        mysql -u <user> -p <database> < schema.sql
--      Note this leaves schema_migrations EMPTY — a database built this way is
--      already current, so seed it before running the migrator against it.

SET NAMES utf8mb4;

-- Bookkeeping table used by the migration runner (src/migrate.js).
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  filename VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_schema_migrations_filename (filename)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

function render(model) {
  const chunks = [HEADER];
  for (const table of model.tables.values()) {
    if (table.name === 'schema_migrations') continue;
    const items = [
      ...table.columns.map((c) => `  ${c.name} ${c.def}`),
      ...table.keys.map((k) => `  ${k.def.replace(/\s+/g, ' ')}`),
    ];
    chunks.push(
      `\n${table.comment ? `${table.comment}\n` : ''}CREATE TABLE IF NOT EXISTS ${table.name} (\n`
      + `${items.join(',\n')}\n`
      + `) ${table.options || 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'};\n`,
    );
  }
  return chunks.join('');
}

function build() {
  return render(buildModel());
}

if (require.main === module) {
  const generated = build();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(SCHEMA_PATH) ? fs.readFileSync(SCHEMA_PATH, 'utf8') : '';
    if (current !== generated) {
      console.error('schema.sql is out of date — run: node scripts/build-schema.js');
      process.exit(1);
    }
    console.info('schema.sql is up to date.');
  } else {
    fs.writeFileSync(SCHEMA_PATH, generated);
    console.info(`Wrote ${path.relative(ROOT, SCHEMA_PATH)}`);
  }
}

module.exports = { build, buildModel, modelFromSql, SCHEMA_PATH };
