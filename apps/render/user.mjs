// Dummy "auth": a session cookie names one of a few fake users. In a real app
// this is your session/JWT lookup. Everything here runs on the server.
import { propagation } from "@opentelemetry/api";

export const USERS = [
  { id: "user_1001", email: "ada@example.com" },
  { id: "user_1002", email: "grace@example.com" },
  { id: "user_1003", email: "linus@example.com" },
];
export const COOKIE = "demo_session";

export function userFromCookie(cookieHeader) {
  const m = /(?:^|;\s*)demo_session=([^;]+)/.exec(cookieHeader ?? "");
  return USERS.find((u) => u.id === m?.[1]) ?? null;
}
export const randomUser = () => USERS[Math.floor(Math.random() * USERS.length)];

export function userAttributes(user) {
  return { "user.id": user.id, "user.email": user.email };
}

// Put the user ID in OTel baggage so it follows the context: into child
// spans, and (via propagation.inject) into the job row for the worker.
// Only the ID goes in baggage: the default propagators also send baggage on
// outbound HTTP calls, so anything here leaks to third-party APIs.
export function withUserBaggage(ctx, user) {
  const bag = (propagation.getBaggage(ctx) ?? propagation.createBaggage()).setEntry("user.id", { value: user.id });
  return propagation.setBaggage(ctx, bag);
}

// Stamps user.id (from baggage) and user.email (looked up server-side) on
// every span as it starts.
export class UserSpanProcessor {
  onStart(span, parentContext) {
    const id = propagation.getBaggage(parentContext)?.getEntry("user.id")?.value;
    if (!id) return;
    span.setAttribute("user.id", id);
    const email = USERS.find((u) => u.id === id)?.email;
    if (email) span.setAttribute("user.email", email);
  }
  onEnd() {}
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}
