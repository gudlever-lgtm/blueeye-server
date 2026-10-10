#!/bin/sh
# Drops the server to the unprivileged `node` user, after making sure the
# volumes it writes to belong to that user.
#
# Why this is not just `USER node` in the Dockerfile: Docker chowns a named
# volume to the container's user when it CREATES the volume, and only then. An
# install that has been running with a root container already has a root-owned
# /data, so flipping the user alone makes the next boot fail on its first write
# — which is the worst possible moment to find out.
#
# So: start as root, fix the two volume paths if they need it, then drop. With no
# volumes to fix the chown is a no-op and this costs one syscall per boot.
set -eu

for dir in /data /var/lib/blueeye/service-assurance; do
  [ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || continue
  # Only when it is actually wrong — a chown -R over a large artifact volume on
  # every boot is a cost with nothing to show for it.
  owner="$(stat -c %u "$dir" 2>/dev/null || echo 0)"
  [ "$owner" = "1000" ] || chown -R node:node "$dir" 2>/dev/null || true
done

# BLUEEYE_RUN_AS_ROOT=1 is the escape hatch for a host that genuinely needs it
# (a bind mount owned by another uid that cannot be changed). It is loud on
# purpose: running the server as root is not a thing to discover later.
if [ "${BLUEEYE_RUN_AS_ROOT:-0}" = "1" ]; then
  echo "WARNING: BLUEEYE_RUN_AS_ROOT=1 — the server is running as root." >&2
  exec "$@"
fi

if [ "$(id -u)" = "0" ]; then
  exec su-exec node:node "$@" 2>/dev/null || exec setpriv --reuid=1000 --regid=1000 --init-groups "$@"
fi
exec "$@"
