# SNMP credentials — profiles, and SNMPv3

> A credential per switch is fine for three switches. For a hundred it is a
> hundred places to change a community string, and no way to know which of them
> you missed.

**API:** `/api/snmp-profiles` (admin) · **Table:** `snmp_credential_profiles` (migration 112)

---

## The model

```
device.community_encrypted        ← 1. the device's own, if it has one
device.credential_profile_id      ← 2. the profile it names
profile WHERE location_id = site  ← 3. the profile for its site
profile WHERE location_id IS NULL ← 4. the global default
                                    5. nothing — and the device says so
```

Resolved **on the server**, in `snmpDevicesRepository.listForAgentWithSecret()`.
The agent receives **one credential per device** and never learns that profiles
exist.

---

## What was proposed, and what was built

The proposal was: a profile per site, an optional profile per subnet, an
override per device, and **the agent tries them in order**, remembers what
worked and reports `auth_failed` per device.

The hierarchy is built. The ordered trying is not, and the reason is that
trying credentials in sequence against an address is **credential spraying** —
technically identical to an attack whatever the intent.

- **Against v3 it is actively harmful.** v3 is authenticated. Failed authPriv
  attempts are logged as security events on most platforms, and some lock the
  account.
- **Against v2c it produces silent failure.** A wrong community usually gets no
  error at all, just a timeout. Three profiles × 30 s per device per cycle,
  against a 60-second interval floor: the polling collapses before it finds
  anything.
- **It is out of step with the rest of this feature**, which checks the SSRF
  deny-list twice for every device and keeps the community out of
  `SAFE_COLUMNS` so a route cannot leak it by accident.

The server already knows which credential a device should use. Having the agent
guess is solving a problem that was never there.

**The subnet tier is also left out.** `locations` exists and
`snmp_devices.location_id` already points at it. A middle tier needing CIDR
matching has to earn its place with a case that site + override cannot express,
and none was given.

---

## SNMPv3

A v3 credential lives on a **profile**, never on a device row: an auth/priv key
pair belongs somewhere it is encrypted once and shared by every switch at a
site. A device row may say `version: '3'`, and then it resolves its credential
from a profile — a v3 row carrying a community is refused, because it would poll
with whichever the chain reached first.

**The security level is derived, never stored.**

| Keys set | Level |
| --- | --- |
| user only | `noAuthNoPriv` |
| user + auth key | `authNoPriv` |
| user + auth key + priv key | `authPriv` |

A stored level can disagree with the keys; a derived one cannot. The same
derivation runs on the server (`securityLevel()`) and in the agent
(`openSession()`), and the agent's is what actually happens on the wire.

**SNMPv3 cannot encrypt without authenticating.** A priv key with no auth key is
not a weaker level — it is one that does not exist, and a device refuses it. The
validator refuses it too, which is the difference between an error message and a
switch that quietly stops answering. A `PATCH` is validated against the
**merged** shape, so removing the auth key from an authPriv profile is caught.

Protocols offered: `md5`, `sha`, `sha224`, `sha256`, `sha384`, `sha512` for
auth; `des`, `aes`, `aes256b`, `aes256r` for priv. `GET /api/snmp-profiles/meta`
serves exactly these, so the UI cannot drift from the validator.

Keys are refused below **8 characters** — RFC 3414's minimum. A device would
refuse a shorter one, so accepting it here only moves the failure.

---

## Nothing secret comes back out

At rest: `src/lib/secretBox.js`, AES-256-GCM, the same box the integrations and
the LDAP bind password use.

The ordinary reads return `hasCommunity: true|false` and the **protocol names** —
enough for an operator to see that a profile is configured and SHA/AES, and
never the keys. The one read that decrypts is `resolveWithSecret()`, named so
nobody calls it from a route by accident. The same rule
`snmpDevicesRepository.listForAgentWithSecret` already followed.

**A secret that is omitted from a PATCH is left alone; an explicit `null` clears
it.** Otherwise renaming a profile would silently wipe its credentials.

---

## Admin for everything, including the read

The only place in the SNMP feature where even a **listing** is admin-only. The
device inventory is infrastructure a viewer may look at; a list of credential
profiles says which sites share a secret and which use v3, which is a map of
where to attack first.

Every change is written to the hash-chained audit log, naming **which fields**
changed and never their values — `redactBody` keeps secrets out of the audit
body, and naming the fields is what makes the trail useful.

Deleting a profile reports **how many devices fall back**. They drop to the
resolution chain — their site's profile, then the global default — and a device
with nothing left to resolve to reports that it has no credential rather than
quietly polling with `public`.

---

## Where things are

| | |
| --- | --- |
| Storage | `src/repositories/snmpCredentialProfilesRepository.js`, migration 112 |
| Resolution | `snmpDevicesRepository.listForAgentWithSecret()` |
| Validation | `src/validation/snmpProfileValidation.js` |
| Route | `src/routes/snmpProfiles.js` (admin) |
| Agent | `blueeye-agent/src/snmp/session.js` (`openSession`) |
