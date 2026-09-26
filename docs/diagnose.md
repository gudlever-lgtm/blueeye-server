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

### `rungs` — the join to the ladder

A playbook may declare which **ladder rungs** it explains:

```jsonc
"rungs": ["firewall"]
```

The ladder (see [connection-test.md](connection-test.md)) says WHERE the
communication stops; this is what lets its verdict offer the playbook that says
WHY and WHAT TO DO, opened in place under the verdict. Checked at load against
the rung ids the ladders declare, so a typo fails the build. Optional — a
playbook explaining a fault no rung measures is still matchable by symptom.

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

### One namespace per TCP port

A rule about a filter has to be able to name the application port. `tcp.*` is
still the newest TCP row, and `tcp.port_<n>.*` is that port on its own — so
`ping.ok == true && tcp.port_443.failure == 'timeout'` says what "ping works but
443 does not" actually means, instead of "some TCP probe failed".

`tcp.port_*.failure` is the agent's own classification, and it is the
distinction `firewall_acl` stands on: `'timeout'` is a packet dropped in
silence, which is what a deny rule does; `'refused'` is the host answering with
a reset, which rules a filter **out**. An agent too old to report it leaves the
fact missing, the rule reads `unknown`, and nothing is confirmed on a guess.

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
| `traceroute.*` | hop count, branch count (ECMP), sustained loss, worst hop, a lost ECMP member (`lost_member_*`) |
| `dns.*`, `http.*`, `tcp.*` | the other probes |
| `iface.*` | `computeInterfaceHealth()` for the session's agent, including `late_coll_per_sec` (EtherLike-MIB, SNMP only) and, from the agent's proc source (0.40+), `duplex`, `collisions_per_sec`, `frame_err_per_sec`, `carrier_err_per_sec` |
| `reverse.*` | the same measurements taken from the FAR end |
| `path_compare.*` | whether the two directions traverse the same routers (`same_hops`, plus `matched_hops`, `match_ratio`, `method`) |

**A value is present only when it was measured.** Anything else is left out
rather than defaulted to zero — a zero would be a lie that reads as a verdict.

Three judgements worth knowing about:

- **`sustainedLossFromHop()`** — loss that starts at one hop and continues to
  the target is real and is at that hop. Loss on a single hop in the middle that
  does *not* continue is the router rate-limiting its own ICMP replies while
  forwarding everything else perfectly. That is the single most common way a
  traceroute is misread, and it is encoded here rather than left to the reader.
- **ECMP comes from the path, not from one run.** `branch_count` is
  `ecmpAnalysis()` (`src/analysis/pathGraph.js`) over the session's trace AND
  the last 24 h / 20 runs of the same probe (`probeResultsRepo.recentRuns`),
  counting every member seen at one TTL — across runs, and within a run when
  the agent reports `hop.ips`. It used to count addresses inside ONE result,
  which was always 1 and ruled ECMP out on every path. One address per hop from
  an older agent with no history is *not* a measured single path, so the fact
  is then absent (inconclusive), not 1. A **lost member** is a hop that
  answered from N addresses (each seen ≥ 2 times) in the earlier runs and now
  answers from fewer, *while* end-to-end or worst-hop loss rose ≥ 5 points or
  more hops timed out; the missing address is the evidence
  (`lost_member_ips`, `lost_member_explain`) and it confirms
  `ecmp_member_link`. Limits: a hop probed fewer times than it has members is
  not judged, and a Paris-style trace pins one member by design.
- **The reverse test probes BACK to the origin agent.** With a peer agent, the
  `reverse` rows run on the peer against the origin's own address (from its
  `capabilities.ips`, chosen by `src/diagnose/reverseTarget.js`: same family as
  the target, same private/public scope, never a container bridge, longest
  prefix shared with the peer — and the choice is written into the test's
  `why`). With no known origin address the reverse tests are listed in the
  plan's `skipped` with the reason instead of being aimed at the forward
  target, which measured a second forward path and never the return path.
- **`path_compare` survives ingress-interface addressing.** Routers answer a
  traceroute from the interface the probe arrived on, so a symmetric path
  shows different addresses in each direction. The reverse trace is reversed,
  the endpoints dropped, and hops matched in order (LCS) by the same address or
  the same /24 (IPv4) / /64 (IPv6) — the two ends of a router-to-router link
  share a small subnet. ≥ 60 % of the shorter path lining up is "the same
  path". A provider numbering links from one shared /24 pool over-matches;
  links numbered from unrelated subnets under-match. The comparison assumes
  the forward target sits at or next to the far-end agent.
