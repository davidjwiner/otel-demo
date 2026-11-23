import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["pg"],
  experimental: {
    // Inject <meta name="traceparent"> into server-rendered pages so the
    // browser's page-load span joins the server's render trace.
    clientTraceMetadata: ["traceparent", "tracestate"],
  },
  // Browser spans -> sink. The rewrite is proxied by Vercel, so the token in
  // the destination stays server-side and no function runs (no extra spans).
  async rewrites() {
    if (!process.env.SINK_SITE) return [];
    return [
      {
        source: "/otel/v1/traces",
        destination: `${process.env.SINK_SITE}/v1/traces?token=${process.env.SINK_TOKEN ?? ""}`,
      },
    ];
  },
};
export default config;
