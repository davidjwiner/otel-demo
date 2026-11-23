// Browser OpenTelemetry. Next.js runs this file in the browser before the app
// hydrates. Spans go to /otel/v1/traces on our own origin, which next.config
// rewrites to the sink, so no vendor token ships to the browser and no CORS
// setup is needed.
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";

const provider = new WebTracerProvider({
  resource: resourceFromAttributes({
    "service.name": "vercel-web",
    "browser.user_agent": navigator.userAgent,
  }),
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: "/otel/v1/traces" }), { scheduledDelayMillis: 1000 }),
  ],
});
// Default context manager (StackContextManager) + W3C traceparent propagator.
provider.register();

registerInstrumentations({
  instrumentations: [
    // Page load timing. Reads <meta name="traceparent"> (Next.js injects it via
    // experimental.clientTraceMetadata), so the load joins the server render trace.
    new DocumentLoadInstrumentation(),
    // A span per fetch. traceparent goes on same-origin requests automatically.
    new FetchInstrumentation({ ignoreUrls: [/\/otel\/v1\/traces/], clearTimingResources: true }),
  ],
});

// Flush when the tab is hidden so spans aren't lost on navigation.
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void provider.forceFlush();
});
