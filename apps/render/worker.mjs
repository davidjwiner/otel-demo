// Background worker: polls a Postgres job table. Trace context travels in the
// job row (traceparent column), the same pattern you would use with any queue.
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { pool } from "./db.mjs";

const tracer = trace.getTracer("otel-demo-render-worker");
const SINK = process.env.SINK_SITE;

async function takeJob() {
  // Don't trace the idle poll loop, or every second becomes a trace.
  return context.with(suppressTracing(context.active()), async () => {
    const { rows } = await pool.query(`
      UPDATE jobs SET taken_at = now()
      WHERE id = (SELECT id FROM jobs WHERE taken_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`);
    return rows[0];
  });
}

async function fulfill(job) {
  const parent = propagation.extract(ROOT_CONTEXT, { traceparent: job.traceparent ?? "", tracestate: job.tracestate ?? "" });
  await context.with(parent, () =>
    tracer.startActiveSpan(
      "fulfill order",
      { kind: SpanKind.CONSUMER, attributes: { "messaging.system": "postgres", "messaging.operation.type": "process", "order.id": job.order_id } },
      async (span) => {
        try {
          await pool.query("SELECT * FROM orders WHERE id = $1", [job.order_id]);
          const res = await fetch(`${SINK}/fake-api?ms=400&fail=0.2&caller=render-fulfill`);
          const status = res.ok ? "fulfilled" : "failed";
          if (!res.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: `llm HTTP ${res.status}` });
          await pool.query("UPDATE orders SET status = $1 WHERE id = $2", [status, job.order_id]);
        } finally {
          span.end();
        }
      },
    ),
  );
}

export async function runWorker() {
  for (;;) {
    const job = await takeJob().catch((e) => (console.error("poll failed", e), null));
    if (job) await fulfill(job).catch((e) => console.error("job failed", e));
    else await new Promise((r) => setTimeout(r, 500));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runWorker();
