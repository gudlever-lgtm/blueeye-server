#!/usr/bin/env bash
#
# Generate the mTLS certificate set for BlueEye.
# Works on Linux and macOS (requires openssl).
#
#   ./scripts/gen_certs.sh                 # CA + server cert + agent-001
#   ./scripts/gen_certs.sh agent <name>    # one new agent cert (CN = <name>)
#
# Certificates are written to ../certs relative to this script.

set -euo pipefail

CERT_DIR="${CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/certs}"
CA_DAYS=3650
LEAF_DAYS=825

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

gen_ca() {
  if [[ -f ca.crt && -f ca.key ]]; then
    echo "CA already exists, reusing $CERT_DIR/ca.crt"
    return
  fi
  openssl genrsa -out ca.key 4096
  openssl req -x509 -new -nodes -key ca.key -sha256 -days "$CA_DAYS" \
    -subj "/CN=BlueEye-CA" -out ca.crt
  echo "Created CA: $CERT_DIR/ca.crt"
}

gen_server() {
  openssl genrsa -out server.key 2048
  openssl req -new -key server.key -subj "/CN=blueeye-server" -out server.csr
  cat > server.ext <<'EOF'
subjectAltName = DNS:blueeye-server,DNS:server,DNS:localhost,IP:127.0.0.1
extendedKeyUsage = serverAuth
EOF
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out server.crt -days "$LEAF_DAYS" -sha256 -extfile server.ext
  rm -f server.csr server.ext
  echo "Created server cert: $CERT_DIR/server.crt"
}

gen_agent() {
  local name="$1"
  openssl genrsa -out "${name}.key" 2048
  openssl req -new -key "${name}.key" -subj "/CN=${name}" -out "${name}.csr"
  cat > "${name}.ext" <<'EOF'
extendedKeyUsage = clientAuth
EOF
  openssl x509 -req -in "${name}.csr" -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out "${name}.crt" -days "$LEAF_DAYS" -sha256 -extfile "${name}.ext"
  rm -f "${name}.csr" "${name}.ext"
  echo "Created agent cert: $CERT_DIR/${name}.crt  (CN=${name})"
}

case "${1:-all}" in
  agent)
    if [[ -z "${2:-}" ]]; then
      echo "usage: $0 agent <name>" >&2
      exit 1
    fi
    gen_ca
    gen_agent "$2"
    ;;
  all)
    gen_ca
    gen_server
    gen_agent "agent-001"
    ;;
  *)
    echo "usage: $0 [all | agent <name>]" >&2
    exit 1
    ;;
esac

echo "Done."
