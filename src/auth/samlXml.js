'use strict';

const crypto = require('crypto');

// Hand-rolled, dependency-free XML support for SAML 2.0 assertion verification:
// a small namespace-aware parser, EXCLUSIVE XML canonicalization (exc-c14n, no
// comments) and XML-DSig signature/digest verification. No US SDK, no XML
// library — just Node's crypto. It implements the narrow slice of XML-DSig that
// SAML IdPs (Keycloak, Authentik, SimpleSAMLphp, …) emit: a single enveloped
// signature with an exc-c14n transform over an element referenced by its ID.
//
// SECURITY NOTE: verification trusts ONLY the element that was actually digested
// + referenced (returned as `signedId`); the caller must read its claims from
// THAT element, which defeats signature-wrapping (XSW) attacks.

// ---- entities -------------------------------------------------------------

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (ent) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return m;
    }
  });
}

// c14n attribute-value escaping.
function escapeAttr(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#xD;')
    .replace(/\n/g, '&#xA;')
    .replace(/\t/g, '&#x9;');
}

// c14n text-node escaping.
function escapeText(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;');
}

// ---- parser ---------------------------------------------------------------

function splitQName(q) {
  const idx = q.indexOf(':');
  return idx < 0 ? { prefix: '', local: q } : { prefix: q.slice(0, idx), local: q.slice(idx + 1) };
}

// Finds the index of the '>' that closes a tag starting at `<`, skipping any
// quoted attribute values that might contain '>'.
function findTagEnd(xml, start) {
  let i = start + 1;
  let quote = null;
  const n = xml.length;
  while (i < n) {
    const c = xml[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
    i += 1;
  }
  throw new Error('XML parse error: unterminated tag');
}

function parseAttributes(s) {
  const attrs = [];
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const name = m[1];
    const value = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
    attrs.push({ name, value });
  }
  return attrs;
}

// Parses an XML string into a lightweight element tree. Each element node:
//   { type:'element', qname, prefix, local, attributes:[{qname,prefix,local,value}],
//     nsdecls:{ '<prefix>': uri }, children:[…], parent }
// Text nodes: { type:'text', value }.
// The tree walkers below (iterElements/canonicalize/textOf) recurse over element
// depth, so an attacker-supplied, deeply-nested document on the public ACS could
// blow the call stack (RangeError) before the signature is ever checked. The
// parser here is iterative and knows the live depth, so cap it: a legitimate SAML
// assertion nests only a handful of levels.
const MAX_DEPTH = 200;

function parseXml(xml) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  let i = 0;
  const n = xml.length;

  while (i < n) {
    if (xml[i] === '<') {
      if (xml.startsWith('<?', i)) { const e = xml.indexOf('?>', i); if (e < 0) throw new Error('bad PI'); i = e + 2; continue; }
      if (xml.startsWith('<!--', i)) { const e = xml.indexOf('-->', i); if (e < 0) throw new Error('bad comment'); i = e + 3; continue; }
      if (xml.startsWith('<![CDATA[', i)) {
        const e = xml.indexOf(']]>', i); if (e < 0) throw new Error('bad CDATA');
        stack[stack.length - 1].children.push({ type: 'text', value: xml.slice(i + 9, e) });
        i = e + 3; continue;
      }
      if (xml.startsWith('<!', i)) { const e = xml.indexOf('>', i); if (e < 0) throw new Error('bad declaration'); i = e + 1; continue; }
      if (xml[i + 1] === '/') { const e = xml.indexOf('>', i); if (e < 0) throw new Error('bad close tag'); stack.pop(); i = e + 1; continue; }

      const end = findTagEnd(xml, i);
      let inner = xml.slice(i + 1, end);
      let selfClose = false;
      if (inner.endsWith('/')) { selfClose = true; inner = inner.slice(0, -1); }
      const wsIdx = inner.search(/\s/);
      const qname = (wsIdx < 0 ? inner : inner.slice(0, wsIdx)).trim();
      const rawAttrs = wsIdx < 0 ? [] : parseAttributes(inner.slice(wsIdx));

      const { prefix, local } = splitQName(qname);
      const nsdecls = {};
      const attributes = [];
      for (const a of rawAttrs) {
        if (a.name === 'xmlns') nsdecls[''] = a.value;
        else if (a.name.startsWith('xmlns:')) nsdecls[a.name.slice(6)] = a.value;
        else { const sp = splitQName(a.name); attributes.push({ qname: a.name, prefix: sp.prefix, local: sp.local, value: a.value }); }
      }
      const node = { type: 'element', qname, prefix, local, attributes, nsdecls, children: [], parent: stack[stack.length - 1] };
      stack[stack.length - 1].children.push(node);
      if (!selfClose) {
        stack.push(node);
        if (stack.length > MAX_DEPTH) throw new Error('XML nesting too deep');
      }
      i = end + 1;
    } else {
      const next = xml.indexOf('<', i);
      const stop = next < 0 ? n : next;
      const text = xml.slice(i, stop);
      stack[stack.length - 1].children.push({ type: 'text', value: decodeEntities(text) });
      i = stop;
    }
  }
  return root.children.find((c) => c.type === 'element') || null;
}

