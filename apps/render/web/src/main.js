// Browser OpenTelemetry for the Render demo. Plain JS, no framework.
// Spans are posted to /otel/v1/traces on our own server, which forwards them
// to the sink, so no vendor token is exposed to the browser.
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";

const provider = new WebTracerProvider({
  resource: resourceFromAttributes({ "service.name": "render-web", "browser.user_agent": navigator.userAgent }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: "/otel/v1/traces" }), { scheduledDelayMillis: 1000 })],
});
provider.register();
registerInstrumentations({
  instrumentations: [
    // Joins the server's GET / trace through <meta name="traceparent">.
    new DocumentLoadInstrumentation(),
    new FetchInstrumentation({ ignoreUrls: [/\/otel\/v1\/traces/], clearTimingResources: true }),
  ],
});
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") provider.forceFlush();
});

const tracer = trace.getTracer("otel-demo-web");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const add = (line) => $("#log").insertAdjacentHTML("beforeend", `<li>${line}</li>`);

async function placeOrder() {
  $("button").disabled = true;
  $("#log").innerHTML = "";
  await tracer.startActiveSpan(
    "ui: place order",
    { attributes: { "ui.action": "click", "ui.component": "OrderDemo", "order.item": "widget", "demo.platform": "render" } },
    async (root) => {
      const traceId = root.spanContext().traceId;
      $("#trace").innerHTML = `trace <code id="trace-id">${traceId}</code> · <a href="http://localhost:16686/trace/${traceId}" target="_blank">open in local Jaeger</a>`;
      // No async context in the browser: capture the span and re-enter it per fetch.
      const ctx = trace.setSpan(context.active(), root);
      const t0 = performance.now();
      try {
        const res = await context.with(ctx, () =>
          fetch("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ item: "widget", qty: 1 }) }),
        );
        const body = await res.json();
        add(`POST /orders → ${res.status} (order ${body.orderId}) in ${Math.round(performance.now() - t0)}ms`);
        root.setAttribute("order.id", String(body.orderId));
        let status = "pending";
        let polls = 0;
        while (status === "pending" && polls < 30) {
          await sleep(300);
          polls++;
          const r = await context.with(ctx, () => fetch(`/orders/${body.orderId}`, { cache: "no-store" }));
          status = (await r.json()).status;
        }
        add(`status: ${status} after ${polls} poll(s), ${Math.round(performance.now() - t0)}ms total`);
        root.setAttribute("order.final_status", status);
        root.setAttribute("ui.poll_count", polls);
        if (status !== "fulfilled") root.setStatus({ code: SpanStatusCode.ERROR, message: `order ${status}` });
      } catch (e) {
        root.recordException(e);
        root.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
        add(`error: ${e}`);
      } finally {
        root.end();
        $("button").disabled = false;
      }
    },
  );
}
$("button").addEventListener("click", placeOrder);
