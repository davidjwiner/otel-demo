import { v } from "convex/values";
import { query } from "./_generated/server";

// Note: the sink is a demo tool, so reads are public but gated on SINK_TOKEN
// when it is set.
function check(token: string | undefined) {
  const expected = process.env.SINK_TOKEN;
  if (expected && token !== expected) throw new Error("bad token");
}

export const recentTraces = query({
  args: { token: v.optional(v.string()), limit: v.optional(v.number()), service: v.optional(v.string()) },
  handler: async (ctx, { token, limit, service }) => {
    check(token);
    const spans = service
      ? await ctx.db.query("spans").withIndex("by_service", (q) => q.eq("service", service)).order("desc").take(1000)
      : await ctx.db.query("spans").withIndex("by_start").order("desc").take(1000);
    const byTrace = new Map<string, typeof spans>();
    for (const s of spans) {
      const list = byTrace.get(s.traceId) ?? [];
      list.push(s);
      byTrace.set(s.traceId, list);
    }
    const out = [...byTrace.entries()].map(([traceId, list]) => {
      const ids = new Set(list.map((s) => s.spanId));
      const roots = list.filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId));
      const start = Math.min(...list.map((s) => s.startMs));
      const end = Math.max(...list.map((s) => s.endMs));
      return {
        traceId,
        root: roots.sort((a, b) => a.startMs - b.startMs)[0]?.name,
        services: [...new Set(list.map((s) => s.service))],
        origins: [...new Set(list.map((s) => s.origin))],
        spanCount: list.length,
        rootCount: roots.length,
        startMs: start,
        durationMs: end - start,
      };
    });
    return out.sort((a, b) => b.startMs - a.startMs).slice(0, limit ?? 20);
  },
});

export const trace = query({
  args: { token: v.optional(v.string()), traceId: v.string() },
  handler: async (ctx, { token, traceId }) => {
    check(token);
    return await ctx.db
      .query("spans")
      .withIndex("by_trace", (q) => q.eq("traceId", traceId))
      .collect();
  },
});

export const spansSince = query({
  args: { token: v.optional(v.string()), sinceMs: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { token, sinceMs, limit }) => {
    check(token);
    return await ctx.db
      .query("spans")
      .withIndex("by_start", (q) => q.gte("startMs", sinceMs))
      .take(limit ?? 2000);
  },
});

export const logEvents = query({
  args: { token: v.optional(v.string()), requestId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { token, requestId, limit }) => {
    check(token);
    if (requestId)
      return await ctx.db.query("logEvents").withIndex("by_request", (q) => q.eq("requestId", requestId)).collect();
    return await ctx.db.query("logEvents").withIndex("by_time").order("desc").take(limit ?? 100);
  },
});

export const externalCalls = query({
  args: { token: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { token, limit }) => {
    check(token);
    return await ctx.db.query("externalCalls").order("desc").take(limit ?? 50);
  },
});

export const batches = query({
  args: { token: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { token, limit }) => {
    check(token);
    const rows = await ctx.db.query("batches").order("desc").take(limit ?? 20);
    return await Promise.all(
      rows.map(async (b) => ({ ...b, rawUrl: b.rawId ? await ctx.storage.getUrl(b.rawId) : null })),
    );
  },
});
