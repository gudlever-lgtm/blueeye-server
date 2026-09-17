# Updates — knowing about them, and deploying them

This server has always known its own version and the agent version it serves.
What it could not know is whether the vendor has published anything newer. That
information now arrives **inside the signed license proof** this server already
fetches during licence validation.

```
blueeye-licens                         this server                     host
  watches GitHub for new       ──▶  signed proof carries        ──▶  scripts/deploy.sh
  server/agent versions             releases{server,agent}           (opt-in, admin-run)
                                          │
                                          ▼
                                 Settings → Updates:
                                 "update ready to deploy"
```

## Why it comes with the licence check

* **No new outbound connection.** Licence validation is an outbound call this
  server already makes every few hours (default 6). Update awareness costs
  nothing extra, and nothing new has to be reachable from the customer network.
* **It cannot be forged.** The versions are part of the Ed25519-signed payload,
  so a proxy on the path — or anyone else — cannot inject a fake "update
  available", nor strip a real one, without breaking the signature.
* **It grants nothing.** Release info is informational. It is deliberately
  *not* gated on the licence being valid (an expired customer still gets to see
  that a newer version exists), and it can never change licence status,
  entitlements or limits.

If the license server is older, or publishes no versions, the proof simply
carries no release info: the panel says nothing is known instead of guessing.

## What the server does with it

`licenseManager.getAvailableReleases()` returns the newest verified values:

```js
{ server: { version: '1.4.0', releasedAt: '2026-07-20' },
  agent:  { version: '0.20.1', releasedAt: null },
  checkedAt: '2026-07-28T09:00:00.000Z' }   // or null when nothing is known
```

`GET /system/version` exposes it as `upstream`, along with the two comparisons
that matter (`src/lib/version.js`, same comparison the dashboard already uses to
flag out-of-date agents):

* `serverUpdateAvailable` — the published server version is newer than this
  server's `package.json` version.
* `agentUpdateAvailable` — the published agent version is newer than the agent
  **source bundle** this server serves. That is the version a `git pull` on the
  host moves, and what installer-based agents can reach.

### Which agent version the server offers

`agent` in `GET /system/version` is the **newer of two things**: the newest
signed release in the release store, and the packaged source bundle. Not simply
the release.

It used to be simply the release, on the reasoning that a signed release can
never be newer than the source it was signed from. A release that is signed and
then never re-signed breaks that. A host pulled its agent checkout to v0.27.0
and reloaded the source; the store still held a signed v0.24.0; every one-click
Update went on pushing v0.24.0, and the dashboard reported the fleet up to date
because it was comparing against v0.24.0. A stale signature must not pin the
fleet backwards.

So:

* `GET /system/version` offers the newer of the two, and the dashboard's
  divergence note is written from the comparison rather than asserting a
  direction (both directions happen, and they need opposite advice).
* `POST /agents/:id/update` mints a fresh signed release whenever the source is
  newer than the newest release — not only when there is no release at all. If
  this server has no signing key, it pushes the newer **unsigned** source and
  logs why, rather than pushing older code that happens to carry a signature.
  (An agent pinned to a release key refuses the unsigned bundle; that is a
  visible failure, where the silent downgrade was not.)
* `POST /system/agent-source/reload` returns `releaseNote` saying why a re-sign
  did not happen — no signing key, an unusable key, no writable
  `AGENT_RELEASE_DIR`, or the signing error itself. It used to swallow the
  failure and answer a plain OK.

To see what a server is actually serving, without a token or a login:

```
docker compose logs server | grep 'agent source packaged'
# enroll: agent source packaged v0.27.0 from /agent-src (… bytes, sha256 …)
```

`scripts/deploy.sh` reads that same line after its restart and warns when it
does not match the agent checkout on disk.

A malformed version from the signer is dropped rather than shown — a phantom
"update available" badge is worse than no badge. The values survive a restart
(they are cached with the proof) and an unreachable license server (the last
known values are kept).

## When the agent refuses the update

An agent installed by `install.sh` pins the server's Ed25519 release **public**
key (systemd drop-in `10-release-key.conf`) and verifies every self-update
against it. It therefore refuses:

* an **unsigned** push — `refusing unsigned update: a release public key is
  pinned or signed updates are required (possible signature downgrade)`
* a release signed with a **different** key — `release signature did not verify`

Both are the fail-closed answer to a server that cannot prove what it is
shipping, and both show up the same way in the dashboard: the command is
accepted, the agent then reports the failure, and its version never moves.

Two things have to be true for a one-click update to land on a pinned agent:

