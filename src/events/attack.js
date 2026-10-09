'use strict';

// MITRE ATT&CK, as far as this product honestly goes.
//
// WHAT ATT&CK IS NOT. It is not an indicator feed. There are no addresses, no
// hashes and no domains in it — it is a taxonomy of adversary BEHAVIOUR
// (tactics and techniques). So there is nothing here to match against: the
// matching is the one BlueEyes already does (src/events/severityRules.js), and
// ATT&CK only gives the match a name that other tools recognise.
//
// WHO IS SPEAKING. docs/attack-indication.md says the detectors do not name a
// technique, and that restraint is deliberate — 212 failed logins is equally
// consistent with a misconfigured backup job, and a red line over a sentence
// that turns out to be the backup job teaches an operator to stop reading the
// line. A technique on a PATTERN is the operator's statement instead, beside
// the `reason` the pattern already requires, with their account in the audit
// log. That is the only place in this codebase where a technique is asserted.
//
// WHAT IS DELIBERATELY ABSENT. No technique catalogue, no STIX parsing, no sync
// against ATT&CK's repository. SUGGESTED below is a short list for the form's
// datalist; any well-formed technique id is accepted, because a customer who
// has mapped something we have not heard of is right.

// The fourteen ATT&CK Enterprise tactics, in the order the published matrix
// shows them — which is also roughly the order an intrusion moves through, and
// therefore the order the kill-chain strip reads left to right.
//
// This list IS closed. They are the columns of the matrix, and an ATT&CK
// Navigator layer has to name one of them to open at all.
const TACTICS = [
  { id: 'reconnaissance', code: 'TA0043', name: 'Reconnaissance' },
  { id: 'resource-development', code: 'TA0042', name: 'Resource Development' },
  { id: 'initial-access', code: 'TA0001', name: 'Initial Access' },
  { id: 'execution', code: 'TA0002', name: 'Execution' },
  { id: 'persistence', code: 'TA0003', name: 'Persistence' },
  { id: 'privilege-escalation', code: 'TA0004', name: 'Privilege Escalation' },
  { id: 'defense-evasion', code: 'TA0005', name: 'Defense Evasion' },
  { id: 'credential-access', code: 'TA0006', name: 'Credential Access' },
  { id: 'discovery', code: 'TA0007', name: 'Discovery' },
  { id: 'lateral-movement', code: 'TA0008', name: 'Lateral Movement' },
  { id: 'collection', code: 'TA0009', name: 'Collection' },
  { id: 'command-and-control', code: 'TA0011', name: 'Command and Control' },
  { id: 'exfiltration', code: 'TA0010', name: 'Exfiltration' },
  { id: 'impact', code: 'TA0040', name: 'Impact' },
];

const TACTIC_IDS = TACTICS.map((x) => x.id);
const TACTIC_BY_ID = new Map(TACTICS.map((x) => [x.id, x]));
// Where a tactic sits in the matrix, so the strip can be sorted without
// re-deriving the order from the array every time.
const TACTIC_ORDER = new Map(TACTICS.map((x, i) => [x.id, i]));

