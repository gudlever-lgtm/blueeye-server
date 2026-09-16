'use strict';

// Matching a description to playbooks, WITHOUT an LLM.
//
// This is the floor the whole module stands on. The AI mapping in
// src/diagnose/llm.js is an accelerator on top; if it is switched off, times
// out, or answers with something that is not in the catalogue, the plan still
// has to be useful. So this has to be good enough on its own, not a stub that
// exists to be a fallback.
//
// PURE and deterministic: a description and the catalogue in, a ranked list out.
// No clock, no database, no network, no state.
//
// How it scores, in the order the signals deserve:
//
//   1. A SYMPTOM PHRASE the playbook already knows. Symptoms are written the way
//      somebody reports the fault ("connects but data is lost"), so the words
//      landing together is much stronger evidence than the same words scattered
//      through a paragraph. A phrase scores by how much of ITSELF the
//      description covers, so a long specific symptom that matches fully beats a
//      short vague one that also matches fully.
//   2. KEYWORDS. Each distinct keyword found is a point. These are the technical
//      terms — mtu, crc, duplex, discard — and one of them is often the whole
//      diagnosis.
//   3. The TITLE's own words, weakly: somebody who writes "duplex" has named it.
//
// Every locale's vocabulary is searched at once. A Danish technician pastes an
// English error message roughly every other outage, and a matcher that only
// looked in one language would lose the best signal in the sentence.

const { DEFAULT_LOCALE } = require('./catalog');

// The longest description we will read. The API rejects longer; this is the
// belt-and-braces bound so the matcher can never be handed a book.
const MAX_DESCRIPTION = 1000;

// Words that carry no diagnostic signal in either language. Kept short on
// purpose: a stop-word list that grows starts eating real terms ("no", "not"
// and "one" all matter somewhere), and the scoring already discounts a word
// that appears in every playbook.
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'it', 'we', 'i', 'that', 'this', 'there', 'when',
  'from', 'for', 'with', 'as', 'by', 'our', 'us', 'do', 'does', 'did', 'has', 'have',
  'og', 'eller', 'men', 'er', 'var', 'som', 'til', 'af', 'i', 'på', 'den', 'det',
  'de', 'en', 'et', 'vi', 'der', 'da', 'at', 'for', 'med', 'om', 'har', 'kan',
  'skal', 'vil', 'bliver', 'blev', 'man', 'så', 'ved',
]);

// Points. Deliberately small integers: the ordering is the product, and a
// scoring scheme nobody can do in their head is a scoring scheme nobody trusts.
const WEIGHT = { symptomPhrase: 10, keyword: 3, titleWord: 1 };
// A phrase has to be more than half present before it counts at all. Below that
// it is a couple of common words coinciding, not a symptom.
const PHRASE_FLOOR = 0.55;
const TOP_N = 3;

