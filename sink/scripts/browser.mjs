// Drive a frontend like a user: load the page, click "Place order", wait for
// the order to settle, then print the resulting trace from the sink.
//   node scripts/browser.mjs <pageUrl> [--wait 20]
// Env: CHROME_PATH (defaults to macOS Chrome), BYPASS_HEADER="name: value"
// for protected deployments.
import puppeteer from "puppeteer-core";
import { printTrace, q } from "./lib.mjs";

const url = process.argv[2];
const args = process.argv.slice(3);
const wait = args.includes("--wait") ? Number(args[args.indexOf("--wait") + 1]) : 20;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage();
if (process.env.BYPASS_HEADER) {
  const i = process.env.BYPASS_HEADER.indexOf(":");
  await page.setExtraHTTPHeaders({ [process.env.BYPASS_HEADER.slice(0, i).trim()]: process.env.BYPASS_HEADER.slice(i + 1).trim() });
}
page.on("console", (m) => m.type() === "error" && console.log("[browser error]", m.text()));

await page.goto(url, { waitUntil: "networkidle0" });
const metaTraceparent = await page.$eval('meta[name="traceparent"]', (m) => m.content).catch(() => null);
console.log(`page loaded; server traceparent meta: ${metaTraceparent ?? "(none)"}`);

await page.click("button");
await page.waitForFunction(() => /status:|error:/.test(document.querySelector("#log")?.textContent ?? ""), { timeout: 30_000 });
const traceId = await page.$eval("#trace-id", (e) => e.textContent);
const log = await page.$$eval("#log li", (lis) => lis.map((l) => l.textContent));
console.log(log.join("\n"));
// Hide the tab so the page flushes buffered spans, then close.
await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
await new Promise((r) => setTimeout(r, 2000));
await browser.close();

console.log(`\nwaiting ${wait}s for exporters and drains...`);
await new Promise((r) => setTimeout(r, wait * 1000));
console.log(`\n=== click trace ${traceId}`);
printTrace(await q("read:trace", { traceId }));
if (metaTraceparent) {
  const pageTrace = metaTraceparent.split("-")[1];
  console.log(`\n=== page-load trace ${pageTrace}`);
  printTrace(await q("read:trace", { traceId: pageTrace }));
}
