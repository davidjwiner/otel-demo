import { after } from "next/server";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { migrate, pool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const tracer = trace.getTracer("otel-demo-vercel");
const SINK = process.env.SINK_SITE!;

export async function POST(req: Request) {
  const { item = "widget", qty = 1 } = await req.json().catch(() => ({}));
  await migrate();
  const db = pool();

  const inv = await db.query("SELECT stock FROM inventory WHERE item = $1", [item]);
  if (!inv.rows[0]) return new Response("unknown item", { status: 404 });

  const orderId: number = await tracer.startActiveSpan("create order (tx)", async (span) => {
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await c.query("UPDATE inventory SET stock = stock - $1 WHERE item = $2", [qty, item]);
      const { rows } = await c.query("INSERT INTO orders (item, qty, status) VALUES ($1, $2, 'pending') RETURNING id", [item, qty]);
      await c.query("COMMIT");
      span.setAttribute("order.id", rows[0].id);
      return rows[0].id;
    } finally {
      c.release();
      span.end();
    }
  });

  const pay = await fetch(`${SINK}/fake-api?ms=250&caller=vercel-payment`, { cache: "no-store" });

  // Background work after the response, in the same invocation.
  after(() =>
    tracer.startActiveSpan("fulfill order (after)", { kind: SpanKind.INTERNAL, attributes: { "order.id": orderId } }, async (span) => {
      try {
        await db.query("SELECT * FROM orders WHERE id = $1", [orderId]);
        const res = await fetch(`${SINK}/fake-api?ms=400&fail=0.2&caller=vercel-fulfill`, { cache: "no-store" });
        if (!res.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: `llm HTTP ${res.status}` });
        await db.query("UPDATE orders SET status = $1 WHERE id = $2", [res.ok ? "fulfilled" : "failed", orderId]);
      } finally {
        span.end();
      }
    }),
  );

  return Response.json({
    orderId,
    payment: pay.status,
    traceId: trace.getActiveSpan()?.spanContext().traceId,
    incomingTraceparent: req.headers.get("traceparent"),
  });
}
