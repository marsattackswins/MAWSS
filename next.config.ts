import type { NextConfig } from "next";
import { assertLocalDevBinding } from "./lib/local-dev-binding";

// Local-dev convenience mode is localhost-only. Refuse to boot a login-free
// terminal when the launcher did not bind loopback (0.0.0.0, a LAN address, a
// custom hostname all fail here) instead of silently honoring the marker.
assertLocalDevBinding();

const nextConfig: NextConfig = {
  // Lets the e2e webServer run a second dev instance in its own directory
  // (Next allows one dev server per distDir). Default stays ".next".
  distDir: process.env.MAWS_NEXT_DIST_DIR ?? ".next",
  allowedDevOrigins: ["127.0.0.1"],
  // Native SQLite binding must not be bundled into the server build.
  serverExternalPackages: ["better-sqlite3"],
  output: "standalone",
  logging: {
    incomingRequests: false,
  },
  // Same-origin proxy for the vendored LuxAlgo Trade Journal (vendor/trade-journal,
  // built+started separately with `npm run journal:build` && `npm run journal` on
  // port 3400, basePath "/journal"). Keeping it under the MAWS origin makes it an
  // internal page — same-origin iframe in the JournalOverlay, no cross-port issues.
  async rewrites() {
    const journalUpstream = process.env.MAWS_JOURNAL_UPSTREAM ?? "http://127.0.0.1:3400";
    return [
      { source: "/journal", destination: `${journalUpstream}/journal` },
      { source: "/journal/:path*", destination: `${journalUpstream}/journal/:path*` },
    ];
  },
  // Hide the floating Next.js dev-tools badge (bottom-left, overlaps the
  // chart corner). Dev-only; production builds never show it.
  devIndicators: false,
};

export default nextConfig;
