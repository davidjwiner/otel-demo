#!/usr/bin/env bash
# Produce one Render trace with no client span: POST to the deployed app (no
# traceparent header, so the Render app starts the trace), wait for the SDK's
# batch exporter, print it, and push it into local Jaeger.
#   ./scripts/render-trace.sh [url]
# Note: free Render services sleep when idle; the first request can take ~30-60s.
set -euo pipefail
URL="${1:-https://otel-demo-render.onrender.com}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BODY=$(curl -s -m 120 -X POST "$URL/orders" -H 'content-type: application/json' --data '{"item":"widget"}')
echo "$BODY"
T=$(echo "$BODY" | sed -E 's/.*"traceId":"([0-9a-f]{32})".*/\1/')
echo "trace $T: waiting for the background job and exporter..."
cd "$HERE/.."
until node -e "import('./scripts/lib.mjs').then(async ({q})=>{const s=await q('read:trace',{traceId:'$T'});process.exit(s.some(x=>x.name==='fulfill order')?0:1)})"; do sleep 3; done
sleep 6 # let the final batch (worker's last spans) land
node scripts/trace.mjs "$T"
if curl -s -o /dev/null localhost:16686; then
  node scripts/to-jaeger.mjs --minutes 3 >/dev/null && echo "Jaeger: http://localhost:16686/trace/$T"
fi
