# Universal search

One field that takes what the technician actually knows — an IP, a MAC, a
hostname, a site, an agent, a service — and lands them on the right screen.

Before this, the entry point to every investigation was a hostname the
technician first had to look up somewhere else. The phone says "the printer on
the second floor is offline" or "10.9.9.9 can't reach the file server"; it never
says "sw-core-03".

`GET /api/search?q=&limit=` · viewer+ · rate limited.

## What every hit carries

```json
{
  "type": "mac",
  "display_name": "00:11:22:33:44:55 → 192.168.1.50",
  "target": "agent:7",
  "confidence": "exact",
  "source": "arp_entries (capabilities)",
  "last_seen": "2026-07-27T08:00:00.000Z",
  "detail": "seen by Firewall Aarhus · on eth0"
}
```

`source` and `last_seen` are the point, not decoration. A hit resting on an ARP
entry from three weeks ago and one resting on this morning's capabilities report
look identical without them — and only one is worth driving to a site for. Both
keys are present on **every** hit; `last_seen: null` means "we cannot date this",
which is honest, where an invented date would not be.

### Confidence

A fixed vocabulary, not a score — a free-floating 0..1 would let each resolver
invent its own scale and the sort would stop meaning anything.

| | Meaning |
| --- | --- |
| `exact` | An identifier matched exactly (IP, MAC, agent id, exact hostname) |
| `high` | A name matched from the start (prefix) |
| `medium` | A name contained the query (substring) |
| `low` | An indirect association — see the LLDP note below |

Ordering is confidence, then `last_seen` descending, then display name for
stability. An undated hit sorts **last within its tier**: it is not necessarily
worse, but it cannot claim to be current.

## Resolvers

Only the families a query could possibly belong to are run — `classify()` in
`src/search/query.js` decides, so a keystroke does not fan out to everything.

| # | Family | Matching | Source |
| --- | --- | --- | --- |
| 1 | IP | **exact only** | `agents.capabilities.ips` (owns it) · `arp_entries` (has a binding) · `flow_records` (merely saw it) |
| 2 | MAC | exact, normalised | `arp_entries` · `lldp_neighbors` (low) |
| 3 | Hostname / DNS | exact / prefix / substring | `agents`, `discovered_devices` |
| 4 | Site | exact / prefix / substring | `locations` |
| 5 | Agent id | exact | `agents.id` |
| 6 | Service | port exact, name prefix/substring | `src/flows/services.js` + `flow_records` |
| 7 | CMDB asset | connector's own | ServiceNow / Nautobot / custom |
| 8 | Username | — | **none — see below** |

A partial IP (`192.168.1.`) is deliberately *not* treated as an address: it is a
prefix of a name-shaped field, and IP/MAC match exactly by design.

### MAC normalisation

Five spellings resolve identically, because query normalisation and ingest
parsing call the **same** function (`normalizeMac` in `src/identity/arpTable.js`):

```
00:11:22:33:44:55   00-11-22-33-44-55   001122334455
0011.2233.4455      00:11:22:33:44:55 (any case)
```

### The LLDP caveat

An LLDP chassis id is often a MAC — but it identifies a **switch chassis**, not a
client. It is reported at `low` confidence and labelled "LLDP chassis of …", so
it reads as "a switch announces this address", not "your laptop is here".

### Username: deliberately empty

`resolveUser()` returns `[]` and the response names `user` in `unresolved`.

There is **no end-user identity source in this product**. `users` holds dashboard
staff logins; LDAP/OIDC/SAML authenticate those same staff accounts. There is no
RADIUS/802.1X accounting, no NAC integration, no DHCP lease store, no AD computer
inventory — nothing mapping a person to an address or a device.

Resolving a username against staff accounts would return "the operator named
lars", not "the machine lars is sitting at": a confidently wrong answer to the
question actually asked, which is worse than none. Surfacing `unresolved` beats
silently returning zero results — the technician learns the field cannot answer
that question, rather than concluding their search term was wrong.

The TODO in `searchService.js` lists the candidate sources in order of how much
each would actually help.

## Partial failure

Resolvers are independent and fan out with `Promise.allSettled`. One failing
source sets `partial: true` and names it in `failedSources`; the rest still
answer. A technician mid-event needs the four answers we *can* give, not a 500
because the CMDB is unreachable.

The one genuinely fatal failure is loading the agent list — it happens before the
fan-out and every resolver depends on it, so that is a 500.

## Rate limiting and RBAC

Rate limited per **user** (60/min), not per IP: one busy operator behind a shared
proxy egress must not lock out the rest of the NOC. The field is on a keyboard
shortcut and one fan-out can reach the customer's ServiceNow, so the endpoint
cannot rely on the client debouncing.

**RBAC note.** `/api/cmdb/assets/search` is operator+, while this field is
viewer+. That gap is preserved on purpose: a viewer's search returns local
results only. Widening CMDB access as a side effect of adding a search box would
be an access-control change smuggled in as a UI feature.

`makeCmdbSearch()` (in `src/routes/cmdb.js`) is the only place the search path
touches CMDB credentials — it decrypts at call time and hands the connector a
ready integration, so neither the router nor the service ever learns how.

## Known limitation

`loadAgents()` is a full `findAll()` filtered in JS. That is what the previous
endpoint did, and at a few hundred agents it is cheaper than the round-trips it
replaces. **It is the first thing to convert to indexed SQL prefix queries** when
a deployment's agent count makes it hurt.

## Files

- Pure query analysis `src/search/query.js` (classification, confidence, ordering, dedupe)
- Fan-out `src/search/searchService.js`
- Router `src/routes/search.js`
- Identity source — see `docs/arp-identity.md`
- UI `globalSearch()` / `searchHitEl()` in `public/app.js`, `.search-*` CSS
- Tests `test/searchApi.test.js`, `test/searchQuery.test.js`
