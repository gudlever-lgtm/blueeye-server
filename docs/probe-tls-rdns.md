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

`{ type: 'tls', host, port = 443, servername?, timeoutMs? }`
→ `blueeye-agent/src/probes/tls.js`

It opens a handshake, reads the peer certificate, and closes. **Nothing is sent
and nothing is read** — metadata only: subject, issuer, validity dates, SAN
list, serial, fingerprint and the negotiated parameters.

**Four faults, kept apart**, because they have four different fixes:

| Field | Fault | Fix |
|---|---|---|
| `expiryDays` / `expired` | Runs out, or has | Renew |
| `authorized` + `authorizationError` | The chain does not validate | Usually install the intermediate |
| `hostnameMatches` | The certificate is for another name | Reissue, or point at the right vhost |
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
| Findings | The cert **expiry** countdown now reads `tls` rows as well as `http` (one finding per target, whichever probe measured it). A certificate that **cannot be trusted** — expired, not yet valid, wrong name, or a chain that does not validate — is a separate CRIT finding, because those are true *now* at any expiry date |
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

## Files

| What | Where |
|---|---|
| Probes | `blueeye-agent/src/probes/tls.js` · `rdns.js` (+ `test/probesTlsRdns.test.js`) |
| Spec + result validation | `src/validation/probeValidation.js` (`tlsBlock`, `rdnsBlock`) |
| Storage | migration 101 · `src/repositories/probeResultsRepository.js` |
| Findings | `src/analysis/probeFindings.js` (`certFindings`) |
| UI | `tlsDetail()` / `rdnsDetail()` in `public/app.js`, `probe.tls.*` / `probe.rdns.*` in `public/i18n.js` |
| Tests | `test/tlsRdnsProbes.test.js` |
