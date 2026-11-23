import { readFileSync } from "node:fs";
import express from "express";
import { context, propagation, trace } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { migrate, pool } from "./db.mjs";
import { runWorker } from "./worker.mjs";

const SINK = process.env.SINK_SITE;
const tracer = trace.getTracer("otel-demo-render");
const app = express();
const indexHtml = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");

// Page: inject the current server span as <meta name="traceparent">.
app.get("/", (_req, res) => {
  const carrier = {};
  propagation.inject(context.active(), carrier);
  res.type("html").send(indexHtml.replace("{{traceparent}}", carrier.traceparent ?? ""));
});
app.use(express.static(new URL("./public", import.meta.url).pathname, { index: false }));

// Browser spans -> sink. Same-origin, so no CORS and no token in the browser.
// Tracing is suppressed so forwarding spans doesn't create more spans.
const sinkUrl = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const sinkHeaders = Object.fromEntries(
  (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "")
    .split(",")
    .filter(Boolean)
    .map((kv) => kv.split("=").map((x) => decodeURIComponent(x.trim()))),
);
app.post("/otel/v1/traces", express.raw({ type: () => true, limit: "5mb" }), (req, res) => {
  context.with(suppressTracing(context.active()), async () => {
    try {
      const r = await fetch(sinkUrl, {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "application/json", ...sinkHeaders },
        body: req.body,
      });
      res.status(r.status).send(await r.text());
    } catch (e) {
      res.status(502).send(String(e));
    }
  });
});

app.use(express.json());

app.get("/orders/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT id, status FROM orders WHERE id = $1", [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).send("not found");
  res.json(rows[0]);
});

app.post("/orders", async (req, res) => {
  const { item = "widget", qty = 1 } = req.body ?? {};
  const inv = await pool.query("SELECT stock FROM inventory WHERE item = $1", [item]);
  if (!inv.rows[0]) return res.status(404).send("unknown item");

  // A named custom span around the transaction, like Zach asked for.
  const orderId = await tracer.startActiveSpan("create order (tx)", async (span) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE inventory SET stock = stock - $1 WHERE item = $2", [qty, item]);
      const { rows } = await client.query("INSERT INTO orders (item, qty, status) VALUES ($1, $2, 'pending') RETURNING id", [item, qty]);
      await client.query("COMMIT");
      span.setAttribute("order.id", rows[0].id);
      return rows[0].id;
    } finally {
      client.release();
      span.end();
    }
  });

  const pay = await fetch(`${SINK}/fake-api?ms=250&caller=render-payment`);

  // Enqueue with trace context in the row.
  const carrier = {};
  propagation.inject(context.active(), carrier);
  await pool.query("INSERT INTO jobs (kind, order_id, traceparent, tracestate) VALUES ('fulfill', $1, $2, $3)", [
    orderId,
    carrier.traceparent ?? null,
    carrier.tracestate ?? null,
  ]);

  res.json({
    orderId,
    payment: pay.status,
    traceId: trace.getActiveSpan()?.spanContext().traceId,
    incomingTraceparent: req.headers.traceparent ?? null,
  });
});

await migrate();
const port = Number(process.env.PORT ?? 10000);
app.listen(port, () => console.log(`listening on ${port}`));
if (process.env.RUN_WORKER !== "0") runWorker();
