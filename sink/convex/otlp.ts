// Helpers for turning OTLP/JSON and Convex log stream payloads into rows.
// Plain functions (no Convex imports) so they run in any runtime.

export type SpanRow = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  service: string;
  origin: "otlp" | "logstream" | "console-span";
  statusCode: string;
  statusMessage?: string;
  attributes: string;
  resource: string;
  scope?: string;
  events: string;
  links: string;
};

const KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"];

export function kindName(kind: unknown): string {
  if (typeof kind === "number") return KINDS[kind] ?? String(kind);
  if (typeof kind === "string") {
    const k = kind.toLowerCase().replace("span_kind_", "");
    return k;
  }
  return "unspecified";
}

const STATUS = ["unset", "ok", "error"];
function statusName(code: unknown): string {
  if (typeof code === "number") return STATUS[code] ?? String(code);
  if (typeof code === "string") return code.toLowerCase().replace("status_code_", "");
  return "unset";
}

// OTLP AnyValue -> plain JS
export function anyValue(v: any): unknown {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("boolValue" in v) return v.boolValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("bytesValue" in v) return `bytes:${v.bytesValue}`;
  if ("arrayValue" in v) return (v.arrayValue?.values ?? []).map(anyValue);
  if ("kvlistValue" in v) return attrs(v.kvlistValue?.values ?? []);
  return null;
}

export function attrs(list: any[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of list ?? []) out[a.key] = anyValue(a.value);
  return out;
}

// OTLP/JSON should use lowercase hex IDs, but some exporters send base64.
function normId(id: unknown, hexLen: number): string | undefined {
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (/^[0-9a-fA-F]+$/.test(id) && id.length === hexLen) return id.toLowerCase();
  try {
    const bin = atob(id);
    let hex = "";
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
    if (hex.length === hexLen) return hex;
  } catch {
    // fall through
  }
  return id.toLowerCase();
}

function nanosToMs(n: unknown): number {
  if (n == null) return 0;
  // Nanosecond timestamps exceed 2^53, so divide in string space first.
  const s = String(n);
  if (s.length > 6) return Number(s.slice(0, -6)) + Number(s.slice(-6)) / 1e6;
  return Number(s) / 1e6;
}

export function parseOtlpJson(body: any): SpanRow[] {
  const rows: SpanRow[] = [];
  for (const rs of body?.resourceSpans ?? []) {
    const resource = attrs(rs.resource?.attributes);
    const service = String(resource["service.name"] ?? "unknown");
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) {
      const scope = ss.scope ?? ss.instrumentationLibrary;
      for (const s of ss.spans ?? []) {
        const startMs = nanosToMs(s.startTimeUnixNano);
        const endMs = nanosToMs(s.endTimeUnixNano);
        rows.push({
          traceId: normId(s.traceId, 32) ?? "missing",
          spanId: normId(s.spanId, 16) ?? "missing",
          parentSpanId: normId(s.parentSpanId, 16),
          name: String(s.name ?? ""),
          kind: kindName(s.kind),
          startMs,
          endMs,
          durationMs: Math.max(0, endMs - startMs),
          service,
          origin: "otlp",
          statusCode: statusName(s.status?.code),
          statusMessage: s.status?.message || undefined,
          attributes: JSON.stringify(attrs(s.attributes)),
          resource: JSON.stringify(resource),
          scope: scope ? JSON.stringify(scope) : undefined,
          events: JSON.stringify(
            (s.events ?? []).map((e: any) => ({
              name: e.name,
              timeMs: nanosToMs(e.timeUnixNano),
              attributes: attrs(e.attributes),
            })),
          ),
          links: JSON.stringify(
            (s.links ?? []).map((l: any) => ({
              traceId: normId(l.traceId, 32),
              spanId: normId(l.spanId, 16),
              attributes: attrs(l.attributes),
            })),
          ),
        });
      }
    }
  }
  return rows;
}

// ---- Convex log stream -> spans ------------------------------------------

// Deterministic 64-bit-ish hex id from a string (FNV-1a, twice).
export function hashHex(s: string, len = 16): string {
  let out = "";
  let seed = 0x811c9dc5;
  while (out.length < len) {
    let h = seed;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
    seed = (seed + 0x9e3779b9) >>> 0;
  }
  return out.slice(0, len);
}

function flatten(obj: any, prefix: string, out: Record<string, unknown>) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v as unknown;
  }
  return out;
}

// What a tracing backend could rebuild from today's log stream with no code
// changes: one root span per function execution, grouped by request_id.
export function spanFromFunctionExecution(e: any): SpanRow | null {
  if (e?.topic !== "function_execution") return null;
  const fn = e.function ?? {};
  const requestId: string = fn.request_id ?? "unknown";
  const dur = Number(e.execution_time_ms ?? 0);
  const endMs = Number(e.timestamp);
  const startMs = endMs - dur;
  const { topic, timestamp, convex, ...rest } = e;
  return {
    traceId: requestId.padStart(32, "0"),
    spanId: hashHex(`${requestId}|${fn.path}|${timestamp}|${dur}`),
    parentSpanId: undefined, // the log stream carries no parent information
    name: `${fn.type ?? "fn"} ${fn.path ?? "?"}`,
    kind: fn.type === "http_action" ? "server" : "internal",
    startMs,
    endMs,
    durationMs: dur,
    service: `convex-logstream:${convex?.deployment_name ?? "unknown"}`,
    origin: "logstream",
    statusCode: e.status === "failure" ? "error" : "ok",
    statusMessage: e.error_message || undefined,
    attributes: JSON.stringify(flatten(rest, "convex", {})),
    resource: JSON.stringify(flatten(convex ?? {}, "convex", {})),
    events: "[]",
    links: "[]",
  };
}

// The "best effort" workaround: functions that can't export (queries and
// mutations) console.log a span as JSON and we rebuild it here.
export const CONSOLE_SPAN_MARKER = "__otel_span__";

export function spanFromConsole(e: any): SpanRow | null {
  if (e?.topic !== "console") return null;
  const msg: string = e.message ?? "";
  const i = msg.indexOf(CONSOLE_SPAN_MARKER);
  if (i < 0) return null;
  const start = msg.indexOf("{", i);
  const end = msg.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let s: any;
  try {
    s = JSON.parse(msg.slice(start, end + 1).replace(/\\'/g, "'"));
  } catch {
    return null;
  }
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId || undefined,
    name: s.name,
    kind: s.kind ?? "internal",
    startMs: s.startMs,
    endMs: s.endMs,
    durationMs: s.endMs - s.startMs,
    service: s.service ?? "convex-app",
    origin: "console-span",
    statusCode: s.status ?? "unset",
    statusMessage: s.statusMessage,
    attributes: JSON.stringify({
      ...(s.attributes ?? {}),
      "convex.request_id": e.function?.request_id,
      "convex.function.path": e.function?.path,
      "convex.function.type": e.function?.type,
    }),
    resource: JSON.stringify({ "service.name": s.service ?? "convex-app" }),
    events: JSON.stringify(s.events ?? []),
    links: "[]",
  };
}