// ---- tree helpers ---------------------------------------------------------

// All namespace declarations visible at `node` (ancestors merged, nearest wins).
function inScopeNs(node) {
  const chain = [];
  let cur = node;
  while (cur && cur.type === 'element') { chain.unshift(cur); cur = cur.parent; }
  const ns = {};
  for (const el of chain) for (const [k, v] of Object.entries(el.nsdecls || {})) ns[k] = v;
  return ns;
}

function* iterElements(node) {
  if (!node || node.type !== 'element') return;
  yield node;
  for (const c of node.children) if (c.type === 'element') yield* iterElements(c);
}

function findFirstByLocal(node, local) {
  for (const el of iterElements(node)) if (el.local === local) return el;
  return null;
}

function findAllByLocal(node, local) {
  const out = [];
  for (const el of iterElements(node)) if (el.local === local) out.push(el);
  return out;
}

// Finds the element whose ID/Id/id attribute equals `id`.
function findById(node, id) {
  for (const el of iterElements(node)) {
    for (const a of el.attributes) if ((a.local === 'ID' || a.local === 'Id' || a.local === 'id') && a.value === id) return el;
  }
  return null;
}

function attrValue(node, local) {
  if (!node) return null;
  for (const a of node.attributes) if (a.local === local || a.qname === local) return a.value;
  return null;
}

function textOf(node) {
  if (!node) return '';
  let out = '';
  for (const c of node.children) {
    if (c.type === 'text') out += c.value;
    else if (c.type === 'element') out += textOf(c);
  }
  return out;
}

// ---- exclusive canonicalization (exc-c14n, no comments) -------------------

function canonicalize(node, { renderedNs = {}, omit = null } = {}) {
  if (!node || node.type !== 'element') return '';
  const inscope = inScopeNs(node);

  // Visibly-utilized prefixes: the element's own + each prefixed attribute's.
  const utilized = new Set();
  utilized.add(node.prefix || '');
  for (const a of node.attributes) if (a.prefix) utilized.add(a.prefix);

  const toRender = [];
  for (const pfx of utilized) {
    if (pfx === '') {
      const uri = inscope[''];
      if (uri !== undefined && uri !== '' && renderedNs[''] !== uri) toRender.push({ pfx: '', uri });
    } else {
      const uri = inscope[pfx];
      if (uri !== undefined && renderedNs[pfx] !== uri) toRender.push({ pfx, uri });
    }
  }
  toRender.sort((a, b) => (a.pfx === '' ? -1 : b.pfx === '' ? 1 : a.pfx < b.pfx ? -1 : a.pfx > b.pfx ? 1 : 0));

  const newRendered = { ...renderedNs };
  let out = `<${node.qname}`;
  for (const { pfx, uri } of toRender) {
    out += pfx === '' ? ` xmlns="${escapeAttr(uri)}"` : ` xmlns:${pfx}="${escapeAttr(uri)}"`;
    newRendered[pfx] = uri;
  }

  const attrs = node.attributes.slice().sort((a, b) => {
    const au = a.prefix ? (inscope[a.prefix] || '') : '';
    const bu = b.prefix ? (inscope[b.prefix] || '') : '';
    if (au !== bu) return au < bu ? -1 : 1;
    return a.local < b.local ? -1 : a.local > b.local ? 1 : 0;
  });
  for (const a of attrs) out += ` ${a.qname}="${escapeAttr(a.value)}"`;
  out += '>';

  for (const c of node.children) {
    if (c === omit) continue;
    if (c.type === 'element') out += canonicalize(c, { renderedNs: newRendered, omit });
    else if (c.type === 'text') out += escapeText(c.value);
  }
  out += `</${node.qname}>`;
  return out;
}

