import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // cacheComponents is off: almost every page reads the session cookie; the storefront (Phase 2) can opt in
  // PGlite loads its wasm from its own folder, which breaks when bundled
  serverExternalPackages: ["@electric-sql/pglite"],
  experimental: {
    // shortcut: Vercel functions accept at most 4.5 MB per request; the device sends ~30 KB (or an 800 px JPEG fallback), so only non-browser uploads hit that cap.
    serverActions: { bodySizeLimit: "10mb" },
  },
  // Phase 8: security headers on every response. No script-src yet: Next's inline scripts would need nonces on every page.
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }, // receipt and order links carry codes; other sites see only the origin
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" }, // the camera scans barcodes
        // checkout.paystack.com: a form posted without JavaScript is redirected there to pay
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self' https://checkout.paystack.com" },
      ],
    }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
