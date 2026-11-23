# otel-demo: what OpenTelemetry looks like on Vercel, Render, and Convex

The same small order-processing app is deployed to three platforms, and every trace goes to one OTLP sink so the exports can be compared side by side.

**Scenario.** A client sends `POST /orders` with a W3C `traceparent` header, as a browser with OTel would. The server then:

1. reads inventory
2. writes the order in a transaction
3. calls a "payment" API
4. queues a background "fulfillment" job

The job reads the order, calls a slow "LLM" API that fails 20% of the time, and writes the status.

```
sink/            Convex deployment that receives traces (OTLP/HTTP JSON at /v1/traces,
                 Convex webhook log stream at /logstream, fake external API at /fake-api)
  scripts/       run.mjs (load generator), trace.mjs (CLI waterfall),
                 jaeger.sh + to-jaeger.mjs (replay into a local Jaeger UI)
apps/convex/     Convex app with two variants:
                   POST /orders         no instrumentation (log stream only)
                   POST /orders-traced  best-effort manual tracing (OTel SDK in actions,
                                        console.log spans in queries/mutations,
                                        traceparent threaded through args by hand)
                 probe.ts, probeContext.ts: runtime capability probes
apps/vercel/     Next.js 16 + @vercel/otel + pg instrumentation, background work in after(),
                 plus a Vercel Trace Drain (project-scoped) for infrastructure spans
apps/render/     Express + stock OTel Node SDK with auto-instrumentation, Postgres job
                 queue with traceparent stored on the job row
render.yaml      Render Blueprint (free web service + free Postgres)
```

## Deployed instances

| What | Where |
| --- | --- |
| Sink | Convex `david-winer-cac68/otel-demo-sink` (dev deployment `kindly-cardinal-2`) |
| Convex app | Convex `david-winer-cac68/otel-demo-convex-app` (dev deployment `insightful-moose-887`), webhook log stream pointed at the sink |
| Vercel app | `convex-dev/otel-demo-vercel` at https://otel-demo-vercel.previews.convex.dev, behind Deployment Protection (use `vercel curl`). Trace Drain `drn_piiAziIaIcJdCKXP`, scoped to this project. Tracing sampling is set to production 100%. |
| Render app | https://otel-demo-render.onrender.com with Postgres `otel-demo-db` (free). The Vercel app shares this database. |

## User identity on spans

Both apps stamp a hard-coded demo user (`user.id = user_1001`, `user.email = ada@example.com`) on every server span through a small span processor: `apps/vercel/lib/demo-user.ts` and `apps/render/demo-user.mjs`. A real app would set these per request from its session. In Jaeger, filter with Tags = `user.id=user_1001`.

## Running it

```bash
cd sink
# Fire the scenario and print each resulting trace as a waterfall
CONVEX_APP_SITE=https://insightful-moose-887.convex.site \
RENDER_URL=https://otel-demo-render.onrender.com \
VERCEL_URL=https://otel-demo-vercel.previews.convex.dev VERCEL_SCOPE=convex-dev VERCEL_CWD=../apps/vercel \
  node scripts/run.mjs convex-plain convex-traced vercel render --n 2 --wait 45

node scripts/trace.mjs recent                 # list recent traces
node scripts/trace.mjs <traceId> --attrs      # waterfall with every exported attribute

./scripts/jaeger.sh &                         # local Jaeger UI at http://localhost:16686
node scripts/to-jaeger.mjs --minutes 120      # replay sink spans into it
```

The sink token lives in `sink/.env.local` (gitignored). The Vercel drain waits up to ~45s before delivering, so allow for that when you run the scenario.

## Findings

### One order, four ways

| | Vercel | Render | Convex, log stream only | Convex, hand-instrumented |
| --- | --- | --- | --- | --- |
| Spans per order | 23–29 (20 app + 3 infra) | 21 | 6 events, flat | 18 |
| Joins the client's trace | ✅ | ✅ | ❌ | ✅ (manual) |
| Background job in the same trace | ✅ `after()` / `waitUntil` | ✅ 3 lines to put `traceparent` on the job row | ❌ new `request_id`. Only the child records `scheduler_info.job_id`, and the parent never records it | ✅ (manual arg) |
| Parent/child structure | ✅ | ✅ | ❌ every event is a root | ✅ (manual) |
| Outbound `fetch` span + `traceparent` injected | ✅ automatic (opt-in per URL) | ✅ automatic | ❌ | manual |
| DB spans | ✅ automatic pg spans | ✅ automatic pg spans | totals per function only (`usage.*`) | manual. Query spans are always 0ms |
| Platform/infra spans | ✅ edge routing, function invoke, `waitUntil`, cold start (`load instrumentation module`) | ❌ (OTLP metrics only, Pro) | n/a | n/a |
| Instrumentation code | ~25 lines (`instrumentation.ts`) | ~25 lines + 3 for the queue | 0 | ~150 lines of helpers + a `trace` arg on every function |
| Added request latency | none (flush in `waitUntil`) | none (background batch export) | none | **+~200ms median** (448 → 647ms). `forceFlush()` sits on the request path at ~225ms |
| Export path | Trace Drain: OTLP/HTTP JSON or protobuf, custom headers, sampling rules | SDK exports directly | webhook / Axiom / Datadog / PostHog in Convex's own JSON schema | SDK in actions + console spans through the log stream |

### Convex runtime probes

| | query | mutation | action |
| --- | --- | --- | --- |
| `Date.now()` advances during the function | ❌ | ❌ | ✅ |
| `performance.now()` advances during the function | ❌ (**can't time anything in a query**) | ✅ | ✅ |
| global `AsyncLocalStorage` | ✅ | ✅ | ✅ |
| `fetch` (so OTLP export is possible) | ❌ | ❌ | ✅ |

- The OTel JS `OTLPTraceExporter` works in the default Convex runtime (it falls back to its `fetch` transport). `"use node"` is no longer needed, which resolves the first point in Ship #303.
- With no context manager, `startActiveSpan` doesn't nest across `await` (`probeContext:withoutContextManager` returns `innerIsChildOfOuter: false`). A 15-line context manager on the global `AsyncLocalStorage` fixes it (`probeContext:withGlobalAlsContextManager` returns `true`). Convex could ship this.

### What Convex's log stream does give you

`function_execution` events are rich: `request_id`, `execution_time_ms`, `user_execution_time_ms`, `run_reason` (`httpEndpoint`, `action`, `scheduler`, …), `scheduler_info.job_id`, `occ_info`, `usage.*` (documents and bytes read and written, memory), and `cached`. Nested `runQuery` and `runMutation` calls share the caller's `request_id`, so they can be grouped, but they still come out as flat roots. What's missing:

- trace or span IDs, and parent links
- the incoming `traceparent`
- HTTP method and status as separate fields (the path is `"POST /orders"`)
- outbound `fetch`
- the job ID on the scheduling side
- sub-millisecond timing (`execution_time_ms` is an integer)

### Other things noticed

- **Vercel:** tracing has to be switched on for projects on Next.js below 16.5 (`vercel traces config set production 100`). Until then the drain receives nothing.
- **Vercel:** `@vercel/otel` sends `traceparent` only to the URLs you list in `propagateContextUrls`.
- **Vercel:** the span wrapping `after()` work closes about 0.3ms after it starts, even though its children run ~500ms. I didn't find the cause.
- **Render:** a missing exporter header failed silently. The service ran fine and the spans were dropped. That's the cost of bringing your own SDK.
- **Render** has no resource detector, so `render.service.id` and similar attributes are mapped by hand in `instrumentation.mjs`.
