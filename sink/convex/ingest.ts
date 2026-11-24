import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const spanValidator = v.object({
  traceId: v.string(),
  spanId: v.string(),
  parentSpanId: v.optional(v.string()),
  name: v.string(),
  kind: v.string(),
  startMs: v.number(),
  endMs: v.number(),
  durationMs: v.number(),
  service: v.string(),
  origin: v.union(v.literal("otlp"), v.literal("logstream"), v.literal("console-span")),
  statusCode: v.string(),
  statusMessage: v.optional(v.string()),
  attributes: v.string(),
  resource: v.string(),
  scope: v.optional(v.string()),
  events: v.string(),
  links: v.string(),
});

export const createBatch = internalMutation({
  args: {
    source: v.union(v.literal("otlp"), v.literal("logstream")),
    contentType: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    headers: v.string(),
    spanCount: v.number(),
    eventCount: v.number(),
    rawId: v.optional(v.id("_storage")),
    note: v.optional(v.string()),
  },
  handler: (ctx, args) => ctx.db.insert("batches", args),
});

export const insertSpans = internalMutation({
  args: { batchId: v.id("batches"), spans: v.array(spanValidator) },
  handler: async (ctx, { batchId, spans }) => {
    for (const s of spans) await ctx.db.insert("spans", { ...s, batchId });
  },
});

export const insertLogEvents = internalMutation({
  args: {
    batchId: v.id("batches"),
    events: v.array(
      v.object({
        topic: v.string(),
        timestamp: v.number(),
        requestId: v.optional(v.string()),
        functionPath: v.optional(v.string()),
        functionType: v.optional(v.string()),
        deployment: v.optional(v.string()),
        event: v.string(),
      }),
    ),
  },
  handler: async (ctx, { batchId, events }) => {
    for (const e of events) await ctx.db.insert("logEvents", { ...e, batchId });
  },
});

export const recordExternalCall = internalMutation({
  args: {
    caller: v.optional(v.string()),
    traceparent: v.optional(v.string()),
    tracestate: v.optional(v.string()),
    baggage: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    delayMs: v.number(),
    failed: v.boolean(),
  },
  handler: (ctx, args) => ctx.db.insert("externalCalls", args),
});

// Wipe everything (run with `npx convex run ingest:clear`). Deletes in pages.
export const clear = internalMutation({
  args: {},
  handler: async (ctx) => {
    let n = 0;
    for (const t of ["spans", "logEvents", "externalCalls", "batches"] as const) {
      const rows = await ctx.db.query(t).take(2000);
      for (const r of rows) {
        if (t === "batches" && (r as any).rawId) await ctx.storage.delete((r as any).rawId);
        await ctx.db.delete(r._id);
        n++;
      }
    }
    return n;
  },
});
