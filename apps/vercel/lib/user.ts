// Dummy "auth": a session cookie names one of a few fake users. In a real app
// this is your session/JWT lookup. Everything here runs on the server.
import { context, propagation, trace, type Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

export const USERS = [
  { id: "user_1001", email: "ada@example.com" },
  { id: "user_1002", email: "grace@example.com" },
  { id: "user_1003", email: "linus@example.com" },
];
export const COOKIE = "demo_session";
const ANON = { id: "user_anonymous", email: "anonymous@example.com" };

export function userFromCookie(cookieHeader: string | null | undefined) {
  const m = /(?:^|;\s*)demo_session=([^;]+)/.exec(cookieHeader ?? "");
  return USERS.find((u) => u.id === m?.[1]) ?? null;
}

export const userAttributes = (u: { id: string; email: string }) => ({ "user.id": u.id, "user.email": u.email });

// Run a route handler with the user ID in OTel baggage, so every span started
// inside (pg, fetch, after()) gets stamped by UserSpanProcessor. Only the ID
// goes in baggage, in case a propagator sends baggage to third parties.
export function withUser<T>(req: Request, fn: (user: typeof ANON) => Promise<T>): Promise<T> {
  const user = userFromCookie(req.headers.get("cookie")) ?? ANON;
  // Tag the span that's active in the handler ("executing api route").
  trace.getActiveSpan()?.setAttributes(userAttributes(user));
  const bag = (propagation.getBaggage(context.active()) ?? propagation.createBaggage()).setEntry("user.id", { value: user.id });
  return context.with(propagation.setBaggage(context.active(), bag), () => fn(user));
}

// Stamps user.id (from baggage) and user.email (looked up server-side) on
// every span as it starts.
export class UserSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context) {
    const id = propagation.getBaggage(parentContext)?.getEntry("user.id")?.value;
    if (!id) return;
    span.setAttribute("user.id", id);
    const email = [...USERS, ANON].find((u) => u.id === id)?.email;
    if (email) span.setAttribute("user.email", email);
  }
  onEnd(_span: ReadableSpan) {}
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}
