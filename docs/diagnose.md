# Symptom-first diagnosis

> A technician writes what is wrong in their own words. BlueEyes answers with a
> plan — the likely causes, the tests to run with their parameters filled in,
> the screens to open and what to look for in each, and what each answer would
> mean. Run the tests, and every cause comes back **confirmed**, **ruled out**
> or **open**, with the rule and the measurement that decided it.

**Nav:** Diagnostics → Diagnose · **API:** `/api/diagnose`, `/api/playbooks`
**Code:** `src/diagnose/`, `src/routes/diagnose.js`, `public/app.js` (`views.diagnose`)

---

## Why it is built this way

Four decisions, and the rest follows from them.

**The catalogue comes first; the LLM is a helper.** Everything BlueEyes knows
about network faults — causes, the tests that tell them apart, the rules for
reading the results, the fixes — is data in `src/diagnose/playbooks/*.json`. The
module works completely with AI switched off: a local keyword and symptom
matcher picks the candidates. That is not a degraded mode kept around as a
fallback. It is the product, and the AI makes it faster.

**The LLM may only choose from the catalogue.** It maps free text onto playbook
ids and fills in entities. It cannot invent a test type, a threshold or a fix.
Its answer is validated against the catalogue and anything unknown is discarded
— not corrected into its nearest neighbour, which would hand the operator a
hallucination wearing a real name.

**Verdicts are decided in code.** The reading rules are evaluated by a small
expression evaluator, never by a model. The AI writes the summary paragraph
*after* the verdicts exist, and its own prompt tells it so.

**The user's description is data.** It travels as a JSON string value alongside
the catalogue the model must choose from, never concatenated into instructions.

---

## The shape of a playbook

One JSON file per playbook, named after its id. Every human-readable string is
`{ en, da }` and **both are required** — the catalogue is the matcher's input,
and a playbook with no Danish keywords cannot be found by anybody describing the
fault in Danish, silently.

```jsonc
{
  "id": "mtu_blackhole",
  "title":       { "en": "MTU / PMTUD blackhole", "da": "MTU/PMTUD-blackhole" },
  "summary":     { "en": "…", "da": "…" },
  "explanation": { "en": "…", "da": "…" },
  "symptoms":    { "en": ["connects but data is lost"], "da": ["forbinder men data går tabt"] },
  "keywords":    { "en": ["mtu", "mss", "starttls"],    "da": ["mtu", "mss", "afbrydes"] },

  "tests": [
    { "type": "ping",     "params": { "sizes": [64, 1472], "df": true }, "why": { "en": "…", "da": "…" } },
    { "type": "path_mtu", "params": { "perHop": true },                  "why": { "en": "…", "da": "…" } }
  ],
  "views": [
    { "view": "probes", "params": { "tab": "path" }, "look_for": { "en": "…", "da": "…" } }
  ],
  "rules": [
    { "id": "loss_size_dependent",
      "when": "ping.size_64.loss_pct == 0 && ping.size_1472.loss_pct >= 50",
      "effect": "confirm",
      "because": { "en": "…", "da": "…" } }
  ],
  "fixes": [
    { "en": "Clamp MSS on the tunnel router to {path_mtu.recommended_mss}.",
      "da": "MSS clamping på tunnel-routeren til {path_mtu.recommended_mss}." }
  ]
}
```

### Adding one takes no code change

Drop a file in `src/diagnose/playbooks/`. It is picked up at boot, validated,
matchable immediately, and covered by the existing tests. What it must satisfy:

| Rule | Why |
| --- | --- |
| `id` is lower_snake_case and matches the filename | a reader looking for `mtu_blackhole` finds `mtu_blackhole.json` |
| every string has `en` **and** `da` | see above — a missing locale fails silently, so it fails loudly instead |
| every `tests[].type` is a real probe type | checked against `PROBE_TYPES`; a test nothing can run is not a plan |
| every `views[].view` is a real screen | a link that goes nowhere is worse than no link |
| every `tests[].why` and `views[].look_for` is present | a test nobody can explain is a test nobody should run |
| every `rules[].because` is present | a verdict without its reason is not explainable |
| at least one rule can `confirm` | otherwise the playbook can never be an answer |
| every rule path and fix placeholder is in `FACT_SCHEMA` | a typo would otherwise evaluate to "unknown" for ever, which looks exactly like "the test has not run" |

**A malformed playbook stops the server.** The catalogue loads at boot
(`loadCatalog()` in `src/routes/index.js`), so a broken rule fails the deploy
rather than the one day somebody is standing in front of an outage waiting for
an answer.

---

## The rule language

`src/diagnose/expr.js` — a hand-written tokeniser and a recursive-descent
parser. **No `eval`, no `new Function`.** The whole grammar:

