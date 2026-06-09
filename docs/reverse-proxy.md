# Reverse proxy — serving blueeye.gnf.dk over HTTPS on :443

The blueeye-server app speaks **plain HTTP** on **:3000** (it does no TLS itself —
see `src/server.js`, `app.listen(config.port)`). To reach it at
`https://blueeye.gnf.dk` on the standard HTTPS port, terminate TLS in a reverse
proxy in front of it:

```
client ──HTTPS:443──▶  reverse proxy (TLS)  ──HTTP:3000──▶  blueeye-server
                          on the host                          (app / container)
```

443 is the standard HTTPS port, so it passes normal firewall rules with no
special handling — and you no longer need to expose :3000 to the network.

Two configs ship under `deploy/`:
- [`deploy/caddy/Caddyfile`](../deploy/caddy/Caddyfile) — **recommended, easiest**: automatic certificates.
- [`deploy/lighttpd/blueeye.gnf.dk.conf`](../deploy/lighttpd/blueeye.gnf.dk.conf) — use this if you already run lighttpd on the host.

## WebSockets (don't skip)

Agents and the live dashboard use WebSockets (`/ws/agent`, `/ws/dashboard` — see
`config.ws` in `src/config.js`). A proxy that drops the HTTP `Upgrade` header
leaves plain API calls working while **every agent and the live UI silently
fail**. Caddy handles this automatically; lighttpd needs
`proxy.header = ( "upgrade" => "enable" )` (already in the sample).

## Option A — Caddy (recommended)

The whole config:

```caddy
blueeye.gnf.dk {
	reverse_proxy 127.0.0.1:3000
}
```

Caddy **automatically obtains and renews** the certificate (ACME), redirects
`http://` → `https://`, sets the `X-Forwarded-*` headers the app reads, and
proxies WebSockets transparently.

```bash
# Install Caddy (see caddyserver.com/docs/install), then:
sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**Already have a certificate for the site?** Skip ACME and point Caddy at it:

```caddy
blueeye.gnf.dk {
	tls /etc/ssl/blueeye.gnf.dk/fullchain.pem /etc/ssl/blueeye.gnf.dk/privkey.pem
	reverse_proxy 127.0.0.1:3000
}
```

You can also keep automatic certs but point ACME at a different CA (e.g. an
internal or EU PKI) with the global `acme_ca` option, instead of the default
public CA.

## Option B — lighttpd

If lighttpd already serves the host, reuse it: the committed
[`deploy/lighttpd/blueeye.gnf.dk.conf`](../deploy/lighttpd/blueeye.gnf.dk.conf)
terminates TLS on :443, forwards to :3000, and includes the WebSocket
pass-through. Setup steps are in the file header. (It expects a certificate on
disk — e.g. from certbot — rather than provisioning one itself.)

## Firewall

| Port | Direction | Why |
| --- | --- | --- |
| **443/tcp** | inbound | HTTPS for the dashboard + agents. The "normal" rule. Also serves Caddy's TLS-ALPN-01 cert challenge. |
| **80/tcp** | inbound | Optional: the `http→https` redirect and the ACME **HTTP-01** challenge. If your firewall allows **only** 443, Caddy still issues/renews via **TLS-ALPN-01 over 443** — so 443-only works. |
| **443/tcp** | outbound | So the proxy can reach the ACME CA to issue/renew (not needed if you supply the cert manually). |
| **3000/tcp** | — | **Stop exposing it** — only the proxy needs it. Bind to loopback (below) or firewall it off. |

## App-side settings (no code change)

The app already runs with `app.set('trust proxy', true)` (`src/app.js`), so with
the proxy passing `X-Forwarded-Proto: https` + the original `Host`, enrollment
URLs come out as `https://blueeye.gnf.dk`. Recommended on the host:

- **`BLUEEYE_PUBLIC_URL=https://blueeye.gnf.dk`** — pins the canonical URL used in
  install scripts and `/enroll/config`.
- **Don't expose :3000.** Docker: set `SERVER_HOST_PORT=127.0.0.1:3000` in `.env`
  (the compose mapping is `"${SERVER_HOST_PORT:-3000}:3000"`). Bare-metal:
  firewall :3000 from the outside.
- **Agent cert pinning** (`AGENT_CERT_FINGERPRINT`): if used, pin the **proxy's**
  leaf cert, not the app's:
  ```bash
  echo | openssl s_client -connect blueeye.gnf.dk:443 -servername blueeye.gnf.dk 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256
  ```
  An ACME cert rotates ~every 90 days, so either leave pinning off or automate
  updating this value on renewal.

## Verify

```bash
curl -fsS https://blueeye.gnf.dk/health                          # -> ok
curl -fsS https://blueeye.gnf.dk/enroll/config | jq .serverUrl   # -> "https://blueeye.gnf.dk"
# WebSocket upgrade (expect 101 or 401, NOT 200/400):
curl -o /dev/null -w '%{http_code}\n' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://blueeye.gnf.dk/ws/dashboard
```

## Cutover: existing agents

The public endpoint becomes `https://blueeye.gnf.dk` (443). New enrollments pick
that up automatically; agents previously pointed at `http://blueeye.gnf.dk:3000`
must be re-pointed (and their pinned fingerprint updated to the proxy cert if
pinning is on). Keep :3000 reachable during the migration if you need to move
agents gradually.
