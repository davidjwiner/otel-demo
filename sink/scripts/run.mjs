// Fire the order scenario at one or more targets, each request carrying a
// client-generated W3C traceparent (as a browser with OTel would send), then
// print the resulting trace from the sink.
//
//   node scripts/run.mjs convex-plain convex-traced vercel render [--n 3] [--wait 20]
import { execFileSync } from "node:child_process";
import { newIds, postSpan, printTrace, q } from "./lib.mjs";

// For Vercel deployments behind Deployment Protection, set VERCEL_SCOPE and
// VERCEL_CWD (a linked project dir) and requests go through `vercel curl`.
async function post(t, url, traceparent, body) {
  if (t === "vercel" && process.env.VERCEL_SCOPE) {
    const out = execFileSync(
      "vercel",
      ["curl", url, "--scope", process.env.VERCEL_SCOPE, "--", "-s", "-w", "\\n%{http_code}", "-X", "POST",
        "-H", "content-type: application/json", "-H", `traceparent: ${traceparent}`, "--data", JSON.stringify(body)],
      { cwd: process.env.VERCEL_CWD, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const i = out.lastIndexOf("\n");
    const text = out.slice(0, i);
    return { status: Number(out.slice(i + 1)), json: async () => JSON.parse(text), text: async () => text };
  }
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", traceparent }, body: JSON.stringify(body) });
}

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
    const res = await post(t, url, `00-${traceId}-${spanId}-01`, { item: "widget", qty: 1 });
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