// A suggestion list for the pattern form, and nothing more — not a whitelist,
// not a mapping the server applies on its own. `metrics` says which of this
// product's own detectors the technique plausibly fits, so the form can offer
// the likely ones first for the match the operator has just typed.
//
// The two `peer.*` detectors appear against NO technique on purpose. "This site
// has never reached that network before" is a first sighting, not an adversary
// behaviour; mapping it to T1041 Exfiltration would turn a cloud migration into
// an exfiltration alert, and an operator who wants it mapped anyway can type a
// technique in — with a reason, which is the point.
const SUGGESTED = [
  { technique: 'T1595', name: 'Active Scanning', tactic: 'reconnaissance', metrics: ['net.scan'] },
  { technique: 'T1190', name: 'Exploit Public-Facing Application', tactic: 'initial-access', metrics: [] },
  { technique: 'T1133', name: 'External Remote Services', tactic: 'initial-access', metrics: ['security.vpn_failure'] },
  { technique: 'T1200', name: 'Hardware Additions', tactic: 'initial-access', metrics: ['security.port_violation'] },
  { technique: 'T1110', name: 'Brute Force', tactic: 'credential-access', metrics: ['security.auth_failure', 'security.vpn_failure'] },
  { technique: 'T1046', name: 'Network Service Discovery', tactic: 'discovery', metrics: ['net.scan', 'security.acl_denied'] },
  { technique: 'T1018', name: 'Remote System Discovery', tactic: 'discovery', metrics: ['net.scan'] },
  { technique: 'T1021', name: 'Remote Services', tactic: 'lateral-movement', metrics: [] },
  { technique: 'T1071', name: 'Application Layer Protocol', tactic: 'command-and-control', metrics: ['net.beacon'] },
  { technique: 'T1571', name: 'Non-Standard Port', tactic: 'command-and-control', metrics: ['net.beacon'] },
  { technique: 'T1572', name: 'Protocol Tunneling', tactic: 'command-and-control', metrics: ['net.beacon'] },
  { technique: 'T1041', name: 'Exfiltration Over C2 Channel', tactic: 'exfiltration', metrics: [] },
  { technique: 'T1048', name: 'Exfiltration Over Alternative Protocol', tactic: 'exfiltration', metrics: [] },
  { technique: 'T1498', name: 'Network Denial of Service', tactic: 'impact', metrics: [] },
];

// 'T1110' or 'T1110.001'. Shape only — see the note above about not arguing
// with a customer who has mapped a technique this list has never heard of.
const TECHNIQUE_RE = /^T\d{4}(\.\d{3})?$/;
const isTechniqueId = (v) => typeof v === 'string' && TECHNIQUE_RE.test(v.trim());

function tacticName(id) {
  const t = TACTIC_BY_ID.get(String(id || ''));
  return t ? t.name : null;
}

// The suggested name for a technique id, or null for one we do not know — which
// is not an error, it is a technique the operator knows and we do not.
function techniqueName(id) {
  const hit = SUGGESTED.find((s) => s.technique === String(id || '').trim());
  return hit ? hit.name : null;
}

// Reads `attack_technique` / `attack_tactic` off a pattern the operator is
// saving, into `value`, recording problems in `errors`.
//
// BOTH OR NEITHER. A technique with no tactic cannot be grouped, exported or
// shown on the strip; a tactic with no technique is a column with nothing in
// it. Half a mapping looks like a mapping on every screen and behaves like
// none, so it is refused rather than half-applied.
function validateAttack(input, value, errors) {
  if (!input || typeof input !== 'object') return;
  const rawTechnique = input.attack_technique;
  const rawTactic = input.attack_tactic;
  const blank = (v) => v === undefined || v === null || String(v).trim() === '';

  if (blank(rawTechnique) && blank(rawTactic)) {
    value.attack_technique = null;
    value.attack_tactic = null;
    return;
  }
  if (blank(rawTechnique)) {
    errors.attack_technique = 'name the technique as well, or leave the tactic blank — half a mapping groups as nothing';
  } else if (!isTechniqueId(rawTechnique)) {
    errors.attack_technique = 'a technique id looks like T1110, or T1110.001 for a sub-technique';
  } else {
    value.attack_technique = String(rawTechnique).trim();
  }

  if (blank(rawTactic)) {
    errors.attack_tactic = 'pick the tactic this technique is being used for — a technique can belong to more than one';
  } else if (!TACTIC_IDS.includes(String(rawTactic).trim())) {
    errors.attack_tactic = `tactic must be one of: ${TACTIC_IDS.join(', ')}`;
  } else {
    value.attack_tactic = String(rawTactic).trim();
  }
}

