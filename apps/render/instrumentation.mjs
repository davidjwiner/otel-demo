// Standard OpenTelemetry Node SDK setup. Nothing here is Render-specific:
// Render runs a normal Node process, so the stock SDK and auto-instrumentation
// work. Render does not ship a resource detector, so we map its env vars by hand.
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "render-app",
  resource: resourceFromAttributes({
    "cloud.provider": "render",
    "service.instance.id": process.env.RENDER_INSTANCE_ID ?? "local",
    "render.service.id": process.env.RENDER_SERVICE_ID ?? "local",
    "render.service.name": process.env.RENDER_SERVICE_NAME ?? "local",
    "vcs.ref.head.revision": process.env.RENDER_GIT_COMMIT ?? "local",
  }),
  // Reads OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_HEADERS.
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Don't trace the span-forwarding endpoint or static assets.
      "@opentelemetry/instrumentation-http": {
        ignoreIncomingRequestHook: (req) => /^\/(otel\/|app\.js|favicon\.ico)/.test(req.url ?? ""),
      },
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-net": { enabled: false },
    }),
  ],
});
sdk.start();
process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)));
