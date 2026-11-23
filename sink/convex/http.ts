import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import {
  parseOtlpJson,
  spanFromConsole,
  spanFromFunctionExecution,
  type SpanRow,
} from "./otlp";

const http = httpRouter();

const KEEP_HEADERS = [
  "content-type",
  "content-encoding",
  "user-agent",
  "traceparent",
  "tracestate",
  "x-vercel-id",
  "x-otel-source",
];

function pickHeaders(req: Request) {
  const out: Record<string, string> = {};
  for (const h of KEEP_HEADERS) {
    const v = req.headers.get(h);
    if (v) out[h] = v;
  }
  return out;
}

const CHUNK = 150;

async function insertSpans(ctx: any, batchId: any, spans: SpanRow[]) {
  for (let i = 0; i < spans.length; i += CHUNK) {
    await ctx.runMutation(internal.ingest.insertSpans, {
      batchId,
      spans: spans.slice(i, i + CHUNK),
    });
  }
}

async function readBody(req: Request): Promise<Uint8Array<ArrayBuffer>> {
  const buf = new Uint8Array(await req.arrayBuffer());
  if ((req.headers.get("content-encoding") ?? "").includes("gzip")) {
    const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return buf;
}

// Simple bearer-token check so random traffic can't fill the sink.
function authorized(req: Request): boolean {
  const token = process.env.SINK_TOKEN;
  if (!token) return true;
  const auth = req.headers.get("authorization") ?? "";
  const url = new URL(req.url);
  return auth === `Bearer ${token}` || req.headers.get("x-sink-token") === token || url.searchParams.get("token") === token;
}

// ---- OTLP/HTTP traces receiver ---------------------------------------------
http.route({
  path: "/v1/traces",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) {
      // Record rejected exports so misconfigured senders are visible.
      const h = pickHeaders(req);
      await ctx.runMutation(internal.ingest.createBatch, {
        source: "otlp", contentType: h["content-type"], userAgent: h["user-agent"],
        headers: JSON.stringify({ ...h, authorizationPresent: req.headers.has("authorization") }),
        spanCount: 0, eventCount: 0, note: "rejected: bad or missing token",
      });
      return new Response("unauthorized", { status: 401 });
    }
    const contentType = req.headers.get("content-type") ?? "";
    const raw = await readBody(req);
    const rawId = await ctx.storage.store(new Blob([raw], { type: contentType }));
    const headers = pickHeaders(req);

    if (!contentType.includes("json")) {
      await ctx.runMutation(internal.ingest.createBatch, {
        source: "otlp",
        contentType,
        userAgent: headers["user-agent"],
        headers: JSON.stringify(headers),
        spanCount: 0,
        eventCount: 0,
        rawId,
        note: "non-JSON body stored but not parsed; configure the exporter for http/json",
      });
      return new Response(
        JSON.stringify({ error: "This sink only parses OTLP/HTTP JSON. Set the exporter protocol to http/json." }),
        { status: 415, headers: { "content-type": "application/json" } },
      );
    }

    const body = JSON.parse(new TextDecoder().decode(raw));
    const spans = parseOtlpJson(body);
    const batchId = await ctx.runMutation(internal.ingest.createBatch, {
      source: "otlp",
      contentType,
      userAgent: headers["user-agent"],
      headers: JSON.stringify(headers),
      spanCount: spans.length,
      eventCount: 0,
      rawId,
    });
    await insertSpans(ctx, batchId, spans);

    // Optional fan-out to a real backend (Axiom, Honeycomb, Grafana, ...).
    const fwd = process.env.FORWARD_OTLP_ENDPOINT;
    if (fwd) {
      const extra = JSON.parse(process.env.FORWARD_OTLP_HEADERS ?? "{}");
      await fetch(fwd, {
        method: "POST",
        headers: { "content-type": "application/json", ...extra },
        body: raw,
      }).catch((e) => console.error("forward failed", e));
    }
    return new Response(JSON.stringify({ partialSuccess: {} }), {
      headers: { "content-type": "application/json" },
    });
  }),
});

// ---- Convex log stream (webhook destination) --------------------------------
http.route({
  path: "/logstream",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return new Response("unauthorized", { status: 401 });
    const raw = await readBody(req);
    const text = new TextDecoder().decode(raw);
    let events: any[];
    try {
      const parsed = JSON.parse(text);
      events = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }
    const rawId = await ctx.storage.store(new Blob([raw], { type: "application/json" }));
    const spans: SpanRow[] = [];
    for (const e of events) {
      const s = spanFromFunctionExecution(e) ?? spanFromConsole(e);
      if (s) spans.push(s);
    }
    const headers = pickHeaders(req);
    const batchId = await ctx.runMutation(internal.ingest.createBatch, {
      source: "logstream",
      contentType: headers["content-type"],
      userAgent: headers["user-agent"],
      headers: JSON.stringify(headers),
      spanCount: spans.length,
      eventCount: events.length,
      rawId,
    });
    const rows = events.map((e) => ({
      topic: String(e.topic ?? "unknown"),
      timestamp: Number(e.timestamp ?? 0),
      requestId: e.function?.request_id,
      functionPath: e.function?.path,
      functionType: e.function?.type,
      deployment: e.convex?.deployment_name,
      event: JSON.stringify(e),
    }));
    for (let i = 0; i < rows.length; i += CHUNK) {
      await ctx.runMutation(internal.ingest.insertLogEvents, { batchId, events: rows.slice(i, i + CHUNK) });
    }
    await insertSpans(ctx, batchId, spans);
    return new Response("ok");
  }),
});

// ---- Fake external API -----------------------------------------------------
// Stands in for a payment provider or LLM. Sleeps, then records which trace
// headers the caller sent, so we can see if outbound fetch was instrumented.
http.route({
  path: "/fake-api",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const delayMs = Math.min(Number(url.searchParams.get("ms") ?? 200), 5000);
    const failRate = Number(url.searchParams.get("fail") ?? 0);
    await new Promise((r) => setTimeout(r, delayMs));
    const failed = Math.random() < failRate;
    await ctx.runMutation(internal.ingest.recordExternalCall, {
      caller: url.searchParams.get("caller") ?? undefined,
      traceparent: req.headers.get("traceparent") ?? undefined,
      tracestate: req.headers.get("tracestate") ?? undefined,
      baggage: req.headers.get("baggage") ?? undefined,
      userAgent: req.headers.get("user-agent") ?? undefined,
      delayMs,
      failed,
    });
    return new Response(
      JSON.stringify({ ok: !failed, delayMs, receivedTraceparent: req.headers.get("traceparent") }),
      { status: failed ? 502 : 200, headers: { "content-type": "application/json" } },
    );
  }),
});

export default http;
