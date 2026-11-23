// Usage:
//   node scripts/trace.mjs recent [service]
//   node scripts/trace.mjs <traceId> [--attrs]
//   node scripts/trace.mjs logs <requestId>
import { printTrace, q } from "./lib.mjs";

const [cmd, arg] = process.argv.slice(2);
if (!cmd || cmd === "recent") {
  const rows = await q("read:recentTraces", { limit: 25, service: arg });
  for (const r of rows)
    console.log(
      `${new Date(r.startMs).toISOString()}  ${r.traceId}  ${String(r.spanCount).padStart(3)} spans  ${String(r.rootCount).padStart(2)} roots  ${r.durationMs.toFixed(0).padStart(6)}ms  ${r.root}  [${r.services.join(", ")}]`,
    );
} else if (cmd === "logs") {
  const rows = await q("read:logEvents", { requestId: arg });
  for (const r of rows) console.log(JSON.stringify(JSON.parse(r.event), null, 2));
} else {
  printTrace(await q("read:trace", { traceId: cmd }), { attrs: process.argv.includes("--attrs") });
}