- **Virtual interfaces are excluded.** A docker bridge with no carrier would
  otherwise confirm `physical_errors` on every container host in the fleet.
- **`busy_port_count`** counts ports busy *at once*. One busy port is a
  transfer; several unrelated ones together is what a broadcast storm looks like
  from outside, and no single interface can show you that.
- **`late_coll_per_sec`** is the counter that *names* a duplex mismatch rather
  than merely being consistent with one, and it is the sharpest illustration of
  the absent-is-not-zero rule in the whole module. It comes from the EtherLike-MIB
  over SNMP; a `/proc` sample never has it and plenty of switches omit the MIB.
  Since **zero** late collisions is what rules the fault *out*, a source that
  cannot count them reports `null` all the way from the agent
  (`snmpMonitor.js`) through `computeInterfaceHealth()` to here, where it is
  simply left out — so the rule reads `unknown` rather than an all-clear.
  The interface layer is deliberately **strict** about it where it coerces the
  other counters: `Number([])` is 0, and a coercion that turns junk into the most
  consequential answer available is worse than no reading at all.
- **`duplex` / `collisions_per_sec` / `frame_err_per_sec` / `carrier_err_per_sec`**
  are the host NIC's own view (`/sys/class/net/<if>/duplex` and the
  frame/colls/carrier columns of `/proc/net/dev`, see
  [docs/probe-dhcp.md](probe-dhcp.md)). Half duplex with collisions or frame
  errors moving confirms `duplex_mismatch`; a MEASURED clean full-duplex link
  rules it out; frame errors at full duplex and carrier errors confirm
  `physical_errors`. They follow the same absent-is-not-zero rule: Windows,
  macOS and SNMP samples do not carry them, and the rules then read `unknown`.

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
| GET | `/api/diagnose/:id/walkthrough` | viewer+ | the same session as one ordered list of steps |
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

## The guided walk-through

`GET /api/diagnose/:id/walkthrough` (`src/diagnose/walkthrough.js`, pure) returns
the same session arranged as **one ordered list of steps**.

**Why it exists.** A plan is a good answer to *what should I look at* and a bad
answer to *what do I do now*. It hands a technician four causes, nine tests and a
page of screens all at once — and the person who most needs it, the one who does
not already know which measurement settles which question, is exactly the person
who cannot order them. They run everything, read everything, and are no closer to
a verdict than when they started.

**The order is cheap-and-decisive first**, by probe type rather than by the order
the playbooks happen to list their tests in:

| | |
| --- | --- |
| 1 | does anything answer at all — `ping`, `dhcp` |
| 2 | is the port open, does the name resolve — `dns`, `rdns`, `tcp`, `tls` |
| 3 | where on the path — `traceroute`, `tcptraceroute`, `path_mtu` |
| 4 | does the application answer — `http`, `curl`, `pageload`, `transaction` |

That is the order a network engineer works in, and the reason is not taste: step 4
failing means nothing until step 1 has passed, while step 1 failing makes steps
2–4 a waste of an afternoon. Forward goes before reverse at the same rank — "A
cannot reach B" is worth knowing before "B cannot reach A". A probe type the
order does not know sorts after the ones it does, so a new one lands at the end
rather than at random.

Then the screens worth reading (a cause the evidence has ruled out does not get
its screens read, and a screen two causes both want is read once), then the
verdict, then the fixes — **only for a cause the evaluation confirmed**. A fix
offered for a cause nothing confirmed is an invitation to change a setting on a
network that did not have that problem, and the change gets blamed for the next
unrelated fault.

**A finished step says what it FOUND, not what it measured.** Each measure step
carries the rules its measurement made decidable, each with the playbook's own
sentence, so the reader is not handed a number to interpret. The outcomes are
`signal` (a rule fired on it), `clear` (its rules ran and none fired — something
has been eliminated, which is progress and says so), `unread` (nothing in this
plan reads it), `waiting` and `failed`. Rules are matched to a step by the root
token of their fact paths, anchored on a boundary and a dot, so `reverse.ping.*`
never attaches to the forward step and `tcp.*` never to `tcptraceroute`.

**And it carries the measurement it decided from.** A verdict nobody can check
is an assertion, so a finished step shows both: the rules it settled, and the few
numbers a reader would otherwise have gone to the Probes screen to look up.
`summariseResult` shapes them by probe type, because the deciding number is not
the same one twice — for a `ping` it is loss **per size** (the row's own
`loss_pct` describes the smallest size, so a sweep whose 1472 vanished still
reads 0% there), for a `path_mtu` the ceiling, whether anything admitted to it,
the hop it narrows at and the MSS to clamp to, for an `http` the status code.