1. **This server can sign.** `POST /agents/:id/update` now returns
   `signedReason` when it could not, and the dashboard says which it is:

   | `signedReason` | What it means | Fix |
   | --- | --- | --- |
   | `no-key` | no release key at all | generate one in Settings → Agent key |
   | `verify-only` | only `AGENT_RELEASE_PUBLIC_KEY` — no private half here | generate a managed key |
   | `undecryptable` | a managed key is stored but will not decrypt (`SECRET_ENCRYPTION_KEY`/`JWT_SECRET` changed after it was generated) | delete it, generate a new one |
   | `sign-failed` | signing threw — see the system log | as logged |

   Each unsigned push is recorded in the system log as `agent.update-unsigned`
   with the reason, so the cause outlives the toast.

2. **The agent pins the key this server signs with.** After generating a new
   key, existing agents still trust the old one. Re-pin them:

   ```
   curl -fsSL https://<server>/enroll/repin.sh | sudo sh
   ```

   `GET /enroll/repin.sh` rewrites `10-release-key.conf` with the key the server
   serves now and restarts the unit. It carries **no enrollment code**: it cannot
   enroll, cannot change the agent's identity or token, and cannot create a
   second agent for the host. It is trust-on-first-use again, exactly as the
   install was, so it prints the key's fingerprint for comparison with Settings →
   Agent key, and it refuses to run when the server publishes no key.

   The dashboard offers the command where the failure appears: on a refused
   update, and in Settings → Updates when one-click updates are blocked.

## When the update installs but nothing changes

The agent extracts the new release, installs dependencies and then asks systemd
to restart the unit. If that restart does not happen (no privilege, no systemd,
a masked unit), the new code is on disk and the **old process is still running**
— so the agent keeps reporting the old version. That used to be reported as a
successful update, for ever. The agent now checks the restart and reports

```
installed v0.27.0 but the service restart failed (…) — run: systemctl restart blueeye-agent
```

as a FAILED action instead, which is what the dashboard shows and what the audit
row records.

## Deploying a server update

**Settings → Updates** shows what is available. How it is deployed depends on one
environment variable:

| `SERVER_UPDATE_COMMAND` | What the panel offers |
| --- | --- |
| unset (default) | The command to run on the host by hand (`./scripts/deploy.sh` in the blueeye-server checkout). No endpoint can start anything. |
| set to the script's absolute path | An admin-only **Run update** button that starts exactly that script, plus a live log tail. |

Related settings: `SERVER_UPDATE_ARGS` (whitespace-separated arguments),
`SERVER_UPDATE_LOG` (default `.server-update.log` in the working directory),
`SERVER_UPDATE_STATE` (run state file), `SERVER_UPDATE_CWD` (working directory
for the script).

### The safety properties

* **The command can only come from the environment.** Nothing from an HTTP
  request reaches the command line — the endpoint starts one pre-approved
  script or nothing. There is no shell: the script is exec'd directly, so no
  argument can turn into shell syntax.
* **Admin only, and audit-logged** (`system` / `server_update_start`, with the
  target version).
* **Single-flight.** A second request while a run is in progress gets `409`.
* **Disabled by default.** An install that never sets the variable has exactly
  the behaviour it had before this feature existed.

### What running it looks like

The deploy script normally restarts this very server, so:

* the child is spawned **detached**, with its output redirected to the log file;
* the run state is written to disk, so the outcome survives the restart that
  kills the process observing it;
* `POST /system/server-update` answers `202` (started), and the dashboard
  follows `GET /system/server-update` — which tails the log. When the server
  goes away mid-update, the UI says it is restarting rather than showing an
  error, and the run is later reported as `ended` (no exit code recorded)
  rather than being stuck at "running" forever.

The script gets `BLUEEYE_UPDATE_TARGET_VERSION` in its environment (the signed
target version, for logging) — it is not required to use it.

## Deploying an agent update

Agents are updated the way they always were, and the license server does not
change that:

1. Update the agent source on the **server host** (`git pull` in the
   `blueeye-agent` checkout — `scripts/deploy.sh` does both repos).
2. **Settings → Updates → Reload agent source** (or restart the server) so the
   new bundle is packaged and served.
3. Systemd agents can then be updated one-click from the same panel. A **Windows**
   agent that is behind gets an **Update** button in Agents that hands you a
   PowerShell command to run on that host — it downloads `update.ps1` to a file
   and runs it (deliberately not piped into `iex`, see "Why not `irm … | iex`" in
   `docs/enrollment.md`), updates the installed agent in place, keeps its
   token/identity and never enrolls a second agent. Docker / unmanaged agents
   re-run their installer on their own host.

The "a newer agent has been published" line in the panel is the trigger for
step 1 — before, there was nothing to tell an operator that a new agent existed.

## Related

* `blueeye-licens` `docs/release-tracking.md` — the publishing side: how the
  license server learns the versions, and how a vendor admin pins or holds one
  back.
* `docs/licensing.md` — the licence check itself (signing, grace, caching).
