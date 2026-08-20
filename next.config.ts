import type { NextConfig } from "next";

/**
 * The markets SDK ships ESM with extensionless relative imports, which Node's
 * own resolver rejects — so it must be bundled rather than left external. Every
 * SDK call lives in an API route, so it is bundled into the server output only
 * and never reaches the browser.
 */
const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/@somnia-chain/markets-sdk/**"],
  },
};

export default nextConfig;