The rows come from `probe_results` by the `probe_result_id` the evaluation
already attached, read one primary key at a time and **scoped to the test's own
agent** — a result id belonging to another agent reads as absent rather than as
somebody else's measurement under this session's step. Absent stays absent: a
field the row does not carry is left out rather than sent as null, and a null
number is never coerced (`Number(null)` is `0`, which on a loss column reads as a
clean link). The read is best effort; a failure costs the numbers on one step and
never the sequence.

**It decides nothing.** The verdict stays the evaluation's — this endpoint
arranges what `POST /diagnose` planned and `POST /evaluate` concluded, and
nothing else. That is what keeps it from becoming a second, quieter place where a
cause gets confirmed. It is a `GET`, viewer+, and it dispatches no probe: the
dashboard's per-step **Run this step** goes through `POST /diagnose/:id/run` with
that step's own test ids, like every other run.

**It is honest about being stuck.** `stalled` is true when the current step
cannot move on its own — a test the plan could not schedule, or one whose
dispatch failed — which is the state a walk-through has to name rather than show
a spinner for.

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

`mtu_blackhole` could be *proposed* before, and never *confirmed*: no probe sent
a packet big enough to fail.

- **`path_mtu`** — the largest packet the path carries, per hop. It is its own
  feature with its own document: **[docs/path-mtu.md](path-mtu.md)**. What
  matters here is the vocabulary the rules read, below.
- **`ping` with `sizes` + `df`** — the same target at several payload sizes with
  don't-fragment set, in one run. 64 bytes through and 1472 gone is not loss; it
  is an MTU. Stored in `probe_results.sizes` (migration 097). The result's
  top-level metrics deliberately describe the **smallest** size, so a blocked
  1472-byte packet never reads as an outage to availability, fleet health or the
  anomaly detector.

### The four things that look alike from outside

`path_mtu` classifies each hop, and the distinction is what the playbook rests
on:

| `status` | Means | The fault? |
| --- | --- | --- |
| `ok` | carries what it was handed | no |
| `reduced` | narrows the path **and says so** (ICMP frag-needed) | no — tunnels do this and PMTUD copes |
| `blackhole` | narrows it in silence | **yes** — the sender is never told, so the connection establishes and stalls on its first full-size segment |
| `no_response` | answers no ICMP at all | no, and never counted as one |
| `skipped` | past the probe's time budget | reported, never dropped |

`icmp_frag_needed_seen` separates the second row from the third at the
whole-path level, as a fact rather than something inferred from a boolean's
absence.

### The MSS evidence

The probe reads the **negotiated MSS** off its own socket (Linux).
`mss_exceeds_path` — derived in `facts.js`, only when *both* numbers exist — is
the direct evidence that clamping is missing: the kernel is still offering a
segment the path will not carry.

`mssSupported: false` means the agent could not look. That is not the same as
nothing to report, so the derived fact is left **absent** and a rule reading it
gets `unknown` instead of an all-clear.

### Why `blackhole_detected` is gated on a measured MTU, not on `ok`

The probe reports `ok: true` even when it finds a blackhole — the finding is
about the path, not the agent. So `ok` cannot be the gate. A run with no
`pathMtu` did not look, and reading its `false` default as an all-clear is
exactly how a real fault gets marked "ruled out".

For the same reason `path_mtu` is **excluded from uptime and fleet health**
(`DIAGNOSTIC_TYPES`): an operator runs it on purpose, mid-outage, against a host
that may already be down, and an investigation must not move the SLA number it
is investigating.

### Test parameters are validated against the real probe

A playbook's `tests[].params` are run through `validateProbeSpec` at load, and
every key must survive. An unrecognised key is **dropped** at dispatch rather
than rejected, so a playbook asking for `perHop` when the probe takes `per_hop`
would quietly run a narrower test than it promised. That happened once. It now
fails at boot.

### An agent that has not updated

Answers `unknown probe type`, the facts stay missing, and the cause reads
`inconclusive` / `missing_data` rather than confirmed or ruled out. Correct —
but an un-updated fleet cannot confirm an MTU blackhole.

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
| `duplex_mismatch` | slow, worse under load | late collisions; half duplex + collisions/frame errors on the host NIC; errors rising with utilisation |
| `firewall_acl` | ping works and the application port does not | ICMP answered while TCP/443 is dropped **in silence** — `ping.ok` against `tcp.port_443.failure` |

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
