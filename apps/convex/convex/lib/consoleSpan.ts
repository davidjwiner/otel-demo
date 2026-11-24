// The workaround for queries and mutations: they can't call fetch, so they
// can't export spans. Instead we console.log a span-shaped JSON blob and the
// log stream carries it to the sink, which rebuilds the span.
//
// Date.now() is frozen for the whole function in queries and mutations, so
// we anchor on it once and add performance.now() deltas.
export const MARKER = "__otel_span__";

type Parent = { traceId: string; spanId: string };

export function parseTraceparent(tp: string | undefined): Parent | null {
  const m = tp?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/);
  return m ? { traceId: m[1], spanId: m[2] } : null;
}

function randHex(n: number) {
  let s = "";
  while (s.length < n) s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return s.slice(0, n);
}

export class ConsoleTracer {
  private d0 = Date.now();
  private p0 = performance.now();
  constructor(private service = "convex-app") {}
  now() {
    return this.d0 + (performance.now() - this.p0);
  }

  async span<T>(
    name: string,
    parent: Parent | null,
    attributes: Record<string, unknown>,
    fn: (self: Parent) => Promise<T>,
  ): Promise<T> {
    if (!parent) return fn({ traceId: "", spanId: "" }); // untraced call: no-op
    const self = { traceId: parent.traceId, spanId: randHex(16) };
    const startMs = this.now();
    let status = "ok";
    let statusMessage: string | undefined;
    try {
      return await fn(self);
    } catch (e: any) {
      status = "error";
      statusMessage = String(e?.message ?? e);
      throw e;
    } finally {
      console.log(
        MARKER +
          JSON.stringify({
            ...self,
            parentSpanId: parent.spanId,
            name,
            kind: "internal",
            startMs,
            endMs: this.now(),
            service: this.service,
            status,
            statusMessage,
            attributes,
          }),
      );
    }
  }
}