// Lowercase, strip punctuation, split. Danish keeps its letters: "forbindelsen"
// must not become "forbindelsen" minus its vowels because a regex was written
// for ASCII.
function tokenize(text) {
  return String(text || '')
    .slice(0, MAX_DESCRIPTION)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// Danish and English both inflect at the END, and a technician writes "pakkerne"
// where the playbook says "pakker", or "mister" where it says "mistes". A prefix
// test alone does not cover that second case at all — neither "mister" nor
// "mistes" is a prefix of the other — and in Danish that case is most of them.
//
// So: strip the longest inflectional ending that still leaves a real stem, then
// compare stems. Four characters is the floor, and it is doing real work — it is
// what stops "hvor" becoming "hvo", "det" becoming "de" and "port" becoming
// "por". This is a suffix list, not a linguistic stemmer, which is the right
// size of tool: the words being matched are a technician's vocabulary and a
// short keyword list, not prose.
const STEM_MIN = 4;
const SUFFIXES = ['erne', 'ende', 'ene', 'ede', 'ing', 'er', 'es', 'et', 'en', 'ne', 'ed', 'e', 's', 't', 'r'];

function stem(word) {
  for (const suf of SUFFIXES) {
    if (word.length - suf.length >= STEM_MIN && word.endsWith(suf)) return word.slice(0, -suf.length);
  }
  return word;
}

// Stripping ONE suffix is not enough, and the reason is subtle: Danish stacks
// them, so "morgenen" strips to "morgen" while "morgen" itself strips to
// "morg", and the two words a reader would call identical land in different
// places. Comparing the whole chain of forms instead of one stem makes the test
// symmetric, which is the property that was actually missing.
function forms(word) {
  const out = [word];
  let cur = word;
  for (let i = 0; i < 2; i += 1) {
    const next = stem(cur);
    if (next === cur) break;
    out.push(next);
    cur = next;
  }
  return out;
}

function wordsMatch(a, b) {
  if (a === b) return true;
  const fa = forms(a);
  const fb = forms(b);
  if (fa.some((x) => fb.includes(x))) return true;
  // A compound still wants to match its head ("pakketab" against "pakke"), so a
  // prefix test survives alongside the stemmer — but only for stems long enough
  // that the coincidences do not outnumber the catches.
  const sa = fa[fa.length - 1];
  const sb = fb[fb.length - 1];
  const short = sa.length <= sb.length ? sa : sb;
  const long = sa.length <= sb.length ? sb : sa;
  return short.length >= 5 && long.startsWith(short);
}

// How many playbooks use each keyword. A word that half the catalogue claims
// ("loss", "slow") says almost nothing about WHICH fault this is, while one only
// a single playbook uses ("crc", "starttls", "spidsbelastning") is very nearly
// the diagnosis on its own. So a keyword is worth its weight divided by the
// number of playbooks carrying it. Without this, adding an honest generic term
// to one playbook quietly makes it the answer to every question — which is
// exactly what happened the first time these two fixtures were run.
function keywordSpread(all) {
  const df = new Map();
  for (const pb of all) {
    const seen = new Set();
    for (const words of Object.values(pb.keywords)) {
      for (const kw of words) {
        if (seen.has(kw)) continue;
        seen.add(kw);
        df.set(kw, (df.get(kw) || 0) + 1);
      }
    }
  }
  return df;
}

// How much of `phrase` the description covers, 0..1. Word order is ignored: a
// person describing a fault does not reproduce the phrasebook's grammar.
function phraseCoverage(phraseWords, descWords) {
  if (phraseWords.length === 0) return 0;
  let hit = 0;
  for (const pw of phraseWords) {
    if (descWords.some((dw) => wordsMatch(pw, dw))) hit += 1;
  }
  return hit / phraseWords.length;
}

// A keyword may be a phrase ("load balance", "layer 1"). A multi-word keyword
// must appear as a run in the original text; a single word matches a token.
function keywordHit(keyword, descWords, descText) {
  if (keyword.includes(' ')) return descText.includes(keyword);
  return descWords.some((dw) => wordsMatch(keyword, dw));
}

// Ranks the catalogue against a free-text description.
//
// Returns [{ id, score, confidence, matchedOn: { symptoms, keywords } }], best
// first, at most `limit`. Ties break on the catalogue's own order so the same
// description always produces the same list — an ordering that moves between
// identical runs is an ordering nobody can test or trust.
function matchPlaybooks(description, catalog, { limit = TOP_N, locale = DEFAULT_LOCALE } = {}) {
  const descText = String(description || '').slice(0, MAX_DESCRIPTION).toLowerCase();
  const descWords = tokenize(description);
  if (descWords.length === 0) return [];

  const all = catalog.list();
  const df = keywordSpread(all);
  const scored = all.map((pb, index) => {
    const matchedSymptoms = [];
    const matchedKeywords = [];
    let score = 0;

    // 1. symptom phrases, every locale
    for (const [loc, phrases] of Object.entries(pb.symptomsLower)) {
      for (let i = 0; i < phrases.length; i += 1) {
        const coverage = phraseCoverage(tokenize(phrases[i]), descWords);
        if (coverage < PHRASE_FLOOR) continue;
        score += WEIGHT.symptomPhrase * coverage;
        // Report it in the reader's own language where we have it.
        matchedSymptoms.push(pb.symptoms[locale] && loc === locale ? pb.symptoms[loc][i] : pb.symptoms[loc][i]);
      }
    }

    // 2. keywords, every locale, counted once per distinct word
    const seenKeyword = new Set();
    for (const words of Object.values(pb.keywords)) {
      for (const kw of words) {
        if (seenKeyword.has(kw)) continue;
        if (!keywordHit(kw, descWords, descText)) continue;
        seenKeyword.add(kw);
        score += WEIGHT.keyword / (df.get(kw) || 1);
        matchedKeywords.push(kw);
      }
    }

    // 3. the title's own words
    for (const t of Object.values(pb.title)) {
      for (const w of tokenize(t)) {
        if (descWords.some((dw) => wordsMatch(w, dw))) score += WEIGHT.titleWord;
      }
    }

    return {
      id: pb.id,
      score: Math.round(score * 100) / 100,
      index,
      matchedOn: { symptoms: [...new Set(matchedSymptoms)], keywords: matchedKeywords },
    };
  });

  const hits = scored.filter((s) => s.score > 0);
  hits.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  const top = hits.slice(0, limit);
  // Confidence is relative to the best match, not absolute: the score has no
  // ceiling (a long description matching many keywords scores higher than a
  // short one) so an absolute number would mean different things for different
  // sentences. What a reader wants to know is how far ahead the leader is.
  const best = top.length ? top[0].score : 0;
  return top.map((h) => ({
    id: h.id,
    score: h.score,
    confidence: best > 0 ? Math.round((h.score / best) * 100) / 100 : 0,
    matchedOn: h.matchedOn,
  }));
}

module.exports = { matchPlaybooks, tokenize, phraseCoverage, wordsMatch, stem, forms, keywordSpread, MAX_DESCRIPTION, WEIGHT, TOP_N };
