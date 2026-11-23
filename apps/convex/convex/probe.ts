// Probe what the Convex runtime offers for tracing in each function type.
import { action, mutation, query } from "./_generated/server";

function env() {
  const d1 = Date.now();
  const p1 = performance.now();
  // Burn CPU for a bounded number of iterations (performance.now() may be
  // frozen, so we can't loop on it).
  let x = 0;
  for (let i = 0; i < 3_000_000; i++) x += Math.sqrt(i);
  if (x < 0) console.log(x);
  const g = globalThis as any;
  return {
    dateNowMovesDuringFunction: Date.now() !== d1,
    performanceNowMovesDuringFunction: performance.now() !== p1,
    performanceNowDeltaMs: performance.now() - p1,
    performanceNowAtStart: p1,
    performanceTimeOrigin: (performance as any).timeOrigin ?? null,
    hasAsyncLocalStorage: typeof g.AsyncLocalStorage !== "undefined",
    hasAsyncContext: typeof g.AsyncContext !== "undefined",
    hasXMLHttpRequest: typeof g.XMLHttpRequest !== "undefined",
    hasFetch: typeof g.fetch !== "undefined",
    hasNavigatorSendBeacon: typeof g.navigator?.sendBeacon === "function",
  };
}

export const probeQuery = query({ args: {}, handler: async () => env() });
export const probeMutation = mutation({ args: {}, handler: async () => env() });
export const probeAction = action({ args: {}, handler: async () => env() });
