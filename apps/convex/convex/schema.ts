import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  inventory: defineTable({ item: v.string(), stock: v.number() }).index("by_item", ["item"]),
  orders: defineTable({
    item: v.string(),
    qty: v.number(),
    status: v.union(v.literal("pending"), v.literal("fulfilled"), v.literal("failed")),
    // Only set in the traced variant: the W3C traceparent we had to carry
    // by hand so the scheduled job can join the trace.
    traceparent: v.optional(v.string()),
  }),
});
