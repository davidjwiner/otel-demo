"use client";

import { useState } from "react";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("otel-demo-web");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function OrderDemo({ platform, ordersPath }: { platform: string; ordersPath: string }) {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [traceId, setTraceId] = useState<string | null>(null);
  const add = (line: string) => setLog((l) => [...l, line]);

  async function placeOrder() {
    setBusy(true);
    setLog([]);
    // One span for the whole user-visible operation: click -> order fulfilled.
    await tracer.startActiveSpan(
      "ui: place order",
      { attributes: { "ui.action": "click", "ui.component": "OrderDemo", "order.item": "widget", "demo.platform": platform } },
      async (root) => {
        setTraceId(root.spanContext().traceId);
        // The browser has no async context propagation, so the active span is
        // lost after the first await. Capture it and re-enter it for each fetch.
        const ctx = trace.setSpan(context.active(), root);
        const t0 = performance.now();
        try {
          const res = await context.with(ctx, () =>
            fetch(ordersPath, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ item: "widget", qty: 1 }),
            }),
          );
          const body = await res.json();
          add(`POST ${ordersPath} → ${res.status} (order ${body.orderId}) in ${Math.round(performance.now() - t0)}ms`);
          root.setAttribute("order.id", String(body.orderId));

          // Poll until the background job finishes.
          let status = "pending";
          let polls = 0;
          while (status === "pending" && polls < 30) {
            await sleep(300);
            polls++;
            const r = await context.with(ctx, () => fetch(`${ordersPath}/${body.orderId}`, { cache: "no-store" }));
            status = (await r.json()).status;
          }
          add(`status: ${status} after ${polls} poll(s), ${Math.round(performance.now() - t0)}ms total`);
          root.setAttribute("order.final_status", status);
          root.setAttribute("ui.poll_count", polls);
          if (status !== "fulfilled") root.setStatus({ code: SpanStatusCode.ERROR, message: `order ${status}` });
        } catch (e) {
          root.recordException(e as Error);
          root.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
          add(`error: ${e}`);
        } finally {
          root.end();
          setBusy(false);
        }
      },
    );
  }

  return (
    <section>
      <button onClick={placeOrder} disabled={busy} style={{ fontSize: 16, padding: "8px 16px" }}>
        {busy ? "Working…" : "Place order"}
      </button>
      {traceId && (
        <p>
          trace <code id="trace-id">{traceId}</code> ·{" "}
          <a href={`http://localhost:16686/trace/${traceId}`} target="_blank">open in local Jaeger</a>
        </p>
      )}
      <ul id="log">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </section>
  );
}
