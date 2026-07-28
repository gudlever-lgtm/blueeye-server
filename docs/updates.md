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
  host moves, and what installer-based agents can reach; a signed release can
  never be newer than the source it was signed from.

A malformed version from the signer is dropped rather than shown — a phantom
"update available" badge is worse than no badge. The values survive a restart
(they are cached with the proof) and an unreachable license server (the last
known values are kept).

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
   PowerShell one-liner (`irm <server>/enroll/update.ps1 | iex`) to run on that
   host: it updates the installed agent in place, keeps its token/identity and
   never enrolls a second agent — see `docs/enrollment.md`. Docker / unmanaged
   agents re-run their installer on their own host.

The "a newer agent has been published" line in the panel is the trigger for
step 1 — before, there was nothing to tell an operator that a new agent existed.

## Related

* `blueeye-licens` `docs/release-tracking.md` — the publishing side: how the
  license server learns the versions, and how a vendor admin pins or holds one
  back.
* `docs/licensing.md` — the licence check itself (signing, grace, caching).
