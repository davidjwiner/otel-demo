#!/usr/bin/env bash
# Download (once) and run Jaeger v2 locally. UI: http://localhost:16686
# OTLP/HTTP on :4318. Then run `node scripts/to-jaeger.mjs` to replay spans.
set -euo pipefail
VER=2.23.0
ARCH=$(uname -m | sed 's/x86_64/amd64/')
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
DIR="$(cd "$(dirname "$0")/../.." && pwd)/bin"
NAME="jaeger-$VER-$OS-$ARCH"
mkdir -p "$DIR"
if [ ! -x "$DIR/$NAME/jaeger" ]; then
  TMP=$(mktemp -d)
  gh release download "v$VER" --repo jaegertracing/jaeger -p "$NAME.tar.gz" -p "$NAME.sha256sum.txt" -D "$TMP"
  tar -xzf "$TMP/$NAME.tar.gz" -C "$TMP"
  # The checksum file covers the extracted binaries, not the tarball.
  (cd "$TMP" && grep '/jaeger$' "$NAME.sha256sum.txt" | shasum -a 256 -c -)
  mv "$TMP/$NAME" "$DIR/"
fi
exec "$DIR/$NAME/jaeger"
