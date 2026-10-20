import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // cacheComponents is off: almost every page reads the session cookie; the storefront (Phase 2) can opt in
  // PGlite loads its wasm from its own folder, which breaks when bundled
  serverExternalPackages: ["@electric-sql/pglite"],
  experimental: {
    // shortcut: Vercel functions accept at most 4.5 MB per request; the device sends ~30 KB (or an 800 px JPEG fallback), so only non-browser uploads hit that cap.
    serverActions: { bodySizeLimit: "10mb" },
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
