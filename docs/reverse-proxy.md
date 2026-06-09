# Reverse proxy & HTTPS — serving blueeye.gnf.dk on :443

blueeye-server speaks **plain HTTP** and listens on **:3000** — it does no TLS
itself (`src/server.js` → `app.listen(config.port)`; `config.port` defaults to
3000 in `src/config.js`). To reach it at **`https://blueeye.gnf.dk`** on the
standard HTTPS port, terminate TLS in a reverse proxy in front of the app:

```
                       ┌──────────────────────┐
 client ──HTTPS:443──▶ │  reverse proxy (TLS)  │ ──HTTP:3000──▶ blueeye-server
  (browser / agent)    │      on the host      │                (app / container)
                       └──────────────────────┘
```

443 is the standard HTTPS port, so it passes normal firewall rules with no
special handling, and you no longer expose :3000 to the network.

> The app is **designed** for this: it already runs with `app.set('trust proxy',
> true)` (`src/app.js`) and derives its public URL from the proxy's
> `X-Forwarded-Proto` + `Host` (`src/routes/enroll.js`). **No application code
> change is required** — this is purely deployment configuration.

## Contents
- [Requirements](#requirements)
- [Approaches at a glance](#approaches-at-a-glance)
- [Recommended: Caddy](#recommended-caddy)
- [Alternative: lighttpd](#alternative-lighttpd)
- [Alternative without TLS](#alternative-without-tls)
- [Firewall](#firewall)
- [App-side settings](#app-side-settings)
- [Zero-downtime migration](#zero-downtime-migration)
- [Verify](#verify)
- [Troubleshooting](#troubleshooting)

## Requirements

| | Requirement |
|---|---|
| **DNS** | `blueeye.gnf.dk` resolves to the host's public IP (needed for clients and for ACME cert issuance). |
| **Certificate** | A TLS cert for `blueeye.gnf.dk`. Caddy provisions + renews one automatically (ACME); with lighttpd you supply one (e.g. certbot); or bring your own. |
| **Ports** | Inbound **443/tcp** (required). Inbound **80/tcp** optional (redirect + ACME HTTP-01). Outbound **443/tcp** to the ACME CA when auto-provisioning. See [Firewall](#firewall). |
| **Proxy software** | Caddy v2 (any recent), **or** lighttpd **≥ 1.4.46** (WebSocket proxying; **≥ 1.4.53** for the separate `ssl.privkey` shown below). |
| **WebSocket pass-through** | The proxy must forward the HTTP `Upgrade` header for `/ws/agent` + `/ws/dashboard`. Caddy: automatic. lighttpd: one directive (below). |
| **App** | Keeps listening on :3000 (no change). Optionally set `BLUEEYE_PUBLIC_URL`. |

## Approaches at a glance

| Approach | Encryption | Cert handling | WebSockets | Effort | Use when |
|---|---|---|---|---|---|
| **Caddy** (recommended) | ✅ HTTPS | **Automatic** (ACME) | Automatic | ★ lowest | You want real HTTPS with the least work |
| **lighttpd** | ✅ HTTPS | You supply (certbot/manual) | One directive | ★★ | lighttpd already runs on the host |
| **Publish :443, no proxy** | ❌ plain HTTP on 443 | n/a | n/a | ★ lowest | Trusted LAN only, or TLS terminated upstream |

The first two satisfy "needs to be HTTPS with a certificate"; the third is
documented only as the explicit non-TLS shortcut, with its trade-off.

## Recommended: Caddy

The entire config (`deploy/caddy/Caddyfile`):
```caddy
blueeye.gnf.dk {
	reverse_proxy 127.0.0.1:3000
}
```
Caddy automatically obtains + renews the certificate, redirects `http→https`,
sets the `X-Forwarded-*` headers the app reads, and proxies WebSockets
transparently.

```bash
# Install Caddy: https://caddyserver.com/docs/install
sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Bring your own certificate instead of ACME:
```caddy
blueeye.gnf.dk {
	tls /etc/ssl/blueeye.gnf.dk/fullchain.pem /etc/ssl/blueeye.gnf.dk/privkey.pem
	reverse_proxy 127.0.0.1:3000
}
```
Or keep auto-renewal but point ACME at a different CA (internal/EU PKI) with the
global `acme_ca` option.

## Alternative: lighttpd

Use this if lighttpd already serves the host. Full sample:
`deploy/lighttpd/blueeye.gnf.dk.conf`. The essentials:
```lighttpd
$SERVER["socket"] == ":443" {
  ssl.engine  = "enable"
  ssl.pemfile = "/etc/letsencrypt/live/blueeye.gnf.dk/fullchain.pem"
  ssl.privkey = "/etc/letsencrypt/live/blueeye.gnf.dk/privkey.pem"   # <1.4.53: key+chain in ssl.pemfile
  $HTTP["host"] == "blueeye.gnf.dk" {
    setenv.add-request-header = ( "X-Forwarded-Proto" => "https" )
    proxy.server = ( "" => ( ( "host" => "127.0.0.1", "port" => 3000 ) ) )
    proxy.header = ( "upgrade" => "enable" )    # ← carries the WebSockets; do not omit
  }
}
```
lighttpd does not provision certs — supply one (e.g. `certbot certonly`).
Validate with `lighttpd -t -f /etc/lighttpd/lighttpd.conf` and reload. The sample
file includes the `:80→:443` redirect, module loads, and install steps.

## Alternative without TLS

If — and only if — the link is a trusted LAN, or TLS is already terminated by
something upstream, you can skip the proxy and publish the container on host
:443 (still **plain HTTP**):
```bash
# blueeye-server/.env
SERVER_HOST_PORT=443
```
then `docker compose up -d`. The Docker daemon binds host :443; Node still binds
:3000 inside the container (no privileged-port issue), and the internal wiring
(`http://server:3000`, the container healthcheck) is untouched.

**Trade-off:** this is plain HTTP on the HTTPS port — `https://blueeye.gnf.dk`
won't work, and logins, agent tokens and enrollment travel in cleartext. **Not
suitable for an internet-facing deployment** and it does **not** meet a "needs to
be HTTPS" requirement; it is listed only for completeness.

## Firewall

| Port | Direction | Required? | Why |
|---|---|---|---|
| **443/tcp** | inbound | **Yes** | HTTPS for dashboard + agents. Also serves Caddy's TLS-ALPN-01 cert challenge. |
| **80/tcp** | inbound | Optional | `http→https` redirect + ACME **HTTP-01** challenge. If only 443 is open, Caddy still issues/renews via **TLS-ALPN-01 over 443**. |
| **443/tcp** | outbound | If auto-cert | So the proxy reaches the ACME CA to issue/renew. Not needed with a manual cert. |
| **3000/tcp** | inbound | **No — close it** | Only the proxy needs it. See [migration](#zero-downtime-migration) for when/how. |

A firewall that already allows inbound 443 (almost all do) needs no special rule.

## App-side settings (no code change)

- **`BLUEEYE_PUBLIC_URL=https://blueeye.gnf.dk`** (recommended) — the canonical
  URL baked into install scripts and returned by `/enroll/config`. Setting it
  removes any reliance on header derivation for those.
- **`trust proxy`** — already enabled in `src/app.js`; the app reads
  `X-Forwarded-Proto` / `Host`, so enrollment URLs come out as
  `https://blueeye.gnf.dk` provided the proxy forwards them (Caddy and the
  lighttpd sample both do).
- **Agent cert pinning** (`AGENT_CERT_FINGERPRINT` / `TLS_CERT_FINGERPRINT`) —
  optional. If used, pin the **proxy's** leaf cert:
  ```bash
  echo | openssl s_client -connect blueeye.gnf.dk:443 -servername blueeye.gnf.dk 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256
  ```
  An ACME cert rotates ~every 90 days, so either leave pinning off (rely on CA
  trust) or automate updating this value on renewal.
- **Stop exposing :3000** — see migration Phase 3.

## Zero-downtime migration

The proxy fronts the **same** app on :3000, so 443 and 3000 serve the identical
server simultaneously. You can cut over with **no downtime** and no rush. Each
agent holds a single WebSocket regardless of path, so license/agent counts are
unaffected. The path is: **run both → migrate agents → HTTPS-only.**

### Phase 1 — add 443, keep 3000 (both live)
1. Stand up the proxy (Caddy/lighttpd) on :443 → `127.0.0.1:3000`.
2. Keep the app's :3000 exposed exactly as today.
3. Set `BLUEEYE_PUBLIC_URL=https://blueeye.gnf.dk` so **new** enrollments use
   HTTPS. **Existing** agents keep their stored `http://blueeye.gnf.dk:3000` and
   are unaffected — they are not auto-repointed.

Now both `https://blueeye.gnf.dk` and `http://blueeye.gnf.dk:3000` reach the same
server.

### Phase 2 — migrate agents to HTTPS, at your pace
For each agent: set `BLUEEYE_SERVER_URL=https://blueeye.gnf.dk`, restart it, and
confirm it returns **online** in the dashboard (its live channel reconnects as
`wss://blueeye.gnf.dk/ws/agent` through the proxy).
- **Cert trust:** with a public CA (Caddy/Let's Encrypt) agents trust the cert
  out of the box. An internal CA needs its root installed on the agent hosts.
- Old agents on :3000 keep working throughout — there is no deadline.

### Phase 3 — go HTTPS-only (close :3000)
The app still **listens** on :3000 internally (the proxy forwards to it);
"HTTPS-only" means nothing *external* can reach :3000.

**Recommended — bind the published port to loopback.** Then :3000 is published
only on `127.0.0.1` (where the proxy reaches it) and is simply unreachable from
the network — no firewall rule to get right. Keep it host-local with a
`docker-compose.override.yml` so the shared `docker-compose.yml` (and the demo
flow) stays untouched:

```yaml
# docker-compose.override.yml (gnf.dk host only; recent Docker Compose v2)
services:
  server:
    ports: !override            # !override REPLACES the list — Compose otherwise
      - "127.0.0.1:3000:3000"    # *concatenates* ports and keeps the public bind
```
then `docker compose up -d`. Leave `SERVER_HOST_PORT` at its default so
`deploy.sh`'s `http://localhost:3000/health` check still hits the loopback bind.
(If your Compose predates the `!override` tag, instead edit the base mapping to
`"127.0.0.1:${SERVER_HOST_PORT:-3000}:3000"`.)

**Optional extra layer — firewall.** Defense-in-depth on top of the loopback
bind. ⚠️ A plain `ufw deny 3000` does **not** stop a Docker-published port —
Docker inserts its own iptables rules and published ports bypass `ufw` / the
`INPUT` chain; block it in the `DOCKER-USER` chain instead. With the loopback
bind above this is moot.

> **Gotcha:** `SERVER_HOST_PORT=127.0.0.1:3000` *also* binds loopback, but
> `scripts/deploy.sh` builds its health URL as
> `http://localhost:${SERVER_HOST_PORT}/health` → `http://localhost:127.0.0.1:3000/health`,
> which is malformed. It is non-fatal (the check is `|| true`; you just get a
> false "did not report healthy" warning), but prefer the override file to avoid it.

### Rollback
At any phase, point agents back to `http://blueeye.gnf.dk:3000` (or re-open
:3000) — the app never stops serving it until Phase 3, and reverting Phase 3 is
just re-opening :3000 / removing the override.

## Verify

```bash
curl -fsS https://blueeye.gnf.dk/health                          # -> ok
curl -fsS https://blueeye.gnf.dk/enroll/config | jq .serverUrl   # -> "https://blueeye.gnf.dk"

# WebSocket upgrade (expect 101 Switching Protocols, or 401 if auth-gated — NOT 200/400):
curl -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://blueeye.gnf.dk/ws/dashboard

# Inspect the certificate the proxy serves:
echo | openssl s_client -connect blueeye.gnf.dk:443 -servername blueeye.gnf.dk 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| API works but **agents/dashboard won't connect**, no live updates | WebSocket `Upgrade` not forwarded. lighttpd: add `proxy.header = ( "upgrade" => "enable" )`. Caddy: handled automatically by `reverse_proxy`. |
| Browser warns / agent rejects the cert | Cert hostname mismatch; or (agents) an internal CA whose root isn't trusted on the agent host; or a stale pinned `AGENT_CERT_FINGERPRINT` after the cert rotated. |
| `502` / `503` from the proxy | App not listening on :3000, or the proxy can't reach `127.0.0.1:3000` (wrong interface / blocked). |
| Enrollment URLs come out as `http://…` or `…:3000` | `BLUEEYE_PUBLIC_URL` unset **and** the proxy isn't sending `X-Forwarded-Proto: https` + the original `Host`. Set `BLUEEYE_PUBLIC_URL`. |
| Redirect loop on `http://` | Both the proxy and something upstream redirect to HTTPS, or the app sees `X-Forwarded-Proto: https` while actually reached over plain HTTP. |
| `deploy.sh` reports "did not report healthy" but the app is fine | `SERVER_HOST_PORT` set to a `host:port` form (e.g. `127.0.0.1:3000`) — see the Phase 3 gotcha. |
