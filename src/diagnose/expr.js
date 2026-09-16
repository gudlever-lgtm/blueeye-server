'use strict';

// The rule language a playbook's reading-rules are written in.
//
// A rule says "this pattern of test results confirms the cause" or "…rules it
// out", and it has to be written somewhere a person can read it:
//
//   loss.size_64.pct == 0 && loss.size_1472.pct >= 50
//   path_mtu.blackhole_detected == true
//
// This compiles that, and NOTHING else. No `eval`, no `new Function`, no
// property access through brackets, no calls, no arithmetic. A hand-written
// tokeniser and a recursive-descent parser over a grammar of six comparisons,
// two connectives, negation and parentheses — because the catalogue is data, and
// data that reaches an interpreter is an interpreter that must not be able to do
// anything. Everything outside the grammar is rejected at COMPILE time, which is
// startup: a playbook with a malformed rule stops the server rather than failing
// quietly on the one day somebody needs it.
//
// THREE-VALUED ON PURPOSE. A test that did not run has no value, and a rule over
// a value nobody measured must not decide anything. So a path that is missing
// evaluates to UNKNOWN, unknown propagates through the connectives the way it
// should (`false && unknown` is still false; `unknown && true` is unknown), and
// only an outright `true` fires a rule. The paths that were missing come back
// with the result, so the UI can say "inconclusive because the path_mtu test has
// not run" instead of the much less useful "inconclusive".

// Guards. A rule is one line a person wrote, not a program.
const MAX_EXPR_LENGTH = 500;
const MAX_DEPTH = 24;

// The unknown value. A symbol rather than null/undefined so it can never be
// confused with a measurement that legitimately came back as either.
const UNKNOWN = Symbol('unknown');

const COMPARISONS = ['==', '!=', '>=', '<=', '>', '<'];
// Property names that are not data. A playbook is repo content today, but the
// format invites a database tomorrow, and a walker that will happily follow
// `constructor.prototype` is a walker that only needs one careless move.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class ExprError extends Error {
  constructor(message, expr) {
    super(expr ? `${message} in rule: ${expr}` : message);
    this.name = 'ExprError';
  }
}

// --- tokeniser ---------------------------------------------------------------

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const s = src;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }
    if (c === '(' || c === ')') { tokens.push({ t: c }); i += 1; continue; }
    // Two-character operators first, so `>=` is never read as `>` then `=`.
    const two = s.slice(i, i + 2);
    if (COMPARISONS.includes(two)) { tokens.push({ t: 'cmp', v: two }); i += 2; continue; }
    if (two === '&&' || two === '||') { tokens.push({ t: two }); i += 2; continue; }
    if (c === '>' || c === '<') { tokens.push({ t: 'cmp', v: c }); i += 1; continue; }
    if (c === '!') { tokens.push({ t: '!' }); i += 1; continue; }
    // A lone `=` or `&` is the classic typo for `==` / `&&`; say so rather than
    // letting it fall through to "unexpected character".
    if (c === '=' || c === '&' || c === '|') {
      throw new ExprError(`unexpected "${c}" — did you mean "${c}${c}"?`);
    }
    if (c === "'" || c === '"') {
      const end = s.indexOf(c, i + 1);
      if (end === -1) throw new ExprError('unterminated string');
      tokens.push({ t: 'lit', v: s.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(s[i + 1] || ''))) {
      const m = /^-?\d+(\.\d+)?/.exec(s.slice(i));
      tokens.push({ t: 'lit', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(s.slice(i));
      const word = m[0];
      if (word === 'true') tokens.push({ t: 'lit', v: true });
      else if (word === 'false') tokens.push({ t: 'lit', v: false });
      else tokens.push({ t: 'path', v: word });
      i += word.length;
      continue;
    }
    throw new ExprError(`unexpected character "${c}"`);
  }
  return tokens;
}

// --- parser ------------------------------------------------------------------
//
//   or   := and ( '||' and )*
//   and  := cmp ( '&&' cmp )*
//   cmp  := unary ( ('=='|'!='|'>='|'<='|'>'|'<') unary )?
//   unary:= '!' unary | primary
//   prim := '(' or ')' | literal | path

function parse(tokens, src) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => {
    const tok = tokens[pos];
    if (!tok || tok.t !== t) throw new ExprError(`expected ${t}`, src);
    pos += 1;
    return tok;
  };

  function parseOr(depth) {
    if (depth > MAX_DEPTH) throw new ExprError('rule is nested too deeply', src);
    let node = parseAnd(depth + 1);
    while (peek() && peek().t === '||') { pos += 1; node = { k: 'or', a: node, b: parseAnd(depth + 1) }; }
    return node;
  }
  function parseAnd(depth) {
    if (depth > MAX_DEPTH) throw new ExprError('rule is nested too deeply', src);
    let node = parseCmp(depth + 1);
    while (peek() && peek().t === '&&') { pos += 1; node = { k: 'and', a: node, b: parseCmp(depth + 1) }; }
    return node;
  }
  function parseCmp(depth) {
    const left = parseUnary(depth + 1);
    if (peek() && peek().t === 'cmp') {
      const op = tokens[pos].v;
      pos += 1;
      // No chaining: `a < b < c` reads as maths and behaves as neither, so it is
      // a parse error rather than a surprise.
      const right = parseUnary(depth + 1);
      if (peek() && peek().t === 'cmp') throw new ExprError('comparisons cannot be chained', src);
      return { k: 'cmp', op, a: left, b: right };
    }
    return left;
  }
  function parseUnary(depth) {
    if (peek() && peek().t === '!') { pos += 1; return { k: 'not', a: parseUnary(depth + 1) }; }
    return parsePrimary(depth);
  }
  function parsePrimary(depth) {
    const tok = peek();
    if (!tok) throw new ExprError('unexpected end of rule', src);
    if (tok.t === '(') { pos += 1; const inner = parseOr(depth + 1); eat(')'); return inner; }
    if (tok.t === 'lit') { pos += 1; return { k: 'lit', v: tok.v }; }
    if (tok.t === 'path') {
      pos += 1;
      const parts = tok.v.split('.');
      for (const part of parts) {
        if (FORBIDDEN_KEYS.has(part)) throw new ExprError(`"${part}" is not a readable field`, src);
      }
      return { k: 'path', parts, raw: tok.v };
    }
    throw new ExprError(`unexpected "${tok.t}"`, src);
  }

  const ast = parseOr(0);
  if (pos !== tokens.length) throw new ExprError('trailing input', src);
  return ast;
}

