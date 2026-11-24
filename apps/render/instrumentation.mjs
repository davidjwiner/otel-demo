// Standard OpenTelemetry Node SDK setup. Nothing here is Render-specific:
// Render runs a normal Node process, so the stock SDK and auto-instrumentation
// work. Render does not ship a resource detector, so we map its env vars by hand.
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import { DemoUserSpanProcessor } from "./demo-user.mjs";

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "render-app",
  resource: resourceFromAttributes({
    "cloud.provider": "render",
    "service.instance.id": process.env.RENDER_INSTANCE_ID ?? "local",
    "render.service.id": process.env.RENDER_SERVICE_ID ?? "local",
    "render.service.name": process.env.RENDER_SERVICE_NAME ?? "local",
    "vcs.ref.head.revision": process.env.RENDER_GIT_COMMIT ?? "local",
  }),
  spanProcessors: [
    new DemoUserSpanProcessor(),
    // Reads OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_HEADERS.
    new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }),
  ],
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-net": { enabled: false },
    }),
  ],
});
sdk.start();
process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)));
