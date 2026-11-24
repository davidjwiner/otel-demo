import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(here, "..", ".env.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).replace(/#.*/, "").trim()];
    }),
);
export const SINK_URL = process.env.SINK_URL ?? env.CONVEX_URL;
export const SINK_SITE = process.env.SINK_SITE ?? env.CONVEX_SITE_URL;
export const TOKEN = process.env.SINK_TOKEN ?? env.SINK_TOKEN;
export const client = new ConvexHttpClient(SINK_URL);
export const api = anyApi;

export const q = (name, args = {}) => client.query(name, { token: TOKEN, ...args });

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n / 2))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const newIds = () => ({ traceId: hex(32), spanId: hex(16) });

// Post a span to the sink as OTLP/JSON (used for the synthetic "client" span).
export async function postSpan({ traceId, spanId, parentSpanId, name, service, startMs, endMs, kind = 3, attributes = {} }) {
  const ns = (ms) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
        scopeSpans: [
          {
            scope: { name: "otel-demo-loadgen" },
            spans: [
              {
                traceId, spanId, parentSpanId, name, kind,
                startTimeUnixNano: ns(startMs), endTimeUnixNano: ns(endMs),
                attributes: Object.entries(attributes).map(([key, v]) => ({
                  key, value: typeof v === "number" ? { doubleValue: v } : { stringValue: String(v) },
                })),
              },
            ],
          },
        ],
      },
    ],
  };
  const r = await fetch(`${SINK_SITE}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`postSpan ${r.status}: ${await r.text()}`);
}

// ---- ASCII waterfall --------------------------------------------------------
export function printTrace(spans, { attrs = false } = {}) {
  if (!spans.length) return console.log("  (no spans)");
  const ids = new Set(spans.map((s) => s.spanId));
  const kids = new Map();
  const roots = [];
  for (const s of spans) {
    if (s.parentSpanId && ids.has(s.parentSpanId)) {
      const l = kids.get(s.parentSpanId) ?? [];
      l.push(s);
      kids.set(s.parentSpanId, l);
    } else roots.push(s);
  }
  const t0 = Math.min(...spans.map((s) => s.startMs));
  const t1 = Math.max(...spans.map((s) => s.endMs));
  const W = 40;
  const scale = (t1 - t0) / W || 1;
  const walk = (s, depth) => {
    const a = Math.floor((s.startMs - t0) / scale);
    const b = Math.max(a + 1, Math.ceil((s.endMs - t0) / scale));
    const bar = " ".repeat(a) + "█".repeat(Math.min(W, b) - a);
    const orphan = s.parentSpanId && !ids.has(s.parentSpanId) ? " ⚠ parent missing" : "";
    const err = s.statusCode === "error" ? " ✖" : "";
    const label = `${"  ".repeat(depth)}${s.name}`.slice(0, 52).padEnd(52);
    console.log(`  ${label} ${bar.padEnd(W)} ${s.durationMs.toFixed(1).padStart(8)}ms  [${s.service}/${s.origin}]${err}${orphan}`);
    if (attrs) {
      const at = JSON.parse(s.attributes);
      for (const [k, v] of Object.entries(at)) console.log(`  ${"  ".repeat(depth + 2)}· ${k} = ${JSON.stringify(v)}`);
    }
    for (const k of (kids.get(s.spanId) ?? []).sort((x, y) => x.startMs - y.startMs)) walk(k, depth + 1);
  };
  for (const r of roots.sort((x, y) => x.startMs - y.startMs)) walk(r, 0);
  console.log(`  total ${(t1 - t0).toFixed(1)}ms, ${spans.length} spans, ${roots.length} root(s)`);
}
