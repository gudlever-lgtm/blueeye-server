# TLS certificates and reverse DNS

Two probes that answer questions a reachability test cannot, added in
**blueeye-agent 0.27** and **server 0.160**.

## Why these two

Everything else the agent measures asks *can I get there, and how fast*. These
two ask *is what I got there to correct*:

* A **certificate** that expires on Saturday takes a service down as surely as a
  cut fibre, and nothing in a ping says so. The `http` probe already read an
  expiry as a side effect of fetching a URL — which covers a web server and
  nothing else. A certificate lives on any port: 465 (SMTP), 993 (IMAP), 636
  (LDAPS), a database, a management interface.
* A missing or unconfirmed **PTR** is what gets mail refused. It is invisible to
  every other check, and the first sign of it is usually a customer saying their
  mail bounces.

## The TLS probe

`{ type: 'tls', host, port = 443, servername?, ocsp?, timeoutMs? }`
→ `blueeye-agent/src/probes/tls.js`

It opens a handshake, reads the peer certificate, and closes. **Nothing is sent
and nothing is read** — metadata only: subject, issuer, validity dates, SAN
list, serial, fingerprint and the negotiated parameters.

**Five faults, kept apart**, because they have five different fixes:

| Field | Fault | Fix |
|---|---|---|
| `expiryDays` / `expired` | Runs out, or has | Renew |
| `chainTrusted` (+ `authorized`, `authorizationError`) | The chain does not validate | Usually install the intermediate |
| `hostnameMatches` | The certificate is for another name | Reissue, or point at the right vhost |
| `revoked` / `revocation` | The issuer has withdrawn it | Reissue — with a new key on `keyCompromise` |
| `protocol` / `cipher` | What was negotiated | The audit's question |

One "invalid certificate" flag would throw away which of them it was.

### Two decisions worth knowing

**`rejectUnauthorized: false` is deliberate.** The job is to *report* an
untrusted or mismatched certificate, and a handshake that refuses to complete
cannot say which of the two it was — every certificate fault would arrive as the
same blank failure.

**`hostnameMatches` is tri-state.** `true`/`false` is a verdict; `null` means
there was no name to check (an IP target with no SNI). Coercing that to `false`
would report every IP target as serving the wrong certificate. The matching is
RFC 6125 as a certificate actually uses it: the SAN list decides, one leading
wildcard matches exactly one label, and the subject CN is consulted only when
there is no SAN at all.

**`servername`** is how you check the certificate one virtual host serves on a
shared address: point the probe at the IP and name the host. It is validated by
the same rule as any other target, because it reaches a network call.

**`authorized` is one flag for two checks.** node verifies the chain *first*
and the name *second*, so `authorized: false` with
`ERR_TLS_CERT_ALTNAME_INVALID` means the chain validated and only the name
failed. Agent 0.40+ reports `chainTrusted` beside it (and keeps `authorized` /
`authorizationError` verbatim); for an older agent's row the server derives
`chainTrusted` from that code at ingest, and the analysis does the same for rows
stored before. The finding for a name mismatch on a good chain reads "TLS
certificate on `<address>` is not valid for `<servername>`: the chain
validates, but the certificate is not for that name (it is issued for …)" —
never "the chain does not validate". The name it quotes is the SNI name the
agent sends in `tls.servername`, else the host.

**Two names on one address are two targets.** When `servername` is given and
differs from `host`, agent 0.40+ reports the target as `servername@host:port`
(otherwise `host:port`, as before), so a valid and a mismatched name on the same
port are two series and two findings rather than one that flips between them.
An older agent still sends `host:port` for both.

### Revocation (agent 0.47+, server 0.230+)

`blueeye-agent/src/probes/ocsp.js`, with the DER it needs in
`blueeye-agent/src/probes/der.js` — by hand, not by dependency: the agent has
two runtime dependencies and a tag/length reader is not worth a third.

**Why it cannot be left out.** Expiry, trust and name all fall out of the
certificate in front of you. Revocation does not. A certificate whose key leaked
last week is still signed, still in date and still for the right name — the only
thing that knows it is dead is the issuer. Without this check the probe reports a
compromised service as `ok`.

**Two ways to ask**, in this order:

* **The staple** (`ocsp: 'staple'`, the default). The handshake asks for the
  status with it (`requestOCSP: true`) and a well-run server hands back a
  response the CA already signed. No extra connection, no extra latency, and the
  CA learns nothing about who is watching — so it is on by default.
* **The responder** (`ocsp: 'fetch'`). No staple, so ask the OCSP responder in
  the certificate's AIA extension directly. That is an outbound POST per run, to
  a URL *the inspected certificate chooses*, so it is opt-in: http(s) on port 80
  or 443 only, no redirects, no credentials in the URL, 64 KiB cap, and the same
  timeout as the probe.
* `ocsp: 'off'` (or `false`) asks nothing, and the handshake stops requesting the
  staple too.

**What is verified.** A revocation answer is worth exactly what its signature is
worth, so the response is verified against the chain's own issuer key — directly
when the issuer signed it, or through the delegated responder certificate the
response carries, which must itself be signed by that issuer, be in date and
carry the OCSP-signing EKU (`1.3.6.1.5.5.7.3.9`). Without that EKU check any
certificate a CA ever signed could answer for every certificate it signed. The
CertID in the answer (serial + both hashes) must be *this* certificate's, and a
fetched answer must echo the nonce that was sent.