// --- evaluation --------------------------------------------------------------

function readPath(ctx, parts) {
  let cur = ctx;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return UNKNOWN;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return UNKNOWN;
    cur = cur[part];
  }
  // A measurement that came back empty is not a measurement. Treating null as a
  // value here is how a rule ends up "confirming" a cause from a test that
  // never ran.
  if (cur === null || cur === undefined) return UNKNOWN;
  return cur;
}

function compare(op, a, b) {
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    default: break;
  }
  // Ordering only means something between numbers. `'slow' > 5` is a mistake in
  // the rule, not a comparison, and answering it would hide the mistake.
  if (typeof a !== 'number' || typeof b !== 'number') return UNKNOWN;
  switch (op) {
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '<': return a < b;
    default: return UNKNOWN;
  }
}

function evalNode(node, ctx, missing) {
  switch (node.k) {
    case 'lit':
      return node.v;
    case 'path': {
      const v = readPath(ctx, node.parts);
      if (v === UNKNOWN) missing.add(node.raw);
      return v;
    }
    case 'not': {
      const v = evalNode(node.a, ctx, missing);
      return v === UNKNOWN ? UNKNOWN : !truthy(v);
    }
    case 'cmp':
      return compare(node.op, evalNode(node.a, ctx, missing), evalNode(node.b, ctx, missing));
    case 'and': {
      // Both sides are always evaluated: short-circuiting would hide which
      // fields a rule needed, and "which fields were missing" is half the answer
      // the operator is owed.
      const a = evalNode(node.a, ctx, missing);
      const b = evalNode(node.b, ctx, missing);
      if (a !== UNKNOWN && !truthy(a)) return false;
      if (b !== UNKNOWN && !truthy(b)) return false;
      if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
      return true;
    }
    case 'or': {
      const a = evalNode(node.a, ctx, missing);
      const b = evalNode(node.b, ctx, missing);
      if (a !== UNKNOWN && truthy(a)) return true;
      if (b !== UNKNOWN && truthy(b)) return true;
      if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
      return false;
    }
    default:
      return UNKNOWN;
  }
}

const truthy = (v) => v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v !== '');

// Compiles a rule once. Returns { source, paths, run(ctx) }; `run` gives
// { value: true|false|null, missing: [...] } where null means UNKNOWN.
// Throws ExprError on anything outside the grammar — call it at load time.
function compile(source) {
  if (typeof source !== 'string' || source.trim() === '') throw new ExprError('a rule must be a non-empty string');
  if (source.length > MAX_EXPR_LENGTH) throw new ExprError(`a rule must be at most ${MAX_EXPR_LENGTH} characters`);
  const ast = parse(tokenize(source), source);
  const paths = [];
  (function collect(n) {
    if (!n || typeof n !== 'object') return;
    if (n.k === 'path') { if (!paths.includes(n.raw)) paths.push(n.raw); return; }
    collect(n.a); collect(n.b);
  }(ast));
  return {
    source,
    paths,
    run(ctx) {
      const missing = new Set();
      const v = evalNode(ast, ctx && typeof ctx === 'object' ? ctx : {}, missing);
      return { value: v === UNKNOWN ? null : truthy(v), missing: [...missing] };
    },
  };
}

module.exports = { compile, ExprError, UNKNOWN, MAX_EXPR_LENGTH, FORBIDDEN_KEYS };