```
or    := and ( '||' and )*
and   := cmp ( '&&' cmp )*
cmp   := unary ( ('=='|'!='|'>='|'<='|'>'|'<') unary )?
unary := '!' unary | primary
prim  := '(' or ')' | number | 'string' | true | false | path
path  := ident ('.' ident)*
```

No calls, no bracket indexing, no arithmetic, no ternaries, no template
literals. `__proto__`, `constructor` and `prototype` are refused as path
segments. Everything outside the grammar is rejected at **compile** time, which
is startup.

### Three-valued, on purpose

A test that did not run has no value, and a rule over a value nobody measured
must not decide anything.

| | meaning |
| --- | --- |
| `true` | the rule fired |
| `false` | the measurement is there and the pattern is not |
| `null` | at least one field is missing — **unknown** |

Unknown propagates the way it should: `false && unknown` is still `false`, and
`unknown && true` is `unknown`. Only an outright `true` fires a rule, and the
missing paths come back with the result so the UI can say *"open, waiting on
`path_mtu.blackhole_detected`"* rather than just *"open"*.

Both sides of `&&` and `||` are always evaluated. Short-circuiting would hide
which fields a rule needed, and that list is half the answer.

---

## Facts

`src/diagnose/facts.js` holds two halves that must agree, which is why they are
one file: `FACT_SCHEMA` (every path a playbook may name) and `buildFacts()`
(what the measurements turn into).

| Namespace | From |
| --- | --- |
| `ping.*`, `ping.size_<N>.*` | the ping probe, including the don't-fragment size sweep |
| `path_mtu.*` | the path_mtu probe |
| `traceroute.*` | hop count, branch count (ECMP), sustained loss, worst hop |
| `dns.*`, `http.*`, `tcp.*` | the other probes |
| `iface.*` | `computeInterfaceHealth()` for the session's agent |
| `reverse.*` | the same measurements taken from the FAR end |
| `path_compare.*` | whether the two directions traverse the same hops |

**A value is present only when it was measured.** Anything else is left out
rather than defaulted to zero — a zero would be a lie that reads as a verdict.

Three judgements worth knowing about:

- **`sustainedLossFromHop()`** — loss that starts at one hop and continues to
  the target is real and is at that hop. Loss on a single hop in the middle that
  does *not* continue is the router rate-limiting its own ICMP replies while
  forwarding everything else perfectly. That is the single most common way a
  traceroute is misread, and it is encoded here rather than left to the reader.
- **Virtual interfaces are excluded.** A docker bridge with no carrier would
  otherwise confirm `physical_errors` on every container host in the fleet.
- **`busy_port_count`** counts ports busy *at once*. One busy port is a
  transfer; several unrelated ones together is what a broadcast storm looks like
  from outside, and no single interface can show you that.

---

## Verdicts

`src/diagnose/evaluate.js`.

| Verdict | When |
| --- | --- |
| `confirmed` | a `confirm` rule matched |
| `ruled_out` | a `rule_out` rule matched |
| `inconclusive` | neither, or both |

`inconclusive` always carries a reason, because "we do not know" has three quite
different causes and they lead to different next steps:

| Reason | Means | Next step |
| --- | --- | --- |
| `missing_data` | the tests it needs have not run | run them |
| `no_rule_matched` | they ran, and no pattern fits | look elsewhere |
| `conflicting_evidence` | something both confirmed and ruled it out | neither claim is safe; the disagreement is the finding |

A cause that has been ruled out is handed **no** fixes — showing a repair plan
for an eliminated cause invites somebody to do it anyway. Placeholders in a fix
are filled from the measurements; one that nothing measured renders as *"(not
measured yet)"* and the fix is flagged incomplete, rather than putting braces on
an operator's screen.

---

## The API

| Method | Endpoint | Role | |
| --- | --- | --- | --- |
| POST | `/api/diagnose` | viewer+ | describe the problem → a plan |
| GET | `/api/diagnose` | viewer+ | recent sessions |
| GET | `/api/diagnose/:id` | viewer+ | the plan, test status and last evaluation |
| POST | `/api/diagnose/:id/run` | operator+ | push the tests to their agents |
| POST | `/api/diagnose/:id/evaluate` | operator+ | apply the rules, mark every cause |
| GET | `/api/playbooks` | viewer+ | the catalogue |
| GET | `/api/playbooks/:id` | viewer+ | one playbook |

**Where the role line is drawn.** Reading a plan is a read, even though it is a
POST — the description is a paragraph and paragraphs do not belong in a query
string. Running a test pushes a command to an agent; evaluating can send context
to a third party. Both are writes, so both are operator+. A viewer may read
every conclusion; they may not make the network do something.

`session_created`, `tests_run` and `evaluated` are written to the hash-chained
audit log under category `diagnose`.