// Groups mapped patterns by tactic, in matrix order, with whatever tally the
// caller has counted per pattern id. Pure: patterns and a count map in, the
// strip's rows out.
//
//   tacticsOf(patterns, counts) ->
//     [{ id, code, name, patterns: [{id, name, technique}], count, worst }]
//
// Only tactics with at least one mapped pattern appear. A strip that drew all
// fourteen columns for an install that maps three would be a wall of empty
// cells saying the product cannot see anything — and the honest claim is the
// opposite: it sees three of them, deliberately.
function tacticsOf(patterns, counts = new Map()) {
  const rank = { INFO: 0, WARN: 1, CRIT: 2 };
  const byTactic = new Map();
  for (const p of (Array.isArray(patterns) ? patterns : [])) {
    if (!p || !p.attack_tactic || !p.attack_technique) continue;
    if (!TACTIC_BY_ID.has(p.attack_tactic)) continue;
    const cell = byTactic.get(p.attack_tactic) || {
      ...TACTIC_BY_ID.get(p.attack_tactic), patterns: [], count: 0, worst: null,
    };
    const hit = counts.get(p.id) || counts.get(String(p.id)) || null;
    const n = hit ? Number(hit.count || hit) || 0 : 0;
    const worst = hit && hit.worst ? hit.worst : null;
    cell.patterns.push({
      id: p.id,
      name: p.name,
      technique: p.attack_technique,
      technique_name: techniqueName(p.attack_technique),
      count: n,
    });
    cell.count += n;
    if (worst && (rank[worst] ?? -1) > (rank[cell.worst] ?? -1)) cell.worst = worst;
    byTactic.set(p.attack_tactic, cell);
  }
  return [...byTactic.values()].sort((a, b) => TACTIC_ORDER.get(a.id) - TACTIC_ORDER.get(b.id));
}

// An ATT&CK Navigator layer (layer format 4.5) for the official, free viewer.
//
// WHY AN EXPORT AND NOT A MATRIX IN THE DASHBOARD. The published matrix is
// fourteen columns and some two hundred techniques. An install that maps eight
// of them renders as a grey wall with three dots in it — which reads as "this
// product sees nothing" when the truth is the opposite. Navigator already draws
// the matrix properly, it is free, and it is what a security team already has
// open. So the product's own screen shows the tactics it actually covers, and
// anybody who wants the full matrix gets a file for the tool that is built for
// one.
//
// `score` is how many open events each technique covers right now, so a layer
// opened during an incident shades the techniques that are live. A mapped
// technique with nothing open stays at 0 and still appears — that is the
// coverage half of the question.
function navigatorLayer(patterns, counts = new Map(), { name = 'BlueEyes', description = null } = {}) {
  const byTechnique = new Map();
  for (const p of (Array.isArray(patterns) ? patterns : [])) {
    if (!p || !p.attack_technique || !p.attack_tactic) continue;
    if (!TACTIC_BY_ID.has(p.attack_tactic)) continue;
    const hit = counts.get(p.id) || counts.get(String(p.id)) || null;
    const n = hit ? Number(hit.count || hit) || 0 : 0;
    const key = `${p.attack_technique}|${p.attack_tactic}`;
    const cell = byTechnique.get(key) || {
      techniqueID: p.attack_technique,
      tactic: p.attack_tactic,
      score: 0,
      enabled: true,
      comments: [],
    };
    cell.score += n;
    // The operator's own words are what makes the layer worth reading in six
    // months — a cell that only says "T1110" says nothing a matrix did not.
    cell.comments.push(`${p.name}: ${p.reason || ''}`.trim());
    byTechnique.set(key, cell);
  }
  const techniques = [...byTechnique.values()].map((c) => ({
    techniqueID: c.techniqueID,
    tactic: c.tactic,
    score: c.score,
    enabled: true,
    comment: c.comments.join(' · ').slice(0, 1000),
  }));
  return {
    name,
    versions: { layer: '4.5', navigator: '4.9.0' },
    domain: 'enterprise-attack',
    description: description
      || 'Techniques BlueEyes has been told it covers. The score is how many open events each one covers right now.',
    techniques,
    gradient: {
      // Grey where nothing is open, through to red where a lot is: the same
      // reading as the rest of the product, where grey is "nothing to do".
      colors: ['#8a8a8a', '#ffd966', '#d94f4f'],
      minValue: 0,
      maxValue: Math.max(1, ...techniques.map((x) => x.score)),
    },
    legendItems: [],
    showTacticRowBackground: true,
    sorting: 0,
  };
}

module.exports = {
  TACTICS, TACTIC_IDS, SUGGESTED, TECHNIQUE_RE,
  isTechniqueId, tacticName, techniqueName, validateAttack, tacticsOf, navigatorLayer,
};