**The verdicts**, as stored in `tls.revocation.status`:

| Status | Means | `ok` |
|---|---|---|
| `revoked` | The issuer withdrew it | **false** |
| `good` | Not revoked, and the signature checked out | true |
| `unverified` | Not revoked, but nothing could verify the answer | true |
| `unknown` | The issuer does not recognise the certificate | true |
| `unchecked` | Nothing to read — no staple, no responder, no issuer | true |
| `error` | A responder that was down, said `tryLater`, or answered junk | true |
| `off` | The probe was told not to ask | true |

Only `revoked` fails the probe. An unreachable responder is a gap in what we
know, not a fault in the service being probed — and `lossPct` stays 0 either
way, exactly as it does for an expired certificate.

Three asymmetries are deliberate:

* **A `good` is only a good when it was verified.** An unverifiable one is
  stored as `unverified`, which is its own word precisely so nothing downstream
  can read it as "fine". `signatureVerified` is tri-state: `true`, `false`
  (checked and wrong), `null` (no key, or an algorithm this code cannot check).
* **A signature that is checked and WRONG voids the whole response**, in both
  directions. A forged "good" hides a real revocation; a forged "revoked" is a
  false alarm that sends somebody reissuing a healthy certificate at 3am.
* **A revocation is believed even when the signature could not be checked**,
  because the agent does not get to decide that a revocation it cannot confirm
  did not happen. What it cannot do is invent one: that is what the two rules
  above guard.

`stale` says the answer's own `nextUpdate` has passed — the status is the last
one the responder published, not a current one.

**On the server.** The block is stored field by field in the `tls` JSON column
(`src/validation/probeValidation.js` — no migration; the column already exists),
a revoked certificate raises a CRIT `probe.tls` finding that says *reissue*
rather than *renew* (and names the leaked key on `keyCompromise`), and
`tls.revoked` / `tls.revocation_status` are readable as diagnose facts. An agent
older than 0.47 sends neither field; that silence is stored as `revocation: null`
and read everywhere as "nobody asked", never as "not revoked".

## The reverse-DNS probe

`{ type: 'rdns', host }` → `blueeye-agent/src/probes/rdns.js`

A name is resolved to an address first, so the probe can be pointed at either
and answers the same question about the address behind it.

The field that matters is **`forwardConfirmed`**: does the PTR name resolve back
to the address it came from (RFC 1912 §2.1, and what receiving mail servers
check)? A PTR pointing at somebody else's name is worse than no PTR, because it
looks fine until it is checked — so it is its own state rather than folded into
`ok`. **No PTR at all is a result, not a broken probe**: `ok:false` with the
reason, because for the services that care, no PTR is a refusal.

## What the server does with them

| | |
|---|---|
| Dispatch | `POST /agents/:id/probe` and the Connection test, like any other probe |
| Storage | `probe_results.tls` and `probe_results.rdns` (migration **101**), each written whole by the one probe that produces it |
| Findings | The cert **expiry** countdown now reads `tls` rows as well as `http` (one finding per target, whichever probe measured it). A certificate that **cannot be trusted** — expired, not yet valid, wrong name, a chain that does not validate, or one the issuer has **revoked** — is a separate CRIT finding, because those are true *now* at any expiry date |
| UI | `tlsDetail()` / `rdnsDetail()` in `public/app.js`, and both types in the Run-a-probe form |

### Neither votes on uptime

Both join `path_mtu` in `DIAGNOSTIC_TYPES` (`probeResultsRepository.js`), so
they are excluded from availability and fleet health. An expired certificate and
a missing PTR are real faults and neither is a **reachability** fault — the host
answers. Counting them would drag an SLA figure down for something no network
change can fix.

There is deliberately **no finding for an unconfirmed PTR**. Most hosts have no
reason to have one, and a WARN on every address would be noise; it is reported
on the screen and in the result, where the person who cares is looking.

## Version skew

Both probes need **agent 0.27**. An older agent answers `unknown probe type
"tls"`, and the Connection test row shows that as its failure reason — the same
way it names a missing `traceroute`. Update the agent (`git pull &&
./install.sh`, or the Update button for a systemd install).

**Revocation needs agent 0.47.** An older agent runs the probe as before and
simply reports nothing about revocation: the stored block is `null`, the UI
leaves the row out, and no finding is raised. It does not report "not revoked" —
that would be a claim nobody made. `ocsp: 'fetch'` in a spec an older agent
receives is ignored along with every other field it does not know, so nothing
breaks while a fleet is mid-update.

## Files

| What | Where |
|---|---|
| Probes | `blueeye-agent/src/probes/tls.js` · `rdns.js` (+ `test/probesTlsRdns.test.js`) |
| Revocation | `blueeye-agent/src/probes/ocsp.js` · `der.js` (+ `test/probeTlsOcsp.test.js`, fixture `test-support/ocspFixture.js`) |
| Spec + result validation | `src/validation/probeValidation.js` (`tlsBlock`, `rdnsBlock`) |
| Storage | migration 101 · `src/repositories/probeResultsRepository.js` |
| Findings | `src/analysis/probeFindings.js` (`certFindings`) |
| UI | `tlsDetail()` / `rdnsDetail()` in `public/app.js`, `probe.tls.*` / `probe.rdns.*` in `public/i18n.js` |
| Tests | `test/tlsRdnsProbes.test.js` · `test/tlsRevocation.test.js` |