**Not `/api/diagnostics`** — that is the admin-only outbound-connectivity test
area and predates this. The names sit uncomfortably close and the two are
unrelated: this one is the technician's, that one is the installer's.

### Error codes

| | |
| --- | --- |
| 400 | empty description, over 1000 characters, a target that is not a host, `/evaluate` before anything ran |
| 401 | no token |
| 403 | a viewer calling `/run` or `/evaluate` |
| 404 | unknown session, unknown playbook, an agent that does not exist |
| 409 | `/run` on a plan with no target or no agent |
| 500 | JSON, no stack trace |
| 503 | the session store is not wired (the playbook endpoints still answer) |

---

## Correlating results

`probe_results` carries **no run id** — an agent reports a measurement, not a
reply to a request. So `diagnose_session_tests` records the dispatch time per
test (migration 097) and a session finds its own results by
`(agent_id, type, target, ts ∈ [dispatched_at, +10 min])`, taking the **oldest**
match: the first answer after dispatch is the answer to this dispatch. Once a
row is matched its id is stored on the test, so the link stops being a search
and becomes a fact.

The tests themselves are ordinary probes, dispatched by the ordinary `run-probe`
command and reported through the ordinary endpoint. A diagnosis with its own
execution channel would be a second way for a test to work, and a second way for
it to break.

---

## The two probes this module needed

`mtu_blackhole` could be *proposed* before, and never *confirmed*. Both gaps are
now closed in **blueeye-agent 0.25.x** (keep the server and agent in lockstep):

- **`ping` with `sizes` + `df`** — the same target at several payload sizes with
  don't-fragment set. 64 bytes through and 1472 gone is not loss; it is an MTU.
  The result's top-level metrics deliberately describe the **smallest** size, so
  a blocked 1472-byte packet never reads as an outage to availability, fleet
  health or the anomaly detector. Only `sizes[]` carries the size dependence.
- **`path_mtu`** — binary-searches the largest DF packet the path carries and
  reports which world you are in. `blackholeDetected: false` means a router
  answered with its MTU: PMTUD works, and any host that listens to ICMP copes on
  its own. `blackholeDetected: true` means large packets vanish in silence,
  which is the one that breaks applications; the fix is a firewall rule or MSS
  clamping, not a smaller MTU on the client. `perHop: true` traceroutes and then
  asks each responding hop the same question small and large, so
  `mtuDropAtHop` names where it stops — and a hop that ignores ICMP echo
  altogether is never blamed, because naming the wrong hop sends somebody to the
  wrong firewall.

Stored in `probe_results.sizes` and `probe_results.mtu` (migration 096).
**`path_mtu` is excluded from uptime and fleet health** (`DIAGNOSTIC_TYPES`): it
is something somebody runs on purpose, mid-outage, against a host that may
already be down, and an investigation must not move the SLA number it is
investigating.

### An agent that has not updated

Answers `unknown probe type "path_mtu"`, which becomes an `execError` and an
`agent.probe-failed` audit event. The facts for that test stay missing, so the
cause reads `inconclusive` / `missing_data` rather than confirmed or ruled out.
That is the correct answer — but it does mean an un-updated fleet cannot confirm
an MTU blackhole.

---

## The starter catalogue

| id | Reported as | Key evidence |
| --- | --- | --- |
| `mtu_blackhole` | connects, then stops when data flows | size-dependent loss, `path_mtu` |
| `hop_packet_loss` | loss between A and B, location unknown | sustained per-hop loss |
| `asymmetric_routing` | works one way, fails the other | reverse ping, path comparison |
| `ecmp_member_link` | a fraction of connections fail | path branches + fractional loss |
| `physical_errors` | loss without load | interface errors at low utilisation |
| `congestion` | bad at peak | discards with high utilisation |
| `dns_resolution` | works by IP, not by name | DNS probe |
| `l2_loop` | everything slow at once, in bursts | wild jitter, many ports busy together |
| `duplex_mismatch` | slow, worse under load | errors rising with utilisation |

---

## Tests

| File | |
| --- | --- |
| `test/diagnoseMatching.test.js` | the two required fixtures, every playbook reachable from a real sentence, Danish inflection, locale completeness |
| `test/diagnoseRules.test.js` | a confirming / ruling-out / inconclusive pattern for **every** playbook, the ICMP rate-limiting rule, fix placeholders |
| `test/diagnoseApi.test.js` | roles and 400/401/403/404/409/500 |
| `test/diagnoseLlm.test.js` | invented ids discarded, every failure mode falls back, prompt injection |
| `test/diagnoseView.test.js` | the screen, driven end to end in jsdom against the real app |
| `test/probeMtuFields.test.js` | the probe plumbing |
| `test/gate/validation.test.js` | the evaluator's grammar and the catalogue's validation, swept by the gate |
