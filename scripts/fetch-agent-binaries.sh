#!/usr/bin/env bash
set -euo pipefail

# Publish BlueEye agent binaries into this server's artifacts dir, so they are
# served at /enroll/agent/:platform and the one-line installer works.
#
# The binaries are built + released by the blueeye-agent repo (Node SEA, see its
# .github/workflows/release-agent.yml). This script just drops them into place.
# The server scans + checksums the artifacts dir at startup, so RESTART the
# server afterwards.
#
# Online (host can reach GitHub):
#   scripts/fetch-agent-binaries.sh                  # latest release
#   scripts/fetch-agent-binaries.sh --tag v0.1.0     # a specific release
#
# Air-gapped (download the release assets on another machine, copy them in, then):
#   scripts/fetch-agent-binaries.sh --from /mnt/usb/blueeye-binaries
#
# Options:
#   --tag <tag>    release tag to fetch        (default: latest)
#   --dir <dir>    artifacts dir               (default: $AGENT_ARTIFACTS_DIR or ./artifacts)
#   --from <dir>   copy from a local dir instead of downloading
#   --repo <o/r>   source repo                 (default: gudlever-lgtm/blueeye-agent)
#
# Auth: the agent repo is private, so downloading needs either the `gh` CLI
# (authenticated) or a GITHUB_TOKEN in the environment.

REPO="gudlever-lgtm/blueeye-agent"
TAG="latest"
FROM=""
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${AGENT_ARTIFACTS_DIR:-$ROOT/artifacts}"

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)  TAG="$2"; shift 2 ;;
    --dir)  DIR="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    -h|--help) sed -n '3,28p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown option '$1' (try --help)" >&2; exit 1 ;;
  esac
done

mkdir -p "$DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -n "$FROM" ]; then
  echo "[publish] copying agent binaries from $FROM"
  cp "$FROM"/blueeye-agent-* "$TMP"/
  [ -f "$FROM/SHA256SUMS" ] && cp "$FROM/SHA256SUMS" "$TMP"/ || true
elif command -v gh >/dev/null 2>&1; then
  echo "[publish] downloading release '$TAG' from $REPO via gh"
  GH_TAG_ARGS=""
  [ "$TAG" != "latest" ] && GH_TAG_ARGS="$TAG"
  gh release download $GH_TAG_ARGS --repo "$REPO" --dir "$TMP" \
    --pattern 'blueeye-agent-*' --pattern 'SHA256SUMS' --clobber
else
  : "${GITHUB_TOKEN:?Need the gh CLI or a GITHUB_TOKEN to download from a private repo}"
  echo "[publish] downloading release '$TAG' from $REPO via API"
  rel="$([ "$TAG" = latest ] && echo latest || echo "tags/$TAG")"
  curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" \
       -H "Accept: application/vnd.github+json" \
       "https://api.github.com/repos/$REPO/releases/$rel" > "$TMP/release.json"
  # Extract each matching asset's API url + name (no jq dependency).
  TMP="$TMP" node -e '
    const fs = require("fs");
    const r = JSON.parse(fs.readFileSync(process.env.TMP + "/release.json", "utf8"));
    for (const a of r.assets || []) {
      if (/^blueeye-agent-/.test(a.name) || a.name === "SHA256SUMS") {
        console.log(a.url + "\t" + a.name);
      }
    }
  ' | while IFS=$'\t' read -r url name; do
      echo "[publish]   $name"
      curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" \
           -H "Accept: application/octet-stream" "$url" -o "$TMP/$name"
    done
fi

# Verify checksums when the manifest is present (defensive — the installer also
# re-verifies on the target before running anything).
if [ -f "$TMP/SHA256SUMS" ]; then
  echo "[publish] verifying SHA-256 ..."
  ( cd "$TMP" && sha256sum -c SHA256SUMS )
else
  echo "[publish] WARNING: no SHA256SUMS found — skipping checksum verification" >&2
fi

count=0
for f in "$TMP"/blueeye-agent-*; do
  [ -e "$f" ] || { echo "ERROR: no blueeye-agent-* binaries found" >&2; exit 1; }
  install -m 0755 "$f" "$DIR/$(basename "$f")"
  count=$((count + 1))
done

echo "[publish] installed $count binar$([ "$count" = 1 ] && echo y || echo ies) into $DIR"
echo "[publish] restart the server to pick them up (binaries are scanned at startup)."