// ---- signature verification ----------------------------------------------

const DIGEST_ALGS = {
  'http://www.w3.org/2001/04/xmlenc#sha256': 'sha256',
  'http://www.w3.org/2001/04/xmldsig-more#sha384': 'sha384',
  'http://www.w3.org/2001/04/xmlenc#sha512': 'sha512',
  'http://www.w3.org/2000/09/xmldsig#sha1': 'sha1',
};
const SIGNATURE_ALGS = {
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha384': 'sha384',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': 'sha512',
  'http://www.w3.org/2000/09/xmldsig#rsa-sha1': 'sha1',
  'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256': 'sha256',
};

// Wraps a bare-base64 cert in PEM armour, then imports its public key.
function publicKeyFromCert(cert) {
  let pem = String(cert || '').trim();
  if (!pem) throw new Error('no IdP certificate configured');
  if (!pem.includes('BEGIN CERTIFICATE')) {
    const body = pem.replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
    pem = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
  }
  return new crypto.X509Certificate(pem).publicKey;
}

// Verifies the (single) enveloped signature in a parsed SAML document against
// `cert`. Returns { ok:true, signedId } — the ID of the element that was actually
// digested + signed — or { ok:false, reason }.
function verifySignature(root, cert) {
  let pubKey;
  try { pubKey = publicKeyFromCert(cert); } catch (err) { return { ok: false, reason: `bad-cert: ${err.message}` }; }

  const sig = findFirstByLocal(root, 'Signature');
  if (!sig) return { ok: false, reason: 'no-signature' };
  const signedInfo = findFirstByLocal(sig, 'SignedInfo');
  const sigValueEl = findFirstByLocal(sig, 'SignatureValue');
  const reference = signedInfo && findFirstByLocal(signedInfo, 'Reference');
  const digestValueEl = reference && findFirstByLocal(reference, 'DigestValue');
  const digestMethod = reference && findFirstByLocal(reference, 'DigestMethod');
  const sigMethod = signedInfo && findFirstByLocal(signedInfo, 'SignatureMethod');
  if (!signedInfo || !sigValueEl || !reference || !digestValueEl || !digestMethod || !sigMethod) {
    return { ok: false, reason: 'malformed-signature' };
  }

  const digestAlg = DIGEST_ALGS[attrValue(digestMethod, 'Algorithm')];
  const sigAlg = SIGNATURE_ALGS[attrValue(sigMethod, 'Algorithm')];
  if (!digestAlg || !sigAlg) return { ok: false, reason: 'unsupported-algorithm' };

  const refUri = attrValue(reference, 'URI') || '';
  const signedId = refUri.replace(/^#/, '');
  const referenced = signedId ? findById(root, signedId) : root;
  if (!referenced) return { ok: false, reason: 'reference-not-found' };

  // Enveloped-signature transform: digest the referenced element with its own
  // signature omitted, then exc-c14n.
  const refC14n = canonicalize(referenced, { omit: sig });
  const computed = crypto.createHash(digestAlg).update(refC14n, 'utf8').digest('base64');
  if (computed !== textOf(digestValueEl).trim()) return { ok: false, reason: 'digest-mismatch' };

  // Verify the signature over the canonicalized SignedInfo.
  const siC14n = canonicalize(signedInfo);
  let ok = false;
  try {
    ok = crypto.verify(digestAlgToVerify(sigAlg), Buffer.from(siC14n, 'utf8'), pubKey, Buffer.from(textOf(sigValueEl).trim(), 'base64'));
  } catch { ok = false; }
  if (!ok) return { ok: false, reason: 'bad-signature' };

  return { ok: true, signedId };
}

function digestAlgToVerify(alg) { return alg; }

module.exports = {
  parseXml, canonicalize, verifySignature,
  findFirstByLocal, findAllByLocal, findById, attrValue, textOf, inScopeNs,
  publicKeyFromCert, escapeAttr, escapeText,
};
