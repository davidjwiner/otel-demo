import { OrderDemo } from "./order-demo";

// Rendered per request so each page load gets its own server trace, which the
// browser's document-load span then joins.
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "40px auto", lineHeight: 1.5 }}>
      <h1>otel-demo · Vercel</h1>
      <p>
        Click the button to place an order. The browser starts a trace, the API continues it, the
        background job runs in <code>after()</code>, and the browser polls the order status, all in
        one trace.
      </p>
      <OrderDemo platform="vercel" ordersPath="/api/orders" />
    </main>
  );
}
