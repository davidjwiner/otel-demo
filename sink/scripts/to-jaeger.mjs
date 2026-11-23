// Replay spans from the sink into a local Jaeger (or any OTLP/HTTP endpoint).
//   node scripts/to-jaeger.mjs [--minutes 60] [--endpoint http://localhost:4318/v1/traces]
import { q } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const minutes = Number(opt("minutes", 60));
const endpoint = opt("endpoint", "http://localhost:4318/v1/traces");

const KIND = { unspecified: 0, internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };
const STATUS = { unset: 0, ok: 1, error: 2 };
const val = (v) =>
  typeof v === "boolean" ? { boolValue: v }
  : typeof v === "number" ? (Number.isInteger(v) ? { intValue: v } : { doubleValue: v })
  : v == null ? { stringValue: "null" }
  : typeof v === "object" ? { stringValue: JSON.stringify(v) }
  : { stringValue: String(v) };
const kv = (o) => Object.entries(o ?? {}).map(([key, v]) => ({ key, value: val(v) }));
const ns = (ms) => (BigInt(Math.round(ms * 1e3)) * 1000n).toString();

const spans = await q("read:spansSince", { sinceMs: Date.now() - minutes * 60_000, limit: 5000 });
const groups = new Map();
for (const s of spans) {
  const resource = JSON.parse(s.resource);
  // Tag where each span came from so it's visible in Jaeger.
  resource["demo.origin"] = s.origin;
  resource["service.name"] ??= s.service;
  const key = JSON.stringify(resource);
  if (!groups.has(key)) groups.set(key, { resource, spans: [] });
  groups.get(key).spans.push({
    traceId: s.traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId,
    name: s.name,
    kind: KIND[s.kind] ?? 0,
    startTimeUnixNano: ns(s.startMs),
    endTimeUnixNano: ns(s.endMs),
    attributes: kv(JSON.parse(s.attributes)),
    events: JSON.parse(s.events).map((e) => ({ name: e.name, timeUnixNano: ns(e.timeMs ?? s.startMs), attributes: kv(e.attributes) })),
    links: JSON.parse(s.links).map((l) => ({ traceId: l.traceId, spanId: l.spanId, attributes: kv(l.attributes) })),
    status: { code: STATUS[s.statusCode] ?? 0, message: s.statusMessage },
  });
}
const body = {
  resourceSpans: [...groups.values()].map((g) => ({
    resource: { attributes: kv(g.resource) },
    scopeSpans: [{ scope: { name: "otel-demo-replay" }, spans: g.spans }],
  })),
};
const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
console.log(`replayed ${spans.length} spans to ${endpoint}: HTTP ${r.status}`);
