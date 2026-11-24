import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per POST we receive, raw body kept in file storage so we can
  // inspect exactly what each platform sent.
  batches: defineTable({
    source: v.union(v.literal("otlp"), v.literal("logstream")),
    contentType: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    headers: v.string(), // JSON of selected request headers
    spanCount: v.number(),
    eventCount: v.number(),
    rawId: v.optional(v.id("_storage")),
    note: v.optional(v.string()),
  }),

  // Normalized spans. `origin` says where the span came from:
  //  - otlp: a real OTLP span exported by an SDK or platform drain
  //  - logstream: rebuilt from a Convex `function_execution` log event
  //  - console-span: rebuilt from a span-shaped console.log in a Convex function
  spans: defineTable({
    traceId: v.string(),
    spanId: v.string(),
    parentSpanId: v.optional(v.string()),
    name: v.string(),
    kind: v.string(),
    startMs: v.number(),
    endMs: v.number(),
    durationMs: v.number(),
    service: v.string(),
    origin: v.union(
      v.literal("otlp"),
      v.literal("logstream"),
      v.literal("console-span"),
    ),
    statusCode: v.string(),
    statusMessage: v.optional(v.string()),
    attributes: v.string(), // JSON object, flattened attribute map
    resource: v.string(), // JSON object
    scope: v.optional(v.string()),
    events: v.string(), // JSON array
    links: v.string(), // JSON array
    batchId: v.id("batches"),
  })
    .index("by_trace", ["traceId", "startMs"])
    .index("by_service", ["service", "startMs"])
    .index("by_start", ["startMs"]),

  // Raw Convex log stream events (webhook destination).
  logEvents: defineTable({
    topic: v.string(),
    timestamp: v.number(),
    requestId: v.optional(v.string()),
    functionPath: v.optional(v.string()),
    functionType: v.optional(v.string()),
    deployment: v.optional(v.string()),
    event: v.string(), // JSON
    batchId: v.id("batches"),
  })
    .index("by_request", ["requestId", "timestamp"])
    .index("by_time", ["timestamp"]),

  // Calls to the fake external API. Records whether the caller injected
  // W3C trace context, which shows whether outbound fetch is instrumented.
  externalCalls: defineTable({
    caller: v.optional(v.string()),
    traceparent: v.optional(v.string()),
    tracestate: v.optional(v.string()),
    baggage: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    delayMs: v.number(),
    failed: v.boolean(),
  }),
});
