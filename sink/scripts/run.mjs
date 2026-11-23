// Fire the order scenario at one or more targets, each request carrying a
// client-generated W3C traceparent (as a browser with OTel would send), then
// print the resulting trace from the sink.
//
//   node scripts/run.mjs convex-plain convex-traced vercel render [--n 3] [--wait 20]
import { newIds, postSpan, printTrace, q, SINK_SITE } from "./lib.mjs";

const TARGETS = {
  "convex-plain": process.env.CONVEX_APP_SITE && `${process.env.CONVEX_APP_SITE}/orders`,
  "convex-traced": process.env.CONVEX_APP_SITE && `${process.env.CONVEX_APP_SITE}/orders-traced`,
  vercel: process.env.VERCEL_URL && `${process.env.VERCEL_URL}/api/orders`,
  render: process.env.RENDER_URL && `${process.env.RENDER_URL}/orders`,
};

const args = process.argv.slice(2);
const flag = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const n = flag("n", 1);
const wait = flag("wait", 20);
const targets = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

const results = [];
for (const t of targets) {
  const url = TARGETS[t];
  if (!url) {
    console.error(`skip ${t}: set ${t.startsWith("convex") ? "CONVEX_APP_SITE" : t.toUpperCase() + "_URL"}`);
    continue;
  }
  for (let i = 0; i < n; i++) {
    const { traceId, spanId } = newIds();
    const startMs = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", traceparent: `00-${traceId}-${spanId}-01` },
      body: JSON.stringify({ item: "widget", qty: 1 }),
    });
    const endMs = Date.now();
    const body = await res.json().catch(async () => ({ text: await res.text() }));
    await postSpan({
      traceId, spanId, name: `client POST ${new URL(url).pathname} (${t})`, service: "load-client",
      startMs, endMs, kind: 3, attributes: { "http.response.status_code": res.status, target: t },
    });
    results.push({ t, traceId, status: res.status, ms: endMs - startMs, body });
    console.log(`${t.padEnd(14)} ${res.status} ${String(endMs - startMs).padStart(5)}ms trace=${traceId} ${JSON.stringify(body)}`);
  }
}

if (!results.length) process.exit(0);
console.log(`\nwaiting ${wait}s for background jobs, exporters, and log streams...`);
await new Promise((r) => setTimeout(r, wait * 1000));

for (const r of results) {
  console.log(`\n=== ${r.t}  client trace ${r.traceId}`);
  printTrace(await q("read:trace", { traceId: r.traceId }));
  if (r.body?.traceId && r.body.traceId !== r.traceId) {
    console.log(`  server started its own trace ${r.body.traceId}:`);
    printTrace(await q("read:trace", { traceId: r.body.traceId }));
  }
}
