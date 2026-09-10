'use strict';

// Discovery safety (spec §8).
//
// Discovery is READ-ONLY by default. It may look at anything inside the
// application's scope, and it must never do something that changes data: create,
// delete, pay, send, reset a password, submit an unknown form.
//
// Getting this wrong is not a bug that shows up in a test run — it is a deleted
// customer record in someone's production system. So the rule is inverted from
// the usual: an element is treated as SAFE only when we can see why. Anything
// ambiguous is marked `potentially_destructive` and left alone.
//
// Pure: element description in, verdict out.

// Words that mean "this changes something", in the languages the UI serves.
// Matched as whole-ish words against the visible text, the accessible name and
// the form action, lowercased.
const DESTRUCTIVE_WORDS = [
  // English
  'delete', 'remove', 'destroy', 'drop', 'purge', 'erase', 'wipe',
  'create', 'add', 'new', 'save', 'submit', 'send', 'post', 'publish',
  'pay', 'purchase', 'buy', 'checkout', 'order', 'subscribe', 'confirm',
  'update', 'edit', 'change', 'reset', 'revoke', 'disable', 'enable',
  'invite', 'transfer', 'approve', 'reject', 'cancel', 'archive', 'restore',
  'upload', 'import', 'export', 'sync', 'run', 'execute', 'deploy', 'restart',
  // Danish
  'slet', 'fjern', 'opret', 'tilføj', 'gem', 'send', 'indsend', 'betal',
  'køb', 'bestil', 'bekræft', 'opdater', 'rediger', 'ændr', 'nulstil',
  'deaktiver', 'aktiver', 'inviter', 'overfør', 'godkend', 'afvis',
  'annuller', 'arkivér', 'gendan', 'upload', 'importer', 'eksporter',
  'kør', 'genstart',
];

// Paths that are dangerous to even navigate to, regardless of the element's text.
const DESTRUCTIVE_PATH_HINTS = [
  '/delete', '/remove', '/destroy', '/logout', '/signout', '/sign-out',
  '/reset', '/pay', '/payment', '/checkout', '/purchase', '/order/confirm',
  '/admin/', '/settings/', '/api/', '/export', '/import',
];

// Navigation words that are safe to follow: they read, they do not write.
const SAFE_WORDS = [
  'view', 'show', 'details', 'open', 'read', 'search', 'find', 'filter',
  'next', 'previous', 'back', 'home', 'list', 'overview', 'dashboard',
  'vis', 'detaljer', 'åbn', 'læs', 'søg', 'find', 'filtrer', 'næste',
  'forrige', 'tilbage', 'forside', 'oversigt',
];

const lower = (v) => String(v == null ? '' : v).toLowerCase();

function containsWord(haystack, words) {
  const h = lower(haystack);
  if (!h) return null;
  for (const word of words) {
    // Word-ish boundary: the word surrounded by anything that is not a letter.
    // Avoids "created" matching on "create" being absent, and "reorder" on "order".
    const re = new RegExp(`(^|[^a-zæøå])${word}([^a-zæøå]|$)`, 'i');
    if (re.test(h)) return word;
  }
  return null;
}

// Verdict for one discovered element.
//   { destructive: boolean, reason: string|null, safe_reason: string|null }
function classifyElement(element = {}) {
  const el = element && typeof element === 'object' ? element : {};
  const kind = lower(el.kind);
  const text = `${el.label || ''} ${el.text || ''} ${el.ariaLabel || ''} ${el.value || ''}`;
  const href = lower(el.href || el.action || '');
  const method = lower(el.method || '');

  // A form that is not a GET submits state. Never activated.
  if (kind === 'form') {
    if (method && method !== 'get') {
      return { destructive: true, reason: `form submits with ${method.toUpperCase()}` };
    }
    // A GET form (a search box, typically) does not write. Discovery still never
    // submits it — filling in someone's search field is not reading — but the
    // reason should say that rather than imply it writes.
    return { destructive: true, reason: 'Discovery never submits forms, so its effect is left untested' };
  }

  // A submit button belongs to a form; same reasoning.
  if (lower(el.type) === 'submit' || lower(el.type) === 'reset') {
    return { destructive: true, reason: `a ${lower(el.type)} button activates a form` };
  }

  const word = containsWord(text, DESTRUCTIVE_WORDS);
  if (word) return { destructive: true, reason: `the wording "${word}" suggests it changes data` };

  for (const hint of DESTRUCTIVE_PATH_HINTS) {
    if (href.includes(hint)) return { destructive: true, reason: `the address contains "${hint}"` };
  }

  // A link with an ordinary http(s) href that reads as navigation is followable.
  if (kind === 'link') {
    const safe = containsWord(text, SAFE_WORDS);
    if (safe) return { destructive: false, reason: null, safe_reason: `"${safe}" reads as navigation` };
    if (href && /^(https?:)?\/\//.test(href)) return { destructive: false, reason: null, safe_reason: 'an ordinary link' };
    if (href.startsWith('/') || href.startsWith('?') || href.startsWith('#')) {
      return { destructive: false, reason: null, safe_reason: 'a same-site link' };
    }
  }

  // Anything else — an unlabelled button, a control we cannot read — is left
  // alone. This is the branch that keeps Discovery honest.
  if (kind === 'button') {
    return { destructive: true, reason: 'the effect of this button could not be determined' };
  }

  return { destructive: false, reason: null, safe_reason: 'not an activating element' };
}

// May the crawler follow this link? Scope is the caller's business (crawl.js);
// this only answers the safety half.
function isFollowable(element) {
  if (lower(element && element.kind) !== 'link') return false;
  return !classifyElement(element).destructive;
}

module.exports = {
  classifyElement, isFollowable, containsWord,
  DESTRUCTIVE_WORDS, DESTRUCTIVE_PATH_HINTS, SAFE_WORDS,
};
