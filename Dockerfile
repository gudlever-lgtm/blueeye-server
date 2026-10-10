# BlueEyes server — on-prem API + agent WebSocket.
FROM node:22-alpine

# GNU tar. The image ships busybox tar, which cannot build a REPRODUCIBLE
# archive — it rejects --sort, --mtime, --owner, --group and --numeric-owner,
# and those are what make the agent source bundle hash the same twice. Without
# them the checksum embedded in the install script stops matching the tarball
# the host then downloads, and an update fails with "checksum mismatch".
# See src/enroll/agentSourceStore.js.
# su-exec: drops to the unprivileged user in docker/entrypoint.sh after the
# one-time volume chown. 20 KB, in Alpine's own repo, no shell wrapper.
RUN apk add --no-cache tar su-exec

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Not root. The node images ship an unprivileged `node` user (uid 1000); /data is
# the named volume the server writes to, and /var/lib/blueeye is the artifact
# volume it shares with the Service Assurance worker — both have to belong to it
# before the drop, or the first write fails at boot.
#
# Docker chowns a named volume to the container user on FIRST creation only, so
# an existing install's /data stays root-owned. docker/entrypoint.sh fixes that
# once, as root, then drops — which is why the entrypoint exists at all.
RUN mkdir -p /data /var/lib/blueeye/service-assurance  && chown -R node:node /data /var/lib/blueeye /app

ENV NODE_ENV=production
EXPOSE 3000

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# docker-compose overrides this to run migrations (and the demo seed) first.
CMD ["node", "src/server.js"]
