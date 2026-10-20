import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // cacheComponents is off: almost every page reads the session cookie; the storefront (Phase 2) can opt in
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
