# Reverse proxy — serving blueeye.gnf.dk over HTTPS on :443

The blueeye-server app speaks **plain HTTP** and listens on **:3000** (it does no
TLS itself — see `src/server.js`, `app.listen(config.port)`). To reach it at
`https://blueeye.gnf.dk` on the standard HTTPS port, put a TLS-terminating
reverse proxy in front:

```
client ──HTTPS:443──▶  lighttpd (TLS)  ──HTTP:3000──▶  blueeye-server
                          on the host                    (app / container)
```

A ready-to-use lighttpd config lives at
[`deploy/lighttpd/blueeye.gnf.dk.conf`](../deploy/lighttpd/blueeye.gnf.dk.conf).

## The one thing that's easy to get wrong: WebSockets

The agents and the live dashboard use WebSockets (`/ws/agent`, `/ws/dashboard` —
see `config.ws` in `src/config.js`). A bare reverse-proxy config drops the HTTP
`Upgrade` header, so **plain API calls keep working while every agent and the
live UI silently fail to connect**. In lighttpd you carry it with:

```lighttpd
proxy.header = ( "upgrade" => "enable" )   # requires lighttpd >= 1.4.46
```

(On lighttpd >= 1.4.74 you can instead set `"upgrade" => "enable"` as a per-host
option inside `proxy.server`.)

## Set up lighttpd

1. **Get a certificate** for `blueeye.gnf.dk` (e.g. Let's Encrypt via certbot).
   The sample points at `/etc/letsencrypt/live/blueeye.gnf.dk/{fullchain,privkey}.pem`.

2. **Install the config:**
   ```bash
   sudo cp deploy/lighttpd/blueeye.gnf.dk.conf /etc/lighttpd/conf-available/10-blueeye.conf
   sudo lighttpd-enable-mod blueeye        # or symlink into /etc/lighttpd/conf-enabled/
   sudo lighttpd -t -f /etc/lighttpd/lighttpd.conf   # validate the syntax
   sudo systemctl reload lighttpd
   ```

3. **Verify** (TLS, the API, and the WebSocket upgrade):
   ```bash
   curl -fsS https://blueeye.gnf.dk/health                     # -> ok
   curl -fsS https://blueeye.gnf.dk/enroll/config | jq .serverUrl   # -> "https://blueeye.gnf.dk"
   curl -fsS -o /dev/null -w '%{http_code}\n' \
     -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
     -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
     https://blueeye.gnf.dk/ws/dashboard                       # -> 101 (Switching Protocols) or 401, NOT 200/400
   ```

## App-side settings (no code change required)

The app already runs with `app.set('trust proxy', true)` (`src/app.js`), so with
the proxy passing `X-Forwarded-Proto: https` and the original `Host`, enrollment
URLs already come out as `https://blueeye.gnf.dk`. Two things to set on the host:

- **`BLUEEYE_PUBLIC_URL=https://blueeye.gnf.dk`** (recommended). This is the
  canonical URL clients use; setting it explicitly removes any reliance on header
  derivation for the install scripts and `/enroll/config`.

- **Agent certificate pinning.** Because lighttpd now terminates TLS, the value
  agents pin is the **proxy's** leaf certificate, not the app's. Set
  `AGENT_CERT_FINGERPRINT` to its SHA-256:
  ```bash
  echo | openssl s_client -connect blueeye.gnf.dk:443 -servername blueeye.gnf.dk 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256
  ```
  Leave it unset to skip pinning. (Let's Encrypt rotates certs every ~90 days, so
  pin only if you have a process to update this on renewal.)

## Hardening: don't expose :3000 publicly

Once lighttpd fronts the app, the app should only be reachable from the proxy.

- **Docker compose:** bind the published port to loopback by setting
  `SERVER_HOST_PORT=127.0.0.1:3000` in `.env` (the compose mapping is
  `"${SERVER_HOST_PORT:-3000}:3000"`), so the host exposes :3000 only on
  localhost where lighttpd reaches it.
- **Bare-metal / systemd:** the app already listens on all interfaces on :3000;
  firewall :3000 from the outside, or bind it to localhost.

## Operational note: existing agents

Moving the public endpoint to `https://blueeye.gnf.dk` (443) means agents must
use that URL. **New** enrollments pick it up automatically (via
`BLUEEYE_PUBLIC_URL` / the derived URL). **Existing** agents that were pointed at
`http://blueeye.gnf.dk:3000` need re-pointing to the HTTPS URL — and their pinned
fingerprint updated to the proxy cert if pinning is in use. Keep :3000 reachable
during the cutover if you need to migrate agents gradually.
