# BlueEyes server — on-prem API + agent WebSocket.
FROM node:22-alpine

# GNU tar. The image ships busybox tar, which cannot build a REPRODUCIBLE
# archive — it rejects --sort, --mtime, --owner, --group and --numeric-owner,
# and those are what make the agent source bundle hash the same twice. Without
# them the checksum embedded in the install script stops matching the tarball
# the host then downloads, and an update fails with "checksum mismatch".
# See src/enroll/agentSourceStore.js.
RUN apk add --no-cache tar

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# docker-compose overrides this to run migrations (and the demo seed) first.
CMD ["node", "src/server.js"]
