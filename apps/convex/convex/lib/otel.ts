// OpenTelemetry SDK setup for Convex *actions and HTTP actions* (they can
// call fetch, so they can export). This follows the setup in
// docs.convex.dev/agents/debugging#tracing-llm-calls-with-opentelemetry.
//
// Things we have to do by hand that other platforms do for us:
//  - no context manager, so every span gets an explicit parent Context
//  - forceFlush() before returning, on the request path
//  - inject/extract traceparent ourselves at every Convex boundary
import {
  ROOT_CONTEXT,
  trace,
  type Context,
  type Span,
  SpanStatusCode,
  defaultTextMapGetter,
  defaultTextMapSetter,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

const propagator = new W3CTraceContextPropagator();
let provider: BasicTracerProvider | null = null;

export function tracer() {
  if (!provider) {
    provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        "service.name": "convex-app",
        "cloud.provider": "convex",
        "convex.deployment": process.env.CONVEX_CLOUD_URL ?? "unknown",
      }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: `${process.env.SINK_URL}/v1/traces`,
            headers: { Authorization: `Bearer ${process.env.SINK_TOKEN}` },
          }),
        ),
      ],
    });
  }
  return provider.getTracer("otel-demo-convex");
}

export async function flush(): Promise<number> {
  const t0 = performance.now();
  await provider?.forceFlush();
  return performance.now() - t0;
}

export function extract(traceparent: string | null | undefined): Context {
  if (!traceparent) return ROOT_CONTEXT;
  return propagator.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter);
}

export function inject(ctx: Context): string | undefined {
  const carrier: Record<string, string> = {};
  propagator.inject(ctx, carrier, defaultTextMapSetter);
  return carrier.traceparent;
}

// Run fn inside a child span of `parent`. fn receives the child's Context and
// its traceparent string so it can pass them across Convex boundaries.
export async function withSpan<T>(
  name: string,
  parent: Context,
  opts: { kind?: number; attributes?: Record<string, string | number | boolean> },
  fn: (ctx: Context, traceparent: string | undefined, span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer().startSpan(name, { kind: opts.kind, attributes: opts.attributes }, parent);
  const ctx = trace.setSpan(parent, span);
  try {
    return await fn(ctx, inject(ctx), span);
  } catch (e: any) {
    span.recordException(e);
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(e?.message ?? e) });
    throw e;
  } finally {
    span.end();
  }
}
