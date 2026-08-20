import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The markets SDK ships ESM with extensionless relative imports, which Node's
   * own resolver rejects — so it must be bundled rather than left external.
   * Every SDK call lives in an API route, so it is bundled into the server
   * output only and never reaches the browser.
   */
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/@somnia-chain/markets-sdk/**"],
  },
  webpack: (config, { webpack }) => {
    // wagmi's Tempo connector optionally imports the `accounts` package inside
    // a try/catch. Turbopack honors the optional marker; webpack does not, so
    // tell it the module is intentionally absent — the connector's own .catch
    // is the designed fallback.
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^accounts$/ }));
    return config;
  },
};

export default nextConfig;
