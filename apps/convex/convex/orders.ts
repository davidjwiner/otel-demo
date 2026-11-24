import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import { ConsoleTracer, parseTraceparent } from "./lib/consoleSpan";
import { extract, flush, inject, withSpan } from "./lib/otel";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    for (const item of ["widget", "gadget", "gizmo"]) {
      const row = await ctx.db.query("inventory").withIndex("by_item", (q) => q.eq("item", item)).unique();
      if (row) await ctx.db.patch(row._id, { stock: 1_000_000 });
      else await ctx.db.insert("inventory", { item, stock: 1_000_000 });
    }
  },
});

// `trace` is an optional W3C traceparent. Convex doesn't propagate trace
// context, so the traced variant passes it as a regular argument.
export const getInventory = internalQuery({
  args: { item: v.string(), trace: v.optional(v.string()) },
  handler: async (ctx, { item, trace }) => {
    const t = new ConsoleTracer();
    return t.span("query orders:getInventory", parseTraceparent(trace), { "convex.function.type": "query" }, (self) =>
      t.span("db.query inventory.by_item", self.traceId ? self : null, { "db.collection.name": "inventory", "db.index": "by_item" }, async () =>
        ctx.db.query("inventory").withIndex("by_item", (q) => q.eq("item", item)).unique(),
      ),
    );
  },
});

export const createOrder = internalMutation({
  args: { item: v.string(), qty: v.number(), trace: v.optional(v.string()) },
  handler: async (ctx, { item, qty, trace }) => {
    const t = new ConsoleTracer();
    const parent = parseTraceparent(trace);
    return t.span("mutation orders:createOrder", parent, { "convex.function.type": "mutation" }, async (self) => {
      const p = parent ? self : null;
      const inv = await t.span("db.query inventory.by_item", p, { "db.collection.name": "inventory" }, async () =>
        ctx.db.query("inventory").withIndex("by_item", (q) => q.eq("item", item)).unique(),
      );
      if (!inv || inv.stock < qty) throw new Error(`out of stock: ${item}`);
      await t.span("db.patch inventory", p, { "db.collection.name": "inventory" }, async () =>
        ctx.db.patch(inv._id, { stock: inv.stock - qty }),
      );
      return await t.span("db.insert orders", p, { "db.collection.name": "orders" }, async () =>
        ctx.db.insert("orders", { item, qty, status: "pending", traceparent: trace }),
      );
    });
  },
});

export const getOrder = internalQuery({
  args: { orderId: v.id("orders"), trace: v.optional(v.string()) },
  handler: async (ctx, { orderId, trace }) => {
    const t = new ConsoleTracer();
    return t.span("query orders:getOrder", parseTraceparent(trace), { "convex.function.type": "query" }, async () =>
      ctx.db.get(orderId),
    );
  },
});

export const setStatus = internalMutation({
  args: { orderId: v.id("orders"), status: v.union(v.literal("fulfilled"), v.literal("failed")), trace: v.optional(v.string()) },
  handler: async (ctx, { orderId, status, trace }) => {
    const t = new ConsoleTracer();
    await t.span("mutation orders:setStatus", parseTraceparent(trace), { "convex.function.type": "mutation", "order.status": status }, async () =>
      ctx.db.patch(orderId, { status }),
    );
  },
});

// Background job: plays the role of an LLM call or fulfillment provider.
export const fulfill = internalAction({
  args: { orderId: v.id("orders"), trace: v.optional(v.string()) },
  handler: async (ctx, { orderId, trace }) => {
    const site = process.env.SINK_URL!;
    if (!trace) {
      // Plain variant: no instrumentation at all.
      await ctx.runQuery(internal.orders.getOrder, { orderId });
      const res = await fetch(`${site}/fake-api?ms=400&fail=0.2&caller=convex-plain-fulfill`);
      await ctx.runMutation(internal.orders.setStatus, { orderId, status: res.ok ? "fulfilled" : "failed" });
      return;
    }
    // Traced variant: continue the trace from the traceparent in the args.
    const parent = extract(trace);
    await withSpan("action orders:fulfill", parent, { kind: SpanKind.CONSUMER, attributes: { "order.id": orderId } }, async (fctx, _tp, root) => {
      await withSpan("convex.runQuery orders:getOrder", fctx, { kind: SpanKind.CLIENT }, async (_c, tp) =>
        ctx.runQuery(internal.orders.getOrder, { orderId, trace: tp }),
      );
      const ok = await withSpan("GET /fake-api (llm)", fctx, { kind: SpanKind.CLIENT, attributes: { "http.request.method": "GET", "server.address": new URL(site).host } }, async (_c, tp, span) => {
        const res = await fetch(`${site}/fake-api?ms=400&fail=0.2&caller=convex-traced-fulfill`, { headers: tp ? { traceparent: tp } : {} });
        span.setAttribute("http.response.status_code", res.status);
        if (!res.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.status}` });
        return res.ok;
      });
      await withSpan("convex.runMutation orders:setStatus", fctx, { kind: SpanKind.CLIENT }, async (_c, tp) =>
        ctx.runMutation(internal.orders.setStatus, { orderId, status: ok ? "fulfilled" : "failed", trace: tp }),
      );
      if (!ok) root.setStatus({ code: SpanStatusCode.ERROR, message: "fulfillment failed" });
    });
    await flush();
  },
});
