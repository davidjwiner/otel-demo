// Can OTel's active-context API work in the Convex runtime? The official
// AsyncLocalStorageContextManager imports node:async_hooks, but the runtime
// exposes a global AsyncLocalStorage, so we try a 15-line manager on top of it.
import { context, ROOT_CONTEXT, trace, type Context, type ContextManager } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { action } from "./_generated/server";

class GlobalAlsContextManager implements ContextManager {
  private als = new (globalThis as any).AsyncLocalStorage();
  active(): Context { return this.als.getStore() ?? ROOT_CONTEXT; }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(ctx: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A) {
    return this.als.run(ctx, () => fn.call(thisArg, ...args));
  }
  bind<T>(ctx: Context, target: T): T { return target; }
  enable() { return this; }
  disable() { return this; }
}

async function nestedSpans() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer("probe");
  await tracer.startActiveSpan("outer", async (outer) => {
    await new Promise((r) => setTimeout(r, 5));
    await tracer.startActiveSpan("inner", async (inner) => {
      await fetch("https://kindly-cardinal-2.convex.site/fake-api?ms=1&caller=probe");
      inner.end();
    });
    outer.end();
  });
  const spans = exporter.getFinishedSpans();
  const outer = spans.find((s) => s.name === "outer")!;
  const inner = spans.find((s) => s.name === "inner")!;
  return { innerIsChildOfOuter: inner.parentSpanContext?.spanId === outer.spanContext().spanId };
}

export const withoutContextManager = action({ args: {}, handler: async () => nestedSpans() });

export const withGlobalAlsContextManager = action({
  args: {},
  handler: async () => {
    context.disable();
    context.setGlobalContextManager(new GlobalAlsContextManager());
    try {
      return await nestedSpans();
    } finally {
      context.disable();
    }
  },
});
