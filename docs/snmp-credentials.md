# SNMP communities — named credentials, sites, agents, and SNMPv3

> A credential per switch is fine for three switches. For a hundred it is a
> hundred places to change a community string, and no way to know which of them
> you missed.

**UI:** Settings → SNMP communities · **API:** `/api/snmp-profiles` (admin) ·
**Tables:** `snmp_credential_profiles` (112), `snmp_profile_locations` and
`snmp_profile_agents` (113)

---

## The model

A **community** is a named credential. It is assigned to two things, and they
answer different questions:

| | |
| --- | --- |
| **Sites** (`snmp_profile_locations`) | which communities are valid on that network. A site may have **several**, in its own order of preference. |
| **Agents** (`snmp_profile_agents`) | which of them **this host** is allowed to speak. This is the access rule. |

```
device.community_encrypted             ← 1. the device's own, if it has one
device.credential_profile_id           ← 2. the community it names
site's communities, in the site's order ← 3. the first one this agent may use
the global default community            ← 4. is_global_default
                                          5. nothing — and the device says so
```

Steps 2–4 are all filtered by the polling agent's grants. Resolved **on the
server**, in `snmpDevicesRepository.listForAgentWithSecret()`. The agent
receives **one credential per device** and never learns the others exist.

### An agent walks only with a community assigned to it

That is the whole of the access rule, and it is a **grant**: a row in
`snmp_profile_agents` is the only thing that lets an agent be handed a named
community. An agent with none assigned polls nothing that needs one.

A community the agent is not granted is **skipped as though it were not
configured** — including one the device names explicitly, which does *not* then
fall through to the site's list. The naming was deliberate, and a quiet
substitution would poll the switch with a credential nobody chose.

The device reports **which** of the two it is (`credentialBlockedByGrant`),
because "this site has no community" and "this agent may not use the one it
has" send an admin to two different screens.

**A device's own community is not filtered.** It is not a named community: it
belongs to one switch, it is shared with nothing, and there is nothing for an
admin to assign. It is also why it still wins — a credential set on the device
itself is the most specific statement there is about how to reach it.

### Several per site is an ORDER, not a retry list

The server walks the site's list in `priority` order and sends the **first**
one the polling agent may also use. One credential goes out per device; the
rest are never tried on the wire. The order belongs to the **site** — "at
Aarhus, the core community before the access one" is a sentence about the site,
not about any one community — so it is set with
`PUT /api/snmp-profiles/order/:locationId { profileIds }`, which must name
exactly the communities currently assigned there. A partial order leaves the
rest somewhere nobody chose, and somewhere nobody chose is what would decide
which credential a switch is polled with.

### No credential is never 'public'

The target is still sent to the agent — so the dashboard can say
`sw-lager-1: no SNMP community assigned` instead of a switch that silently
never appears — and the agent **refuses** it: `snmpPoller.credentialError()`
fails the device before a session is opened, and `openSession()` throws
`SNMP_NO_CREDENTIAL` rather than defaulting to `public`. Walking a production
switch with a guessed community string is a scan, under a name the customer
never configured.

### Upgrading from migration 112

Nothing changes on the deploy. The migration copies each profile's single
`location_id` into `snmp_profile_locations`, turns the old "`location_id IS
NULL` means global" into the `is_global_default` column, and grants **every
existing community to every existing agent**. The rule starts restricting the
moment an admin edits it, and not before — an access rule that breaks
monitoring on the deploy that introduces it gets turned off, not obeyed.

---

## What was proposed, and what was built

The proposal was: a profile per site, an optional profile per subnet, an
override per device, and **the agent tries them in order**, remembers what
worked and reports `auth_failed` per device.

The hierarchy is built — and 113 widened it to several per site and an explicit
grant per agent. The ordered trying is still not, and the reason is that trying
credentials in sequence against an address is **credential spraying** —
technically identical to an attack whatever the intent. More communities
assigned makes that worse, not better.

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

**The subnet tier is still left out.** `locations` exists and
`snmp_devices.location_id` already points at it, and a site may now hold several
communities. A middle tier needing CIDR matching has to earn its place with a
case that site + order + override cannot express, and none was given.

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

Deleting a community reports **how many devices fall back**. They drop to the
resolution chain — the rest of their site's list, then the global default — and
a device with nothing left to resolve to reports that it has no credential
rather than quietly polling with `public`. The assignments go with it
(`ON DELETE CASCADE`), so the agents that were granted it lose that grant.

---

## The agent's own traffic source

An agent whose traffic source *is* an SNMP device (Agents → Edit → Traffic
source `snmp`) used to carry the literal community string in its
`monitor_config`, where every user who could read the agents API could read it
too. It now picks a **named community** instead — the same list Settings
manages — and only the id is stored:

```json
{ "source": "snmp", "snmp": { "host": "10.14.0.1", "profileId": 4, "port": 161 } }
```

`GET /agents/me/config` resolves it for the one hop that needs it, through the
same chain and the same grant check as the device targets: a credential the
agent is not granted sends **no** community at all (`noCredential`,
`credentialBlocked`), never a fallback nobody chose. The free-text field is
still there for an agent configured before this, and for an operator who
cannot see the admin-only list of communities — pick a name and the literal is
dropped, never kept beside it.

---

## Where things are

| | |
| --- | --- |
| Storage | `src/repositories/snmpCredentialProfilesRepository.js`, migrations 112 + 113 |
| Resolution | `snmpCredentialProfilesRepository.resolveForAgent()`, called from `snmpDevicesRepository.listForAgentWithSecret()` |
| Validation | `src/validation/snmpProfileValidation.js` |
| Route | `src/routes/snmpProfiles.js` (admin) |
| UI | Settings → SNMP communities (`settingsSnmpCommunitiesView` in `public/app.js`) |
| Handed to the agent | `GET /agents/me/config` → `snmpTargets[]`, and `monitorConfig.snmp` for the agent's own source (`src/routes/agentReports.js`) |
| Agent | `blueeye-agent/src/snmpPoller.js` (`credentialError`) and `src/snmp/session.js` (`openSession`) |
