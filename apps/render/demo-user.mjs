// Hard-coded demo user. In a real app you'd set these per request from your
// session/JWT; here every server span gets the same user.
export const DEMO_USER = { id: "user_1001", email: "ada@example.com" };

export class DemoUserSpanProcessor {
  onStart(span) {
    span.setAttributes({ "user.id": DEMO_USER.id, "user.email": DEMO_USER.email });
  }
  onEnd() {}
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
}
