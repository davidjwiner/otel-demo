// Hard-coded demo user. In a real app you'd set these per request from your
// session/JWT; here every server span gets the same user.
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

export const DEMO_USER = { id: "user_1001", email: "ada@example.com" };

export class DemoUserSpanProcessor implements SpanProcessor {
  onStart(span: Span, _parentContext: Context) {
    span.setAttributes({ "user.id": DEMO_USER.id, "user.email": DEMO_USER.email });
  }
  onEnd(_span: ReadableSpan) {}
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}
