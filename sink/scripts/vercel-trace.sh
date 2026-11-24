#!/usr/bin/env bash
# Produce one Vercel trace with no client span: POST to the deployed app
# (no traceparent header, so Vercel's edge starts the trace), wait for the
# Trace Drain to deliver it, print it, and push it into local Jaeger.
#   ./scripts/vercel-trace.sh [url]
set -euo pipefail
URL="${1:-https://otel-demo-vercel.previews.convex.dev}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BODY=$(cd "$HERE/../../apps/vercel" && vercel curl "$URL/api/orders" --scope convex-dev -- -s -X POST \
  -H 'content-type: application/json' --data '{"item":"widget"}' 2>/dev/null | tail -1)
echo "$BODY"
T=$(echo "$BODY" | sed -E 's/.*"traceId":"([0-9a-f]{32})".*/\1/')
echo "trace $T: waiting for the Trace Drain (usually 30-60s)..."
cd "$HERE/.."
until node -e "import('./scripts/lib.mjs').then(async ({q})=>{const s=await q('read:trace',{traceId:'$T'});process.exit(s.some(x=>x.service==='vercel.edge-network')?0:1)})"; do sleep 5; done
sleep 5 # let any straggler batches land
node scripts/trace.mjs "$T"
if curl -s -o /dev/null localhost:16686; then
  node scripts/to-jaeger.mjs --minutes 3 >/dev/null && echo "Jaeger: http://localhost:16686/trace/$T"
fi
