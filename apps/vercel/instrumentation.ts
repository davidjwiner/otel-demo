// @vercel/otel: one call wires up the SDK, fetch instrumentation, W3C
// propagation, Vercel resource attributes, and per-request flush via
// waitUntil. "auto" sends spans to Vercel's collector when deployed, which
// feeds the dashboard Traces page and Trace Drains.
import { registerOTel, OTLPHttpJsonTraceExporter } from "@vercel/otel";

export async function register() {
  const processors: any[] = ["auto"];
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
    const { PgInstrumentation } = await import("@opentelemetry/instrumentation-pg");
    const { UserSpanProcessor, userAttributes, userFromCookie } = await import("./lib/user");
    processors.push(new UserSpanProcessor());
    // Optional direct export to our sink, for Hobby teams without Trace Drains.
    if (process.env.SINK_SITE && process.env.DIRECT_EXPORT !== "0") {
      processors.push(
        new BatchSpanProcessor(
          new OTLPHttpJsonTraceExporter({
            url: `${process.env.SINK_SITE}/v1/traces`,
            headers: { authorization: `Bearer ${process.env.SINK_TOKEN}` },
          }),
        ),
      );
    }
    registerOTel({
      serviceName: "vercel-app",
      spanProcessors: processors,
      // Server-side identity on the root span, computed from request headers.
      attributesFromHeaders: (headers, getter) => {
        const raw = getter.get(headers, "cookie");
        const user = userFromCookie(Array.isArray(raw) ? raw.join("; ") : raw);
        return user ? userAttributes(user) : undefined;
      },
      instrumentations: ["fetch", new PgInstrumentation()],
      // Only send traceparent to hosts we own (the default is opt-in).
      instrumentationConfig: { fetch: { propagateContextUrls: [/\.convex\.site/] } },
    });
  } else {
    registerOTel({ serviceName: "vercel-app" });
  }
}
