import { httpRouter } from "convex/server";
import { SpanKind, SpanStatusCode, trace as otelTrace } from "@opentelemetry/api";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { extract, flush, tracer, withSpan } from "./lib/otel";

const http = httpRouter();

// Variant A, "zero config": no instrumentation. Whatever reaches the sink
// comes from the Convex log stream alone.
http.route({
  path: "/orders",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const { item = "widget", qty = 1 } = await req.json().catch(() => ({}));
    const site = process.env.SINK_URL!;
    const inv = await ctx.runQuery(internal.orders.getInventory, { item });
    if (!inv) return new Response("unknown item", { status: 404 });
    const orderId = await ctx.runMutation(internal.orders.createOrder, { item, qty });
    const pay = await fetch(`${site}/fake-api?ms=250&caller=convex-plain-payment`);
    await ctx.scheduler.runAfter(0, internal.orders.fulfill, { orderId });
    return Response.json({ orderId, payment: pay.status, incomingTraceparent: req.headers.get("traceparent") });
  }),
});

// Variant B, "best effort": the most a user can do today. OTel SDK in the
// HTTP action and the scheduled action, console spans in the query and
// mutation, and traceparent threaded through every call by hand.
http.route({
  path: "/orders-traced",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const { item = "widget", qty = 1 } = await req.json().catch(() => ({}));
    const site = process.env.SINK_URL!;
    const parent = extract(req.headers.get("traceparent"));
    const span = tracer().startSpan(
      "POST /orders-traced",
      { kind: SpanKind.SERVER, attributes: { "http.request.method": "POST", "http.route": "/orders-traced", "order.item": item } },
      parent,
    );
    const sctx = otelTrace.setSpan(parent, span);
    let body: any;
    try {
      const inv = await withSpan("convex.runQuery orders:getInventory", sctx, { kind: SpanKind.CLIENT }, (_c, tp) =>
        ctx.runQuery(internal.orders.getInventory, { item, trace: tp }),
      );
      if (!inv) throw new Error("unknown item");
      const orderId = await withSpan("convex.runMutation orders:createOrder", sctx, { kind: SpanKind.CLIENT }, (_c, tp) =>
        ctx.runMutation(internal.orders.createOrder, { item, qty, trace: tp }),
      );
      const payment = await withSpan("GET /fake-api (payment)", sctx, { kind: SpanKind.CLIENT, attributes: { "http.request.method": "GET" } }, async (_c, tp, s) => {
        const r = await fetch(`${site}/fake-api?ms=250&caller=convex-traced-payment`, { headers: tp ? { traceparent: tp } : {} });
        s.setAttribute("http.response.status_code", r.status);
        return r.status;
      });
      await withSpan("convex.scheduler.runAfter orders:fulfill", sctx, { kind: SpanKind.PRODUCER }, (_c, tp) =>
        ctx.scheduler.runAfter(0, internal.orders.fulfill, { orderId, trace: tp }),
      );
      span.setAttribute("http.response.status_code", 200);
      body = { orderId, payment, traceId: span.spanContext().traceId };
    } catch (e: any) {
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(e?.message ?? e) });
      body = { error: String(e?.message ?? e) };
    } finally {
      span.end();
    }
    // Export happens on the request path: the client waits for this.
    const flushMs = await flush();
    return Response.json({ ...body, flushMs, incomingTraceparent: req.headers.get("traceparent") });
  }),
});

export default http;
